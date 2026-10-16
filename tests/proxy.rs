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
    assert!(accepted.is_err(), "a rejected rover must not dial the caster");
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
    let request = format!("GET /NEAR HTTP/1.0\r\nUser-Agent: test\r\nAuthorization: Basic {token}\r\n\r\n");
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

struct Proxy {
    addr: SocketAddr,
    shutdown: watch::Sender<bool>,
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
    let (_config_tx, config_rx) = watch::channel(config);
    let (shutdown, shutdown_rx) = watch::channel(false);
    let registry = Arc::new(Registry::new(std::env::temp_dir().join(format!(
        "neartrip-sessions-{}.json",
        addr.port()
    ))));
    tokio::spawn(async move {
        serve(listener, config_rx, registry, shutdown_rx).await;
    });
    Proxy { addr, shutdown }
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
                    let Ok(Ok(n)) = timeout(Duration::from_secs(2), socket.read(&mut buf)).await else {
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
                    let Ok(Ok(n)) = timeout(Duration::from_secs(2), socket.read(&mut buf)).await else {
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
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {needle:?} in {acc:?}");
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
