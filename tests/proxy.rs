//! The rover session: auth, split NMEA, one caster, GGA forwarded, station switch.
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use neartrip::config::Config;
use neartrip::nmea::with_checksum;
use neartrip::registry::Registry;
use neartrip::serve;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::time::timeout;

#[tokio::test]
async fn sourcetable_lists_the_virtual_mount() {
    let proxy = start_proxy(9, 9).await;
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    client.write_all(b"GET / HTTP/1.0\r\n\r\n").await.unwrap();
    let body = read_to_string(&mut client).await;
    assert!(body.contains("SOURCETABLE 200 OK"), "{body}");
    assert!(body.contains("STR;NEAR;"), "{body}");
    assert!(body.contains("ENDSOURCETABLE"), "{body}");
    proxy.stop();
}

#[tokio::test]
async fn mountpoint_requires_the_configured_password() {
    let caster = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = caster.local_addr().unwrap().port();
    let proxy = start_proxy(port, port).await;
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    let token = base64::engine::general_purpose::STANDARD.encode("rover:nope");
    let request = format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n");
    client.write_all(request.as_bytes()).await.unwrap();
    let body = read_to_string(&mut client).await;
    assert!(body.contains("401"), "{body}");
    let accepted = timeout(Duration::from_millis(200), caster.accept()).await;
    assert!(
        accepted.is_err(),
        "a rejected rover must not dial the caster"
    );
    proxy.stop();
}

