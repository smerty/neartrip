//! Transport security regression tests. Wire protocol stays compatible with RTK Express.
use neartrip::{registry::Registry, serve, Config};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    time::{timeout, Instant},
};

async fn start(
    label: &str,
) -> (
    SocketAddr,
    Arc<Registry>,
    watch::Sender<bool>,
    tokio::task::JoinHandle<()>,
    std::path::PathBuf,
) {
    let config = Config::parse(r#"{"username":"r","password":"p","mountPoint":"NEAR","connectionLimits":{"maxConnections":4,"maxPendingHandshakes":2,"maxPendingPerIp":1,"handshakeTimeoutSeconds":1}}"#).unwrap();
    let (_, configs) = watch::channel(config);
    let (stop, shutdown) = watch::channel(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let path = std::env::temp_dir().join(format!(
        "neartrip-security-{label}-{}.json",
        std::process::id()
    ));
    let registry = Arc::new(Registry::new(&path));
    let task = tokio::spawn(serve(listener, configs, registry.clone(), shutdown));
    (addr, registry, stop, task, path)
}
async fn snapshot(registry: &Registry, path: &std::path::Path) -> serde_json::Value {
    registry.flush();
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
async fn banner(client: &mut TcpStream) {
    client
        .write_all(b"GET /NEAR HTTP/1.0\r\nAuthorization: Basic cjpw\r\n\r\n")
        .await
        .unwrap();
    let mut response = [0; 14];
    timeout(Duration::from_secs(2), client.read_exact(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&response, b"ICY 200 OK\r\n\r\n");
}
#[tokio::test]
async fn trickling_handshake_cannot_extend_deadline_or_consume_unbounded_records() {
    let (addr, registry, stop, task, path) = start("handshake").await;
    let mut first = TcpStream::connect(addr).await.unwrap();
    first.write_all(b"G").await.unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    for _ in 0..8 {
        let mut rejected = TcpStream::connect(addr).await.unwrap();
        assert_eq!(
            timeout(Duration::from_secs(1), rejected.read_u8())
                .await
                .unwrap()
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::UnexpectedEof
        );
    }
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(750) {
        first.write_all(b"x").await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    assert!(timeout(Duration::from_millis(700), first.read_u8())
        .await
        .unwrap()
        .is_err());
    let records = snapshot(&registry, &path).await;
    assert_eq!(records.as_array().unwrap().len(), 1);
    assert_eq!(records[0]["disconnectReason"], "handshake timeout");
    let mut recovered = TcpStream::connect(addr).await.unwrap();
    banner(&mut recovered).await;
    stop.send(true).unwrap();
    task.await.unwrap();
    let _ = std::fs::remove_file(path);
}
#[tokio::test]
async fn malformed_and_oversized_nmea_does_not_break_stream_or_valid_position_updates() {
    let (addr, registry, stop, task, path) = start("nmea").await;
    let mut client = TcpStream::connect(addr).await.unwrap();
    banner(&mut client).await;
    client.write_all("$GPGGA*aé\r\n".as_bytes()).await.unwrap();
    let oversized = neartrip::nmea::with_checksum(&format!(
        "$GPGGA,{},3723.2475,N,12158.3416,W,1,07,1.0,9.0,M,-34.2,M,,",
        "1".repeat(1100)
    ));
    client
        .write_all(format!("{oversized}\r\n").as_bytes())
        .await
        .unwrap();
    let valid = neartrip::nmea::with_checksum(
        "$GPGGA,123519,3723.2475,N,12158.3416,W,1,07,1.0,9.0,M,-34.2,M,,",
    );
    client
        .write_all(format!("{valid}\r\n").as_bytes())
        .await
        .unwrap();
    timeout(Duration::from_secs(2), async {
        loop {
            let records = snapshot(&registry, &path).await;
            if records[0]["latitude"].as_f64().is_some() {
                assert_eq!(records[0]["active"], true);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // A completed handshake is no longer subject to the handshake deadline.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(snapshot(&registry, &path).await[0]["active"], true);
    drop(client);
    stop.send(true).unwrap();
    task.await.unwrap();
    let records = snapshot(&registry, &path).await;
    assert_eq!(records[0]["active"], false);
    let id = records[0]["id"].as_str().unwrap();
    let _ = std::fs::remove_file(format!("logs/connections/{id}.nmea.log"));
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn successful_rover_handshakes_release_pending_slots_before_banner() {
    let (addr, registry, stop, task, path) = start("immediate-admission").await;
    let mut clients = Vec::new();
    // maxPendingPerIp is one: each next connection must work immediately,
    // without waiting for the one-second policy interval.
    for _ in 0..4 {
        let mut client = TcpStream::connect(addr).await.unwrap();
        banner(&mut client).await;
        clients.push(client);
    }
    assert_eq!(
        snapshot(&registry, &path).await.as_array().unwrap().len(),
        4
    );
    stop.send(true).unwrap();
    task.await.unwrap();
    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn publisher_handshakes_also_release_pending_slots_immediately() {
    let config = Config::parse(r#"{"username":"r","password":"p","mountPoint":"NEAR","sources":[{"mountPoint":"BASE","username":"b","password":"s"}],"connectionLimits":{"maxConnections":3,"maxPendingHandshakes":1,"maxPendingPerIp":1}}"#).unwrap();
    let (_cfg, configs) = watch::channel(config);
    let (stop, shutdown) = watch::channel(false);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let path = std::env::temp_dir().join(format!(
        "neartrip-publisher-admission-{}.json",
        std::process::id()
    ));
    let task = tokio::spawn(serve(
        listener,
        configs,
        Arc::new(Registry::new(&path)),
        shutdown,
    ));
    let mut publisher = TcpStream::connect(addr).await.unwrap();
    publisher
        .write_all(b"SOURCE s /BASE\r\n\r\n")
        .await
        .unwrap();
    let mut response = [0; 14];
    timeout(Duration::from_secs(2), publisher.read_exact(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&response, b"ICY 200 OK\r\n\r\n");
    let mut rover = TcpStream::connect(addr).await.unwrap();
    banner(&mut rover).await;
    stop.send(true).unwrap();
    task.await.unwrap();
    let _ = std::fs::remove_file(path);
}
