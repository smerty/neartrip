use neartrip::{registry::Registry, serve, Config};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    time::timeout,
};

async fn request(addr: std::net::SocketAddr, head: &str) -> (TcpStream, String) {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(head.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    while !response.ends_with(b"\r\n\r\n") {
        let byte = timeout(Duration::from_secs(2), stream.read_u8())
            .await
            .unwrap()
            .unwrap();
        response.push(byte);
    }
    (stream, String::from_utf8(response).unwrap())
}

#[tokio::test]
async fn direct_sources_authenticate_fan_out_and_disconnect_rovers() {
    let config = Config::parse(r#"{"username":"r","password":"p","sources":[{"mountPoint":"BASE","username":"b","password":"s","settlingSeconds":0}]}"#).unwrap();
    let (_cfg, configs) = watch::channel(config);
    let (stop, shutdown) = watch::channel(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let path = std::env::temp_dir().join(format!("neartrip-caster-{}.json", std::process::id()));
    let registry = Arc::new(Registry::new(&path));
    let task = tokio::spawn(serve(listener, configs, registry, shutdown));
    let (_, response) = request(addr, "SOURCE wrong /BASE\r\n\r\n").await;
    assert!(response.contains("401"));
    let (_, response) = request(
        addr,
        "GET /BASE HTTP/1.0\r\nAuthorization: Basic cjpw\r\n\r\n",
    )
    .await;
    assert!(response.contains("503"));
    let (mut source, response) =
        request(addr, "SOURCE s /BASE\r\nSource-Agent: test\r\n\r\n").await;
    assert!(response.contains("200"));
    let (_, response) = request(
        addr,
        "POST /BASE HTTP/1.1\r\nAuthorization: Basic Yjpz\r\n\r\n",
    )
    .await;
    assert!(response.contains("409"));
    let (_, response) = request(addr, "GET /BASE HTTP/1.0\r\n\r\n").await;
    assert!(response.contains("401"));
    let (mut a, response) = request(
        addr,
        "GET /BASE HTTP/1.0\r\nAuthorization: Basic cjpw\r\n\r\n",
    )
    .await;
    assert!(response.contains("200"));
    let (mut b, _) = request(
        addr,
        "GET /BASE HTTP/1.0\r\nAuthorization: Basic cjpw\r\n\r\n",
    )
    .await;
    source.write_all(b"\xd3\x00\x03abc").await.unwrap();
    for rover in [&mut a, &mut b] {
        let mut data = [0; 6];
        timeout(Duration::from_secs(2), rover.read_exact(&mut data))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&data, b"\xd3\x00\x03abc");
    }
    drop(source);
    assert_eq!(
        timeout(Duration::from_secs(2), a.read_u8())
            .await
            .unwrap()
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::UnexpectedEof
    );
    let (_source, response) = request(
        addr,
        "POST /BASE HTTP/1.1\r\nAuthorization: Basic Yjpz\r\n\r\n",
    )
    .await;
    assert!(response.contains("200"));
    stop.send(true).unwrap();
    task.await.unwrap();
    let _ = std::fs::remove_file(path);
}

async fn payload(stream: &mut TcpStream, expected: &[u8], seconds: u64) {
    timeout(Duration::from_secs(seconds), async {
        let mut seen = Vec::new();
        let mut buf = [0u8; 256];
        loop {
            let n = stream.read(&mut buf).await.unwrap();
            assert!(n > 0, "rover closed before expected payload");
            seen.extend_from_slice(&buf[..n]);
            if seen.windows(expected.len()).any(|w| w == expected) {
                break;
            }
        }
    })
    .await
    .unwrap();
}

async fn emit(
    mut stream: TcpStream,
    bytes: &'static [u8],
    enabled: Arc<std::sync::atomic::AtomicBool>,
) {
    loop {
        if enabled.load(std::sync::atomic::Ordering::Relaxed)
            && stream.write_all(bytes).await.is_err()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn nearest_sources_switch_on_gga_staleness_recovery_and_disable() {
    let config = Config::parse(
        r#"{"mountPoint":"NEAR","sources":[
        {"mountPoint":"A","username":"a","password":"s","settlingSeconds":0,"latitude":37,"longitude":-122},
        {"mountPoint":"B","username":"b","password":"s","settlingSeconds":0,"latitude":38,"longitude":-122}
    ]}"#,
    )
    .unwrap();
    let (cfg, configs) = watch::channel(config.clone());
    let (stop, shutdown) = watch::channel(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let dir = std::env::temp_dir().join(format!("neartrip-nearest-sources-{}", std::process::id()));
    let registry = Arc::new(Registry::new(dir.join("sessions.json")));
    let hub = Arc::new(neartrip::caster::Hub::default());
    let health_path = dir.join("sources.json");
    let health_task = tokio::spawn(hub.clone().snapshots(
        health_path.clone(),
        configs.clone(),
        shutdown.clone(),
    ));
    let task = tokio::spawn(neartrip::server::serve_with_hub(
        listener,
        configs,
        registry,
        shutdown,
        hub.clone(),
    ));
    let (a, _) = request(addr, "SOURCE s /A\r\n\r\n").await;
    let (b, _) = request(addr, "SOURCE s /B\r\n\r\n").await;
    let a_on = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let b_on = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let a_task = tokio::spawn(emit(a, b"AAAA", a_on));
    let b_task = tokio::spawn(emit(b, b"BBBB", b_on.clone()));
    let (mut rover, _) = request(addr, "GET /NEAR HTTP/1.0\r\n\r\n").await;
    let gga =
        neartrip::nmea::with_checksum("$GPGGA,123519,3700.0000,N,12200.0000,W,1,12,1.0,0,M,0,M,,");
    rover
        .write_all(format!("{gga}\r\n").as_bytes())
        .await
        .unwrap();
    payload(&mut rover, b"AAAA", 3).await;
    let gga =
        neartrip::nmea::with_checksum("$GPGGA,123519,3800.0000,N,12200.0000,W,1,12,1.0,0,M,0,M,,");
    rover
        .write_all(format!("{gga}\r\n").as_bytes())
        .await
        .unwrap();
    payload(&mut rover, b"BBBB", 3).await;
    timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(text) = std::fs::read_to_string(&health_path) {
                let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                if value["sources"][1]["status"] == "healthy" {
                    assert!(value["updatedAt"].is_u64());
                    assert!(value["sources"][1]["bytesReceived"].as_u64().unwrap() > 0);
                    assert!(!text.contains("password"));
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    b_on.store(false, std::sync::atomic::Ordering::Relaxed);
    // No new rover GGA: health alone must remove the stale base and reselect A.
    payload(&mut rover, b"AAAA", 13).await;
    assert!(!hub.healthy("B"));
    b_on.store(true, std::sync::atomic::Ordering::Relaxed);
    payload(&mut rover, b"BBBB", 3).await;
    let (mut fixed, _) = request(addr, "GET /B HTTP/1.0\r\n\r\n").await;
    let mut disabled = config;
    disabled.sources[1].active = false;
    cfg.send(disabled).unwrap();
    payload(&mut rover, b"AAAA", 3).await;
    timeout(Duration::from_secs(2), async {
        let mut buf = [0; 256];
        while fixed.read(&mut buf).await.unwrap_or(0) > 0 {}
    })
    .await
    .unwrap();
    assert!(!hub.healthy("B"));
    let (_, response) = request(addr, "SOURCE s /B\r\n\r\n").await;
    assert!(response.contains("401"));
    a_task.abort();
    b_task.abort();
    stop.send(true).unwrap();
    task.await.unwrap();
    health_task.await.unwrap();
    assert!(!health_path.exists());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn direct_source_failure_falls_back_to_upstream_station() {
    let remote = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = remote.local_addr().unwrap().port();
    let config = Config::parse(&format!(r#"{{"mountPoint":"NEAR","stations":[
        {{"mountPoint":"REMOTE","casterHost":"127.0.0.1","casterPort":{port},"latitude":38,"longitude":-122}}
    ],"sources":[{{"mountPoint":"BASE","username":"b","password":"s","settlingSeconds":0,"latitude":37,"longitude":-122}}]}}"#)).unwrap();
    let (_cfg, configs) = watch::channel(config);
    let (stop, shutdown) = watch::channel(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let dir = std::env::temp_dir().join(format!("neartrip-source-fallback-{}", std::process::id()));
    let task = tokio::spawn(serve(
        listener,
        configs,
        Arc::new(Registry::new(dir.join("sessions.json"))),
        shutdown,
    ));
    let (base, _) = request(addr, "SOURCE s /BASE\r\n\r\n").await;
    let base_task = tokio::spawn(emit(
        base,
        b"BASE",
        Arc::new(std::sync::atomic::AtomicBool::new(true)),
    ));
    let (mut rover, _) = request(addr, "GET /NEAR HTTP/1.0\r\n\r\n").await;
    let gga =
        neartrip::nmea::with_checksum("$GPGGA,123519,3700.0000,N,12200.0000,W,1,12,1.0,0,M,0,M,,");
    rover
        .write_all(format!("{gga}\r\n").as_bytes())
        .await
        .unwrap();
    payload(&mut rover, b"BASE", 3).await;
    base_task.abort();
    let remote_task = tokio::spawn(async move {
        let (mut socket, _) = remote.accept().await.unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            head.push(socket.read_u8().await.unwrap());
        }
        socket.write_all(b"ICY 200 OK\r\n\r\n").await.unwrap();
        let mut gga = Vec::new();
        while !gga.ends_with(b"\n") {
            gga.push(socket.read_u8().await.unwrap());
        }
        socket.write_all(b"REMOTE-DATA").await.unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
    });
    payload(&mut rover, b"REMOTE-DATA", 3).await;
    stop.send(true).unwrap();
    task.await.unwrap();
    remote_task.abort();
    let _ = std::fs::remove_dir_all(dir);
}

// Fixed 1006 payload at latitude 0, longitude 90, ARP ellipsoidal height 100 m.
// Construct independently of the production decoder's bit extraction.
fn automatic_position_frame() -> Vec<u8> {
    position_frame_at_height(100.0)
}

fn position_frame_at_height(height: f64) -> Vec<u8> {
    let mut bits = format!("{:012b}{:012b}{:06b}{:04b}", 1006, 42, 0, 0);
    bits.push_str(&format!(
        "{:038b}{:02b}{:038b}{:02b}{:038b}{:016b}",
        0,
        0,
        ((6_378_137.0 + height) * 10000.0).round() as u64,
        0,
        0,
        12345
    ));
    let payload: Vec<u8> = bits
        .as_bytes()
        .chunks(8)
        .map(|byte| byte.iter().fold(0, |acc, b| (acc << 1) | (b - b'0')))
        .collect();
    assert_eq!(payload.len(), 21);
    let mut frame = vec![0xd3, 0, 21];
    frame.extend(payload);
    let crc = neartrip::rtcm::crc24q(&frame);
    frame.extend_from_slice(&crc.to_be_bytes()[1..]);
    frame
}

#[tokio::test]
async fn learns_position_for_nearest_and_sourcetable_without_changing_stream_bytes() {
    let config = Config::parse(
        r#"{"mountPoint":"NEAR","sources":[
        {"mountPoint":"AUTO","username":"a","password":"s","settlingSeconds":0}
    ]}"#,
    )
    .unwrap();
    let (_cfg, configs) = watch::channel(config);
    let (stop, shutdown) = watch::channel(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let dir = std::env::temp_dir().join(format!("neartrip-auto-position-{}", std::process::id()));
    let hub = Arc::new(neartrip::caster::Hub::default());
    let task = tokio::spawn(neartrip::server::serve_with_hub(
        listener,
        configs.clone(),
        Arc::new(Registry::new(dir.join("sessions.json"))),
        shutdown,
        hub.clone(),
    ));
    let (mut source, _) = request(addr, "SOURCE s /AUTO\r\n\r\n").await;
    let (mut fixed, _) = request(addr, "GET /AUTO HTTP/1.0\r\n\r\n").await;
    let frame = automatic_position_frame();
    let mut corrupt = frame.clone();
    corrupt[12] ^= 1;
    source.write_all(&corrupt).await.unwrap();
    let mut received = vec![0; corrupt.len()];
    timeout(Duration::from_secs(2), fixed.read_exact(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received, corrupt);
    assert!(hub.position("AUTO").is_none());
    assert!(hub.stations(&configs.borrow()).is_empty());

    // The rover is already connected before the base's position is known.
    let (mut nearest, _) = request(addr, "GET /NEAR HTTP/1.0\r\n\r\n").await;
    let gga =
        neartrip::nmea::with_checksum("$GPGGA,123519,0000.0000,N,09000.0000,E,1,12,1.0,0,M,0,M,,");
    nearest
        .write_all(format!("{gga}\r\n").as_bytes())
        .await
        .unwrap();
    source.write_all(&frame[..9]).await.unwrap();
    source.write_all(&frame[9..]).await.unwrap();
    let mut received = vec![0; frame.len()];
    timeout(Duration::from_secs(2), fixed.read_exact(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received, frame);
    let position = hub.position("AUTO").unwrap();
    assert!((position.longitude - 90.0).abs() < 1e-9);
    assert!((position.ellipsoidal_height_m - 100.0).abs() < 0.0001);
    assert!((position.antenna_height_m.unwrap() - 1.2345).abs() < 1e-9);
    let emitter = tokio::spawn(emit(
        source,
        b"AUTO-DATA",
        Arc::new(std::sync::atomic::AtomicBool::new(true)),
    ));
    payload(&mut nearest, b"AUTO-DATA", 3).await;
    let (mut table, response) = request(addr, "GET / HTTP/1.0\r\n\r\n").await;
    assert!(response.contains("200"));
    let mut body = String::new();
    timeout(Duration::from_secs(2), table.read_to_string(&mut body))
        .await
        .unwrap()
        .unwrap();
    assert!(body.contains(";0.0000;90.0000;0;"), "{body}");

    // A reconnect must not reuse a previous publisher's detected coordinates.
    emitter.abort();
    timeout(Duration::from_secs(2), async {
        while hub.healthy("AUTO") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let (_new_source, response) = request(addr, "SOURCE s /AUTO\r\n\r\n").await;
    assert!(response.contains("200"));
    assert!(hub.position("AUTO").is_none());
    stop.send(true).unwrap();
    task.await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

async fn expect_live_payload(rover: &mut TcpStream, source: &mut TcpStream, expected: &[u8]) {
    timeout(Duration::from_secs(3), async {
        let mut seen = Vec::new();
        let mut buf = [0; 512];
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! {
                _ = tick.tick() => source.write_all(expected).await.unwrap(),
                n = rover.read(&mut buf) => {
                    let n = n.unwrap();
                    assert!(n > 0);
                    seen.extend_from_slice(&buf[..n]);
                    if seen.windows(expected.len()).any(|w| w == expected) { return; }
                }
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn onboarding_holds_nearest_until_confirmed_and_requalifies_after_movement() {
    let config = Config::parse(r#"{"mountPoint":"NEAR","sources":[
        {"mountPoint":"FALLBACK","username":"f","password":"s","settlingSeconds":0,"latitude":0,"longitude":89.9},
        {"mountPoint":"AUTO","username":"a","password":"s","settlingSeconds":2,"positionToleranceM":5}
    ]}"#).unwrap();
    let (_cfg, configs) = watch::channel(config.clone());
    let (stop, shutdown) = watch::channel(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let dir = std::env::temp_dir().join(format!("neartrip-onboarding-{}", std::process::id()));
    let hub = Arc::new(neartrip::caster::Hub::default());
    let task = tokio::spawn(neartrip::server::serve_with_hub(
        listener,
        configs,
        Arc::new(Registry::new(dir.join("sessions.json"))),
        shutdown,
        hub.clone(),
    ));
    let (fallback, _) = request(addr, "SOURCE s /FALLBACK\r\n\r\n").await;
    let fallback_task = tokio::spawn(emit(
        fallback,
        b"FALLBACK",
        Arc::new(std::sync::atomic::AtomicBool::new(true)),
    ));
    let (mut source, _) = request(addr, "SOURCE s /AUTO\r\n\r\n").await;
    source.write_all(&automatic_position_frame()).await.unwrap();
    let (mut fixed, _) = request(addr, "GET /AUTO HTTP/1.0\r\n\r\n").await;
    // Fixed clients remain usable for diagnostics throughout onboarding.
    source.write_all(b"FIXED").await.unwrap();
    payload(&mut fixed, b"FIXED", 2).await;
    let (mut nearest, _) = request(addr, "GET /NEAR HTTP/1.0\r\n\r\n").await;
    let gga =
        neartrip::nmea::with_checksum("$GPGGA,123519,0000.0000,N,09000.0000,E,1,12,1.0,0,M,0,M,,");
    nearest
        .write_all(format!("{gga}\r\n").as_bytes())
        .await
        .unwrap();
    payload(&mut nearest, b"FALLBACK", 2).await;
    assert!(!hub.ready(&config.sources[1]));
    tokio::time::sleep(Duration::from_millis(2100)).await;
    assert!(
        !hub.ready(&config.sources[1]),
        "one position report must not establish stability"
    );
    let snapshot = serde_json::to_value(hub.health(&config)).unwrap();
    assert_eq!(snapshot[1]["onboarding"]["status"], "needs_attention");
    source.write_all(&automatic_position_frame()).await.unwrap();
    expect_live_payload(&mut nearest, &mut source, b"AUTO-READY").await;
    assert!(hub.ready(&config.sources[1]));
    source
        .write_all(&position_frame_at_height(110.0))
        .await
        .unwrap();
    payload(&mut nearest, b"FALLBACK", 3).await;
    assert!(
        !hub.ready(&config.sources[1]),
        "height movement must revoke admission"
    );
    tokio::time::sleep(Duration::from_millis(2100)).await;
    source
        .write_all(&position_frame_at_height(110.0))
        .await
        .unwrap();
    expect_live_payload(&mut nearest, &mut source, b"AUTO-RECOVERED").await;
    assert!(hub.ready(&config.sources[1]));
    fallback_task.abort();
    stop.send(true).unwrap();
    task.await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn length_framed_post_stops_at_body_boundary_and_releases_mountpoint() {
    let config =
        Config::parse(r#"{"sources":[{"mountPoint":"BASE","username":"b","password":"s"}]}"#)
            .unwrap();
    let (_cfg, configs) = watch::channel(config.clone());
    let (stop, shutdown) = watch::channel(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let dir = std::env::temp_dir().join(format!("neartrip-post-boundary-{}", std::process::id()));
    let hub = Arc::new(neartrip::caster::Hub::default());
    let task = tokio::spawn(neartrip::server::serve_with_hub(
        listener,
        configs,
        Arc::new(Registry::new(dir.join("sessions.json"))),
        shutdown,
        hub.clone(),
    ));
    let (mut source, response) = request(
        addr,
        "POST /BASE HTTP/1.1\r\nAuthorization: Basic Yjpz\r\nContent-Length: 6\r\n\r\n",
    )
    .await;
    assert!(response.contains("200"));
    let (mut rover, _) = request(addr, "GET /BASE HTTP/1.0\r\n\r\n").await;
    source.write_all(b"AB").await.unwrap();
    let mut prefix = [0; 2];
    timeout(Duration::from_secs(2), rover.read_exact(&mut prefix))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&prefix, b"AB");
    source
        .write_all(b"CDEFGET / HTTP/1.1\r\n\r\n")
        .await
        .unwrap();
    // Publisher stays open; the declared body end alone must close subscribers.
    let mut remaining = Vec::new();
    timeout(Duration::from_secs(2), rover.read_to_end(&mut remaining))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        remaining, b"CDEF",
        "trailing request bytes must not reach rovers"
    );
    let health = serde_json::to_value(hub.health(&config)).unwrap();
    assert_eq!(health[0]["status"], "offline");
    assert_eq!(health[0]["bytesReceived"], 6);

    // Body bytes coalesced with headers must obey the same limit.
    for (length, body) in [
        (3, "ABCGET / HTTP/1.1\r\n\r\n"),
        (0, "GET / HTTP/1.1\r\n\r\n"),
    ] {
        let (_source, response) = request(addr, &format!(
            "POST /BASE HTTP/1.1\r\nAuthorization: Basic Yjpz\r\nContent-Length: {length}\r\n\r\n{body}"
        )).await;
        assert!(response.contains("200"));
        timeout(Duration::from_secs(2), async {
            loop {
                let health = serde_json::to_value(hub.health(&config)).unwrap();
                if health[0]["status"] == "offline" {
                    assert_eq!(health[0]["bytesReceived"], length);
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    for header in [
        "Content-Length: -1",
        "Content-Length: 3\r\nContent-Length: 4",
    ] {
        let (_, response) = request(
            addr,
            &format!("POST /BASE HTTP/1.1\r\nAuthorization: Basic Yjpz\r\n{header}\r\n\r\n"),
        )
        .await;
        assert!(response.contains("400"));
        assert!(hub.subscribe("BASE").is_none());
    }

    let (mut source, response) = request(
        addr,
        "POST /BASE HTTP/1.1\r\nAuthorization: Basic Yjpz\r\nContent-Length: 6\r\n\r\n",
    )
    .await;
    assert!(
        response.contains("200"),
        "completed uploads must release the mountpoint"
    );
    let (mut rover, _) = request(addr, "GET /BASE HTTP/1.0\r\n\r\n").await;
    source.write_all(b"AB").await.unwrap();
    source.shutdown().await.unwrap();
    let mut body = Vec::new();
    timeout(Duration::from_secs(2), rover.read_to_end(&mut body))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(body, b"AB");
    let health = serde_json::to_value(hub.health(&config)).unwrap();
    assert!(health[0]["lastError"]
        .as_str()
        .unwrap()
        .contains("before Content-Length"));
    stop.send(true).unwrap();
    task.await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