#[tokio::test]
async fn split_gngga_is_forwarded_and_a_farther_fix_switches_caster() {
    let caster_a = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let caster_b = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port_a = caster_a.local_addr().unwrap().port();
    let port_b = caster_b.local_addr().unwrap().port();
    let seen_a = Arc::new(Mutex::new(Vec::new()));
    let seen_b = Arc::new(Mutex::new(Vec::new()));
    spawn_caster(caster_a, b"AAAA", Arc::clone(&seen_a));
    spawn_caster(caster_b, b"BBBB", Arc::clone(&seen_b));

    let proxy = start_proxy(port_a, port_b).await;
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    let token = base64::engine::general_purpose::STANDARD.encode("rover:secret");
    let request =
        format!("GET /NEAR HTTP/1.0\r\nUser-Agent: test\r\nAuthorization: Basic {token}\r\n\r\n");
    client.write_all(request.as_bytes()).await.unwrap();
    let banner = read_until(&mut client, b"ICY 200 OK").await;
    assert!(banner.windows(4).any(|w| w == b"\r\n\r\n") || banner.ends_with(b"ICY 200 OK"));

    client.set_nodelay(true).unwrap();
    let near = format!("{}\r\n", gga(37.0, -122.0));
    let mid = near.len() / 2;
    client.write_all(near[..mid].as_bytes()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    client.write_all(near[mid..].as_bytes()).await.unwrap();
    let first = read_until(&mut client, b"AAAA").await;
    assert!(first.windows(4).any(|w| w == b"AAAA"));
    let forwarded = {
        let seen = seen_a.lock().unwrap();
        String::from_utf8_lossy(&seen).into_owned()
    };
    assert!(forwarded.contains("GNGGA"), "{forwarded}");

    client
        .write_all(b"$GPGSA,A,3,,,,,,,,,,,,,1.0,1.0,1.0*33\r\n")
        .await
        .unwrap();
    let far = format!("{}\r\n", gga(37.9, -122.0));
    client.write_all(far.as_bytes()).await.unwrap();
    let second = read_until(&mut client, b"BBBB").await;
    assert!(second.windows(4).any(|w| w == b"BBBB"));
    let forwarded_b = {
        let seen = seen_b.lock().unwrap();
        String::from_utf8_lossy(&seen).into_owned()
    };
    assert!(forwarded_b.contains("GNGGA"), "{forwarded_b}");
    proxy.stop();
}

#[tokio::test]
async fn correction_bursts_larger_than_the_read_buffer_are_preserved() {
    static PAYLOAD: [u8; 128 * 1024] = [0xD3; 128 * 1024];
    let caster = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = caster.local_addr().unwrap().port();
    spawn_caster(caster, &PAYLOAD, Arc::new(Mutex::new(Vec::new())));
    let proxy = start_proxy(port, port).await;
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    let token = base64::engine::general_purpose::STANDARD.encode("rover:secret");
    let request = format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n");
    client.write_all(request.as_bytes()).await.unwrap();
    read_until(&mut client, b"\r\n\r\n").await;
    client
        .write_all(format!("{}\r\n", gga(37.0, -122.0)).as_bytes())
        .await
        .unwrap();
    let mut received = vec![0; PAYLOAD.len()];
    timeout(Duration::from_secs(3), client.read_exact(&mut received))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(received, PAYLOAD);
    proxy.stop();
}

async fn wait_session(
    proxy: &Proxy,
    predicate: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    timeout(Duration::from_secs(3), async {
        loop {
            proxy.registry.flush();
            let records: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&proxy.path).unwrap()).unwrap();
            if let Some(record) = records
                .as_array()
                .unwrap()
                .iter()
                .find(|record| predicate(record))
            {
                return record.clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("session state did not appear")
}

#[tokio::test]
async fn accepted_socket_waiting_for_gga_times_out_with_a_reason() {
    let proxy = start_proxy(9, 9).await;
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    wait_session(&proxy, |r| {
        r["status"] == "tcp_connected" && r["active"] == true
    })
    .await;
    let token = base64::engine::general_purpose::STANDARD.encode("rover:secret");
    client
        .write_all(format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    read_until(&mut client, b"\r\n\r\n").await;
    wait_session(&proxy, |r| {
        r["status"] == "awaiting_gga" && r["authenticated"] == true
    })
    .await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(121)).await;
    tokio::time::resume();
    let ended = wait_session(&proxy, |r| r["active"] == false).await;
    assert_eq!(ended["disconnectReason"], "client idle timeout");
    assert_eq!(ended["readIdleTimeoutSecs"], 120);
    assert_eq!(ended["bytesSent"], 0);
    proxy.stop();
}

#[tokio::test]
async fn streaming_rover_keeps_live_counts_and_shutdown_is_recorded() {
    let caster = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = caster.local_addr().unwrap().port();
    spawn_caster(caster, b"RTCM", Arc::new(Mutex::new(Vec::new())));
    let proxy = start_proxy(port, port).await;
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    let token = base64::engine::general_purpose::STANDARD.encode("rover:secret");
    let request = format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n");
    client.write_all(request.as_bytes()).await.unwrap();
    read_until(&mut client, b"\r\n\r\n").await;
    let sentence = format!("{}\r\n", gga(37.0, -122.0));
    client.write_all(sentence.as_bytes()).await.unwrap();
    read_until(&mut client, b"RTCM").await;
    let live = wait_session(&proxy, |r| r["status"] == "streaming").await;
    assert_eq!(live["active"], true);
    assert_eq!(live["bytesSent"], 4);
    assert_eq!(live["bytesReceived"], request.len() + sentence.len());
    assert_eq!(live["currentStation"], "A");
    assert_eq!(live["upstreamStatus"], "connected");
    assert!(live["lastGgaAt"].is_string());
    proxy.shutdown.send(true).unwrap();
    let ended = wait_session(&proxy, |r| r["active"] == false).await;
    assert_eq!(ended["disconnectReason"], "core shutdown");
    assert_eq!(ended["bytesSent"], 4);
}

struct Proxy {
    addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    configs: watch::Sender<Config>,
    registry: Arc<Registry>,
    path: std::path::PathBuf,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        let _ = std::fs::remove_dir_all(self.path.parent().unwrap());
    }
}

impl Proxy {
    fn stop(self) {
        let _ = self.shutdown.send(true);
    }
}

async fn start_proxy(port_a: u16, port_b: u16) -> Proxy {
    let raw = format!(
        r#"{{
            "username": "rover",
            "password": "secret",
            "mountPoint": "NEAR",
            "userAgent": "NearTRIP-test",
            "stations": [
                {{
                    "mountPoint": "A",
                    "casterHost": "127.0.0.1",
                    "casterPort": {port_a},
                    "latitude": 37.0,
                    "longitude": -122.0
                }},
                {{
                    "mountPoint": "B",
                    "casterHost": "127.0.0.1",
                    "casterPort": {port_b},
                    "latitude": 38.0,
                    "longitude": -122.0
                }}
            ]
        }}"#
    );
    let config = Config::parse(&raw).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (config_tx, config_rx) = watch::channel(config);
    let (shutdown, shutdown_rx) = watch::channel(false);
    static INSTANCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "neartrip-proxy-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        INSTANCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    ));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("sessions.json");
    let registry = Arc::new(Registry::new(&path));
    let serve_registry = registry.clone();
    tokio::spawn(async move {
        serve(listener, config_rx, serve_registry, shutdown_rx).await;
    });
    Proxy {
        configs: config_tx,
        addr,
        shutdown,
        registry,
        path,
    }
}

