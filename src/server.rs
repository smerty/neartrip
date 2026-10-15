//! One TCP session per rover.
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use crate::config::Config;
use crate::geo::{select_station, SWITCH_MARGIN_M};
use crate::nmea::parse_gga;
use crate::registry::Registry;
use crate::sourcetable::sourcetable;
use crate::upstream;

const RETRY_AFTER: Duration = Duration::from_secs(5);
const READ_IDLE: Duration = Duration::from_secs(120);
const LINE_LIMIT: usize = 1024;
const HANDSHAKE_LIMIT: usize = 8192;

struct Upstream {
    read: OwnedReadHalf,
    write: OwnedWriteHalf,
    mount: String,
}

pub async fn serve(
    listener: TcpListener,
    configs: watch::Receiver<Config>,
    registry: Arc<Registry>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((socket, peer)) => {
                        let configs = configs.clone();
                        let registry = Arc::clone(&registry);
                        tokio::spawn(async move {
                            handle_client(socket, peer, configs, registry).await;
                        });
                    }
                    Err(err) => {
                        tracing::error!(%err, "accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
        }
    }
}

async fn handle_client(
    socket: TcpStream,
    peer: SocketAddr,
    configs: watch::Receiver<Config>,
    registry: Arc<Registry>,
) {
    let _ = socket.set_nodelay(true);
    let live = registry.open(peer).await;
    let id = live.id.clone();
    tracing::info!(%id, %peer, "client connected");
    let result = session(socket, configs, &registry, &live).await;
    if let Err(err) = result {
        tracing::debug!(%id, %err, "session ended");
    }
    registry.close(&id);
    registry.flush();
    tracing::info!(%id, %peer, "client disconnected");
}

async fn session(
    socket: TcpStream,
    configs: watch::Receiver<Config>,
    registry: &Registry,
    live: &crate::registry::LiveSession,
) -> Result<(), String> {
    let (mut client_read, mut client_write) = socket.into_split();
    let mut incoming = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = read_some(&mut client_read, &mut tmp).await?;
        registry.add_bytes(&live.id, 0, n as u64);
        incoming.extend_from_slice(&tmp[..n]);
        if let Some(split_at) = find_subsequence(&incoming, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&incoming[..split_at]).into_owned();
            let rest = incoming[split_at + 4..].to_vec();
            match dispatch_request(&head, &configs) {
                RequestAction::Sourcetable(body) => {
                    client_write.write_all(body.as_bytes()).await.map_err(|e| e.to_string())?;
                    let _ = client_write.shutdown().await;
                    return Ok(());
                }
                RequestAction::Reject(body) => {
                    let _ = client_write.write_all(body.as_bytes()).await;
                    let _ = client_write.shutdown().await;
                    return Err(body);
                }
                RequestAction::Stream => {
                    client_write
                        .write_all(b"ICY 200 OK\r\n\r\n")
                        .await
                        .map_err(|e| e.to_string())?;
                    return stream(client_read, client_write, rest, configs, registry, live).await;
                }
            }
        }
        if incoming.len() > HANDSHAKE_LIMIT {
            return Err("handshake too large".into());
        }
    }
}

enum RequestAction {
    Sourcetable(String),
    Reject(String),
    Stream,
}

fn dispatch_request(head: &str, configs: &watch::Receiver<Config>) -> RequestAction {
    let config = configs.borrow().clone();
    let Some(request) = parse_request(head) else {
        return RequestAction::Reject("HTTP/1.1 400 Bad Request\r\n\r\n".into());
    };
    if request.path == "/" {
        return RequestAction::Sourcetable(sourcetable(&config));
    }
    let mount = request.path.trim_end_matches('/');
    if mount != format!("/{}", config.mount_point) {
        return RequestAction::Reject("HTTP/1.1 404 Not Found\r\n\r\n".into());
    }
    if config.requires_auth() && !auth_matches(&config, request.auth.as_ref()) {
        return RequestAction::Reject("HTTP/1.1 401 Unauthorized\r\n\r\n".into());
    }
    RequestAction::Stream
}

struct ClientRequest {
    path: String,
    auth: Option<(String, String)>,
}

fn parse_request(head: &str) -> Option<ClientRequest> {
    let mut lines = head.split("\r\n");
    let request = lines.next()?;
    let mut parts = request.split_whitespace();
    let method = parts.next()?;
    let path = parts.next()?.split('?').next()?.to_string();
    if !method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let mut auth = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("authorization") {
            auth = decode_basic(value.trim());
        }
    }
    Some(ClientRequest { path, auth })
}

fn decode_basic(value: &str) -> Option<(String, String)> {
    let encoded = value
        .strip_prefix("Basic ")
        .or_else(|| value.strip_prefix("basic "))?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let (user, pass) = text.split_once(':')?;
    Some((user.to_string(), pass.to_string()))
}

fn auth_matches(config: &Config, auth: Option<&(String, String)>) -> bool {
    let Some((user, pass)) = auth else {
        return false;
    };
    ct_eq(user.as_bytes(), config.username.as_bytes()) && ct_eq(pass.as_bytes(), config.password.as_bytes())
}

fn ct_eq(left: &[u8], right: &[u8]) -> bool {
    let mut diff = left.len() ^ right.len();
    let n = left.len().max(right.len());
    for i in 0..n {
        let a = left.get(i).copied().unwrap_or(0);
        let b = right.get(i).copied().unwrap_or(0);
        diff |= (a ^ b) as usize;
    }
    diff == 0
}

async fn stream(
    mut client_read: OwnedReadHalf,
    mut client_write: OwnedWriteHalf,
    pending: Vec<u8>,
    configs: watch::Receiver<Config>,
    registry: &Registry,
    live: &crate::registry::LiveSession,
) -> Result<(), String> {
    let mut line_buf = pending;
    let mut tmp = [0u8; 4096];
    let mut up_buf = [0u8; 16384];
    let mut upstream: Option<Upstream> = None;
    let mut last_fail: Option<(String, Instant)> = None;

    loop {
        drain_lines(
            &mut line_buf,
            &configs,
            registry,
            live,
            &mut upstream,
            &mut client_write,
            &mut last_fail,
        )
        .await;
        let client_n = tokio::select! {
            n = read_some(&mut client_read, &mut tmp) => Some(n),
            n = read_upstream(&mut upstream, &mut up_buf) => {
                match n {
                    Ok(0) | Err(_) => {
                        if let Some(link) = upstream.take() {
                            last_fail = Some((link.mount, Instant::now()));
                        }
                    }
                    Ok(n) => {
                        client_write.write_all(&up_buf[..n]).await.map_err(|e| e.to_string())?;
                        registry.add_bytes(&live.id, n as u64, 0);
                    }
                }
                None
            }
        };
        if let Some(n) = client_n {
            let n = n?;
            registry.add_bytes(&live.id, 0, n as u64);
            line_buf.extend_from_slice(&tmp[..n]);
        }
    }
}

async fn drain_lines(
    line_buf: &mut Vec<u8>,
    configs: &watch::Receiver<Config>,
    registry: &Registry,
    live: &crate::registry::LiveSession,
    upstream: &mut Option<Upstream>,
    client_write: &mut OwnedWriteHalf,
    last_fail: &mut Option<(String, Instant)>,
) {
    while let Some(split) = line_buf.iter().position(|byte| *byte == b'\n') {
        let raw: Vec<u8> = line_buf.drain(..=split).collect();
        let line = String::from_utf8_lossy(&raw)
            .trim()
            .trim_end_matches('\r')
            .to_string();
        if let Some(gga) = parse_gga(&line) {
            registry.note_nmea(live, &gga.sentence);
            registry.position(
                &live.id,
                gga.latitude,
                gga.longitude,
                gga.fix_quality,
                gga.num_satellites,
            );
            ensure_upstream(configs, registry, live, upstream, client_write, last_fail, &gga).await;
        }
    }
    if line_buf.len() > LINE_LIMIT {
        line_buf.clear();
    }
}

async fn ensure_upstream(
    configs: &watch::Receiver<Config>,
    registry: &Registry,
    live: &crate::registry::LiveSession,
    upstream: &mut Option<Upstream>,
    client_write: &mut OwnedWriteHalf,
    last_fail: &mut Option<(String, Instant)>,
    gga: &crate::nmea::Gga,
) {
    let config = configs.borrow().clone();
    let current_mount = upstream.as_ref().map(|link| link.mount.clone());
    let Some(chosen) = select_station(
        gga.latitude,
        gga.longitude,
        &config.stations,
        current_mount.as_deref(),
        SWITCH_MARGIN_M,
    ) else {
        tracing::warn!("no active station for this position");
        return;
    };
    let mount = chosen.station.mount_point.clone();
    let station = chosen.station.clone();
    let distance_m = chosen.distance_m;
    if current_mount.as_deref() == Some(mount.as_str()) {
        if !forward_gga(upstream, gga).await {
            *last_fail = Some((mount, Instant::now()));
            *upstream = None;
        }
        return;
    }
    if let Some((failed, when)) = last_fail {
        if failed == &mount && when.elapsed() < RETRY_AFTER {
            forward_gga(upstream, gga).await;
            return;
        }
    }
    match upstream::connect(&station, &config.user_agent).await {
        Ok(link) => {
            if !link.pending.is_empty() {
                let _ = client_write.write_all(&link.pending).await;
                registry.add_bytes(&live.id, link.pending.len() as u64, 0);
            }
            let (read, mut write) = link.stream.into_split();
            let line = format!("{}\r\n", gga.sentence);
            if write.write_all(line.as_bytes()).await.is_err() {
                *last_fail = Some((mount, Instant::now()));
                return;
            }
            tracing::info!(mount = %station.mount_point, distance_m = distance_m.round(), "caster connected");
            registry.station(&live.id, &station.mount_point);
            *last_fail = None;
            *upstream = Some(Upstream {
                read,
                write,
                mount: station.mount_point,
            });
        }
        Err(err) => {
            tracing::warn!(mount = %mount, %err, "caster connect failed");
            *last_fail = Some((mount, Instant::now()));
        }
    }
}

async fn forward_gga(upstream: &mut Option<Upstream>, gga: &crate::nmea::Gga) -> bool {
    let Some(link) = upstream.as_mut() else {
        return true;
    };
    let line = format!("{}\r\n", gga.sentence);
    link.write.write_all(line.as_bytes()).await.is_ok()
}

async fn read_upstream(upstream: &mut Option<Upstream>, buf: &mut [u8]) -> std::io::Result<usize> {
    match upstream.as_mut() {
        Some(link) => match tokio::time::timeout(READ_IDLE, link.read.read(buf)).await {
            Ok(result) => result,
            Err(_) => Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "caster idle",
            )),
        },
        None => std::future::pending().await,
    }
}

async fn read_some(socket: &mut OwnedReadHalf, buf: &mut [u8]) -> Result<usize, String> {
    match tokio::time::timeout(READ_IDLE, socket.read(buf)).await {
        Ok(Ok(0)) => Err("client closed".into()),
        Ok(Ok(n)) => Ok(n),
        Ok(Err(err)) => Err(err.to_string()),
        Err(_) => Err("client idle timeout".into()),
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}