fn spawn_caster(listener: TcpListener, payload: &'static [u8], seen: Arc<Mutex<Vec<u8>>>) {
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let seen = Arc::clone(&seen);
            tokio::spawn(async move {
                let mut buf = vec![0; 2048];
                let mut acc = Vec::new();
                loop {
                    let Ok(Ok(n)) = timeout(Duration::from_secs(2), socket.read(&mut buf)).await
                    else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    acc.extend_from_slice(&buf[..n]);
                    if acc.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                if socket.write_all(b"ICY 200 OK\r\n\r\n").await.is_err() {
                    return;
                }
                let mut gga = Vec::new();
                loop {
                    let Ok(Ok(n)) = timeout(Duration::from_secs(2), socket.read(&mut buf)).await
                    else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    gga.extend_from_slice(&buf[..n]);
                    if gga.contains(&b'\n') {
                        break;
                    }
                }
                seen.lock().unwrap().extend_from_slice(&gga);
                let _ = socket.write_all(payload).await;
                let _ = timeout(Duration::from_secs(3), socket.read(&mut buf)).await;
            });
        }
    });
}

async fn read_until(socket: &mut TcpStream, needle: &[u8]) -> Vec<u8> {
    let mut acc = Vec::new();
    let mut buf = [0u8; 1024];
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while acc.windows(needle.len()).all(|window| window != needle) {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for {needle:?} in {acc:?}"
        );
        let n = timeout(Duration::from_secs(3), socket.read(&mut buf))
            .await
            .expect("read timed out")
            .expect("read failed");
        assert!(n > 0, "socket closed while waiting for {needle:?}");
        acc.extend_from_slice(&buf[..n]);
    }
    acc
}

async fn read_to_string(socket: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    loop {
        let n = timeout(Duration::from_secs(2), socket.read(&mut tmp))
            .await
            .expect("read timed out")
            .expect("read failed");
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn gga(lat: f64, lon: f64) -> String {
    let ns = if lat >= 0.0 { 'N' } else { 'S' };
    let ew = if lon >= 0.0 { 'E' } else { 'W' };
    let body = format!(
        "$GNGGA,120000,{},{ns},{},{ew},1,08,1.0,10.0,M,0.0,M,,",
        nmea_coord(lat.abs(), 2),
        nmea_coord(lon.abs(), 3),
    );
    with_checksum(&body)
}

fn nmea_coord(degrees: f64, degree_digits: usize) -> String {
    let whole = degrees.floor();
    let minutes = (degrees - whole) * 60.0;
    format!("{whole:0degree_digits$.0}{minutes:07.4}")
}

#[tokio::test]
async fn long_lived_rover_stays_visible_and_corrections_do_not_reset_its_idle_timer() {
    let caster = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = caster.local_addr().unwrap().port();
    let (send, mut receive) = tokio::sync::mpsc::channel::<()>(4);
    tokio::spawn(async move {
        let (mut socket, _) = caster.accept().await.unwrap();
        read_until(&mut socket, b"\r\n\r\n").await;
        socket.write_all(b"ICY 200 OK\r\n\r\n").await.unwrap();
        let (mut read, mut write) = socket.into_split();
        tokio::spawn(async move {
            let mut buf = [0; 1024];
            while matches!(read.read(&mut buf).await, Ok(n) if n > 0) {}
        });
        while receive.recv().await.is_some() {
            if write.write_all(b"DATA").await.is_err() {
                break;
            }
        }
    });
    let proxy = start_proxy(port, port).await;
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    let token = base64::engine::general_purpose::STANDARD.encode("rover:secret");
    let request = format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n");
    client.write_all(request.as_bytes()).await.unwrap();
    read_until(&mut client, b"\r\n\r\n").await;
    let sentence = format!("{}\r\n", gga(37.0, -122.0));
    client.write_all(sentence.as_bytes()).await.unwrap();
    wait_session(&proxy, |r| r["upstreamStatus"] == "connected").await;
    for i in 1..=3 {
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::time::resume();
        client.write_all(sentence.as_bytes()).await.unwrap();
        send.send(()).await.unwrap();
        read_until(&mut client, b"DATA").await;
        let state = wait_session(&proxy, |r| {
            r["bytesSent"] == i * 4
                && r["bytesReceived"] == request.len() + (i as usize + 1) * sentence.len()
        })
        .await;
        assert_eq!(state["active"], true);
        assert_eq!(state["status"], "streaming");
    }
    // Correction traffic keeps the upstream alive, but must not indefinitely
    // postpone the rover's requirement to send another position.
    for _ in 0..2 {
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(50)).await;
        tokio::time::resume();
        send.send(()).await.unwrap();
        read_until(&mut client, b"DATA").await;
    }
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(21)).await;
    tokio::time::resume();
    let ended = wait_session(&proxy, |r| r["active"] == false).await;
    assert_eq!(ended["disconnectReason"], "client idle timeout");
    assert_eq!(ended["bytesSent"], 20);
    proxy.stop();
}

#[tokio::test]
async fn upstream_failure_is_visible_while_rover_remains_connected() {
    let caster = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = caster.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut socket, _) = caster.accept().await.unwrap();
        read_until(&mut socket, b"\r\n\r\n").await;
        socket
            .write_all(b"HTTP/1.0 401 Unauthorized\r\n\r\n")
            .await
            .unwrap();
    });
    let proxy = start_proxy(port, port).await;
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    let token = base64::engine::general_purpose::STANDARD.encode("rover:secret");
    client
        .write_all(
            format!(
                "GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n{}\r\n",
                gga(37.0, -122.0)
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    read_until(&mut client, b"\r\n\r\n").await;
    let state = wait_session(&proxy, |r| r["upstreamStatus"] == "error").await;
    assert_eq!(state["active"], true);
    assert_eq!(state["status"], "awaiting_upstream");
    assert_eq!(state["lastUpstreamError"], "caster rejected the mountpoint");
    assert_eq!(state["bytesSent"], 0);
    drop(client);
    let ended = wait_session(&proxy, |r| r["active"] == false).await;
    assert_eq!(ended["disconnectReason"], "client closed");
    proxy.stop();
}

#[tokio::test]
async fn failed_switch_preserves_streaming_until_the_upstream_is_replaced_or_dropped() {
    let caster_a = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let caster_b = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port_a = caster_a.local_addr().unwrap().port();
    let port_b = caster_b.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut socket, _) = caster_a.accept().await.unwrap();
        read_until(&mut socket, b"\r\n\r\n").await;
        socket.write_all(b"ICY 200 OK\r\n\r\nAAAA").await.unwrap();
        let mut buf = [0; 1024];
        while matches!(socket.read(&mut buf).await, Ok(n) if n > 0) {}
    });
    let (attempted, attempt) = tokio::sync::oneshot::channel();
    let (reject, rejected) = tokio::sync::oneshot::channel();
    let (close, closed) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = caster_b.accept().await.unwrap();
        read_until(&mut socket, b"\r\n\r\n").await;
        attempted.send(()).unwrap();
        rejected.await.unwrap();
        socket
            .write_all(b"HTTP/1.0 401 Unauthorized\r\n\r\n")
            .await
            .unwrap();
        drop(socket);
        let (mut socket, _) = caster_b.accept().await.unwrap();
        read_until(&mut socket, b"\r\n\r\n").await;
        socket.write_all(b"ICY 200 OK\r\n\r\n").await.unwrap();
        read_until(&mut socket, b"\r\n").await;
        let _ = closed.await;
    });
    let proxy = start_proxy(port_a, port_b).await;
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    let token = base64::engine::general_purpose::STANDARD.encode("rover:secret");
    client
        .write_all(format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    read_until(&mut client, b"\r\n\r\n").await;
    client
        .write_all(format!("{}\r\n", gga(37.0, -122.0)).as_bytes())
        .await
        .unwrap();
    read_until(&mut client, b"AAAA").await;
    wait_session(&proxy, |r| r["status"] == "streaming").await;

    let far = format!("{}\r\n", gga(37.9, -122.0));
    client.write_all(far.as_bytes()).await.unwrap();
    timeout(Duration::from_secs(3), attempt)
        .await
        .unwrap()
        .unwrap();
    let during = wait_session(&proxy, |r| r["status"] == "streaming").await;
    assert_eq!(during["upstreamStatus"], "connected");
    reject.send(()).unwrap();
    let failed = wait_session(&proxy, |r| {
        r["lastUpstreamError"] == "caster rejected the mountpoint"
    })
    .await;
    assert_eq!(failed["status"], "streaming");
    assert_eq!(failed["upstreamStatus"], "connected");
    assert_eq!(failed["currentStation"], "A");
    assert_eq!(failed["bytesSent"], 4);

    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(6)).await;
    tokio::time::resume();
    // The failed switch must retry using cached GGA while A remains connected.
    // Send no additional rover bytes after the rejected switch.
    let replaced = wait_session(&proxy, |r| r["currentStation"] == "B").await;
    assert_eq!(replaced["status"], "upstream_connected");
    assert_eq!(replaced["bytesSent"], 4);
    close.send(()).unwrap();
    // Immediate redial fails because the mock caster listener has exited.
    let dropped = wait_session(&proxy, |r| r["upstreamStatus"] == "error").await;
    assert_eq!(dropped["status"], "awaiting_upstream");
    assert_eq!(dropped["active"], true);
    proxy.stop();
}

#[tokio::test]
async fn proxy_snapshots_are_isolated_and_cleaned_up() {
    let first = start_proxy(9, 9).await;
    std::fs::write(&first.path, b"[{\"id\":\"stale\",\"active\":false}]").unwrap();
    let second = start_proxy(9, 9).await;
    assert_ne!(first.path, second.path);
    second.registry.flush();
    assert_eq!(std::fs::read_to_string(&second.path).unwrap(), "[]");
    let first_dir = first.path.parent().unwrap().to_path_buf();
    let second_dir = second.path.parent().unwrap().to_path_buf();
    first.stop();
    second.stop();
    assert!(!first_dir.exists());
    assert!(!second_dir.exists());
}

#[tokio::test]
async fn non_reading_rover_times_out_even_when_correction_write_is_blocked() {
    let caster = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = caster.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut socket, _) = caster.accept().await.unwrap();
        read_until(&mut socket, b"\r\n\r\n").await;
        socket.write_all(b"ICY 200 OK\r\n\r\n").await.unwrap();
        read_until(&mut socket, b"\r\n").await;
        // Much larger than the proxy send buffer and rover receive window.
        let chunk = [0xD3; 8192];
        for _ in 0..4096 {
            if socket.write_all(&chunk).await.is_err() {
                return;
            }
        }
        std::future::pending::<()>().await;
    });
    let proxy = start_proxy(port, port).await;
    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_recv_buffer_size(1024).unwrap();
    let mut client = socket.connect(proxy.addr).await.unwrap();
    let token = base64::engine::general_purpose::STANDARD.encode("rover:secret");
    client
        .write_all(format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    read_until(&mut client, b"\r\n\r\n").await;
    client
        .write_all(format!("{}\r\n", gga(37.0, -122.0)).as_bytes())
        .await
        .unwrap();
    // Keep the rover socket open, but never read another byte. First verify
    // real backpressure, so the test cannot pass on an empty/slow upstream.
    let mut previous = wait_session(&proxy, |r| r["bytesSent"].as_u64().unwrap_or(0) > 65536).await;
    timeout(Duration::from_secs(3), async {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let current = wait_session(&proxy, |r| r["active"] == true).await;
            if current["bytesSent"] == previous["bytesSent"] {
                break;
            }
            previous = current;
        }
    })
    .await
    .expect("correction forwarding never reached backpressure");
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(121)).await;
    tokio::time::resume();
    let ended = wait_session(&proxy, |r| r["active"] == false).await;
    assert_eq!(ended["disconnectReason"], "client idle timeout");
    assert_eq!(ended["bytesSent"], previous["bytesSent"]);
    drop(client);
    proxy.stop();
}

#[tokio::test]
async fn individual_accounts_and_reload_control_new_connections() {
    let proxy = start_proxy(9, 9).await;
    let config = Config::parse(
        r#"{
        "mountPoint":"NEAR", "username":"legacy", "password":"old",
        "users":[
            {"username":"alice","password":"one"},
            {"username":"bob","password":"two"},
            {"username":"disabled","password":"three","active":false}
        ]
    }"#,
    )
    .unwrap();
    proxy.configs.send(config.clone()).unwrap();
    let mut connected = Vec::new();
    for credentials in ["alice:one", "bob:two"] {
        let mut client = TcpStream::connect(proxy.addr).await.unwrap();
        let token = base64::engine::general_purpose::STANDARD.encode(credentials);
        client
            .write_all(
                format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        let response = read_until(&mut client, b"ICY 200 OK").await;
        assert!(String::from_utf8_lossy(&response).contains("ICY 200 OK"));
        let port = client.local_addr().unwrap().port();
        let session = wait_session(&proxy, |r| {
            r["clientPort"] == port && r["active"] == true && r["authenticated"] == true
        })
        .await;
        connected.push((client, session));
    }
    for credentials in [
        "alice:two",
        "unknown:one",
        "disabled:three",
        "legacy:old",
        "",
    ] {
        let mut client = TcpStream::connect(proxy.addr).await.unwrap();
        let token = base64::engine::general_purpose::STANDARD.encode(credentials);
        client
            .write_all(
                format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        assert!(read_to_string(&mut client).await.contains("401"));
    }
    let mut disabled = config;
    for user in &mut disabled.users {
        user.active = false;
    }
    proxy.configs.send(disabled).unwrap();
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    let token = base64::engine::general_purpose::STANDARD.encode("alice:one");
    client
        .write_all(format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    assert!(read_to_string(&mut client).await.contains("401"));
    // Confirm the server processes new bytes on each original session after reload.
    let sentence = b"$GPGSA,A,3\r\n";
    for (client, original) in &mut connected {
        client.write_all(sentence).await.unwrap();
        let expected_bytes = original["bytesReceived"].as_u64().unwrap() + sentence.len() as u64;
        let session = wait_session(&proxy, |r| {
            r["id"] == original["id"]
                && r["active"] == true
                && r["bytesReceived"].as_u64().unwrap_or(0) >= expected_bytes
        })
        .await;
        assert_eq!(session["authenticated"], true);
        assert_eq!(session["bytesReceived"], expected_bytes);
    }
    proxy.stop();
}

// No second rover GGA is sent: both recovery paths must run independently.
#[tokio::test]
async fn dropped_caster_reconnects_immediately_without_another_gga() {
    check_autonomous_reconnect(false).await;
}

#[tokio::test]
async fn rejected_caster_retries_on_timer_without_another_gga() {
    check_autonomous_reconnect(true).await;
}

async fn check_autonomous_reconnect(reject_first: bool) {
    let caster = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = caster.local_addr().unwrap().port();
    let expected_gga = gga(37.0, -122.0);
    let forwarded_gga = expected_gga.clone();
    let task = tokio::spawn(async move {
        let (mut first, _) = caster.accept().await.unwrap();
        read_until(&mut first, b"\r\n\r\n").await;
        if reject_first {
            first
                .write_all(b"HTTP/1.0 503 Unavailable\r\n\r\n")
                .await
                .unwrap();
        } else {
            first.write_all(b"ICY 200 OK\r\n\r\n").await.unwrap();
            read_until(&mut first, b"\n").await;
            first.write_all(b"FIRST").await.unwrap();
        }
        drop(first);
        let started = tokio::time::Instant::now();
        let limit = Duration::from_secs(if reject_first { 7 } else { 2 });
        let (mut second, _) = timeout(limit, caster.accept())
            .await
            .expect("proxy did not reconnect without another GGA")
            .unwrap();
        if reject_first {
            assert!(
                started.elapsed() >= Duration::from_millis(4900),
                "retry ignored backoff"
            );
        }
        read_until(&mut second, b"\r\n\r\n").await;
        second.write_all(b"ICY 200 OK\r\n\r\n").await.unwrap();
        let gga = read_until(&mut second, b"\n").await;
        assert_eq!(
            String::from_utf8(gga).unwrap(),
            format!("{forwarded_gga}\r\n")
        );
        second.write_all(b"RECOVERED").await.unwrap();
        let mut buf = [0; 1];
        let _ = second.read(&mut buf).await;
    });
    let proxy = start_proxy(port, port).await;
    let mut client = TcpStream::connect(proxy.addr).await.unwrap();
    let token = base64::engine::general_purpose::STANDARD.encode("rover:secret");
    client
        .write_all(format!("GET /NEAR HTTP/1.0\r\nAuthorization: Basic {token}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    read_until(&mut client, b"\r\n\r\n").await;
    client
        .write_all(format!("{expected_gga}\r\n").as_bytes())
        .await
        .unwrap();
    let mut received = Vec::new();
    timeout(Duration::from_secs(8), async {
        while !received.windows(9).any(|bytes| bytes == b"RECOVERED") {
            let mut buf = [0; 128];
            let n = client.read(&mut buf).await.unwrap();
            assert!(n > 0, "rover disconnected during recovery");
            received.extend_from_slice(&buf[..n]);
        }
    })
    .await
    .expect("corrections did not resume");
    drop(client);
    task.await.unwrap();
    proxy.stop();
}
