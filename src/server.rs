//! One TCP session per rover.
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

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
    read: Option<OwnedReadHalf>,
    write: Option<OwnedWriteHalf>,
    direct: Option<tokio::sync::broadcast::Receiver<Vec<u8>>>,
    mount: String,
    last_data: tokio::time::Instant,
    connected_at: Instant,
    session_id: String,
    bytes_received: u64,
    gga_pending: Vec<u8>,
    gga_latest: Option<Vec<u8>>,
}

// Kept inside the session so dropping the session cancels the dial as well.
struct ConnectAttempt {
    mount: String,
    latest_gga: watch::Sender<String>,
    future: std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(Upstream, Vec<u8>), String>> + Send>,
    >,
}

async fn poll_attempt(attempt: &mut Option<ConnectAttempt>) -> Result<(Upstream, Vec<u8>), String> {
    match attempt {
        Some(attempt) => attempt.future.as_mut().await,
        None => std::future::pending().await,
    }
}

pub async fn serve(
    listener: TcpListener,
    configs: watch::Receiver<Config>,
    registry: Arc<Registry>,
    shutdown: watch::Receiver<bool>,
) {
    serve_with_hub(
        listener,
        configs,
        registry,
        shutdown,
        Arc::new(crate::caster::Hub::default()),
    )
    .await;
}

pub async fn serve_with_hub(
    listener: TcpListener,
    configs: watch::Receiver<Config>,
    registry: Arc<Registry>,
    mut shutdown: watch::Receiver<bool>,
    hub: Arc<crate::caster::Hub>,
) {
    let mut clients = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            Some(_) = clients.join_next(), if !clients.is_empty() => {},
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok((socket, peer)) => {
                        let hub = hub.clone();
                        let configs = configs.clone();
                        let registry = Arc::clone(&registry);
                        let mut shutdown = shutdown.clone();
                        clients.spawn(async move {
                            let live = registry.open(peer).await;
                            let reason = tokio::select! {
                                _ = shutdown.changed() => "core shutdown".to_string(),
                                reason = handle_client(socket, peer, configs, &registry, &live, &hub) => reason,
                            };
                            registry.close_with_reason(&live.id, &reason);
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
    while clients.join_next().await.is_some() {}
}

async fn handle_client(
    socket: TcpStream,
    peer: SocketAddr,
    configs: watch::Receiver<Config>,
    registry: &Registry,
    live: &crate::registry::LiveSession,
    hub: &crate::caster::Hub,
) -> String {
    let _ = socket.set_nodelay(true);
    let id = &live.id;
    tracing::info!(%id, %peer, "client connected");
    let reason = session(socket, configs, registry, live, hub)
        .await
        .err()
        .unwrap_or_else(|| "sourcetable served".into());
    tracing::info!(%id, %peer, %reason, "client disconnected");
    reason
}

async fn session(
    socket: TcpStream,
    configs: watch::Receiver<Config>,
    registry: &Registry,
    live: &crate::registry::LiveSession,
    hub: &crate::caster::Hub,
) -> Result<(), String> {
    let (mut client_read, mut client_write) = socket.into_split();
    let mut incoming = Vec::new();
    let mut tmp = [0u8; 1024];
    loop {
        let n = read_some(&mut client_read, &mut tmp).await?;
        registry.add_bytes(&live.id, 0, n as u64);
        incoming.extend_from_slice(&tmp[..n]);
        if let Some(split_at) = find_subsequence(&incoming, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&incoming[..split_at]).into_owned();
            let rest = incoming[split_at + 4..].to_vec();
            if let Some(result) = crate::caster::route(
                &head,
                &rest,
                &configs,
                hub,
                &mut client_read,
                &mut client_write,
                registry,
                live,
            )
            .await
            {
                return result;
            }
            match dispatch_request(&head, &configs) {
                RequestAction::Sourcetable => {
                    let body = sourcetable(&hub.located_config(&configs.borrow()));
                    client_write
                        .write_all(body.as_bytes())
                        .await
                        .map_err(|e| e.to_string())?;
                    let _ = client_write.shutdown().await;
                    return Ok(());
                }
                RequestAction::Reject(body) => {
                    let _ = client_write.write_all(body.as_bytes()).await;
                    let _ = client_write.shutdown().await;
                    return Err(body);
                }
                RequestAction::Stream => {
                    registry.authenticated(&live.id);
                    client_write
                        .write_all(b"ICY 200 OK\r\n\r\n")
                        .await
                        .map_err(|e| e.to_string())?;
                    return stream(
                        client_read,
                        client_write,
                        rest,
                        configs,
                        registry,
                        live,
                        hub,
                    )
                    .await;
                }
            }
        }
        if incoming.len() > HANDSHAKE_LIMIT {
            return Err("handshake too large".into());
        }
    }
}

enum RequestAction {
    Sourcetable,
    Reject(String),
    Stream,
}

fn dispatch_request(head: &str, configs: &watch::Receiver<Config>) -> RequestAction {
    let config = configs.borrow().clone();
    let Some(request) = parse_request(head) else {
        return RequestAction::Reject("HTTP/1.1 400 Bad Request\r\n\r\n".into());
    };
    if request.path == "/" {
        return RequestAction::Sourcetable;
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

pub(crate) fn decode_basic(value: &str) -> Option<(String, String)> {
    let encoded = value
        .strip_prefix("Basic ")
        .or_else(|| value.strip_prefix("basic "))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let (user, pass) = text.split_once(':')?;
    Some((user.to_string(), pass.to_string()))
}

pub(crate) fn auth_matches(config: &Config, auth: Option<&(String, String)>) -> bool {
    let Some((user, pass)) = auth else {
        return false;
    };
    if !config.users.is_empty() {
        return config.users.iter().fold(false, |matched, account| {
            let credentials_match = ct_eq(user.as_bytes(), account.username.as_bytes())
                & ct_eq(pass.as_bytes(), account.password.as_bytes());
            matched | (account.active & credentials_match)
        });
    }
    ct_eq(user.as_bytes(), config.username.as_bytes())
        & ct_eq(pass.as_bytes(), config.password.as_bytes())
}

pub(crate) fn ct_eq(left: &[u8], right: &[u8]) -> bool {
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
    hub: &crate::caster::Hub,
) -> Result<(), String> {
    let mut line_buf = pending;
    // Inline arrays live in every suspended rover task. Keep them bounded;
    // TCP reads may split any sentence or correction burst across iterations.
    let mut tmp = [0u8; 1024];
    let mut up_buf = [0u8; 4096];
    let mut upstream: Option<Upstream> = None;
    let mut last_fail: Option<(String, Instant)> = None;
    let mut latest_gga = None;
    let mut attempt = None;
    let mut health_tick = tokio::time::interval(Duration::from_secs(1));
    let mut client_deadline = tokio::time::Instant::now() + READ_IDLE;

    loop {
        // Cover every await, including caster dialing/GGA writes and a
        // backpressured correction write. Cancelling a partial write is safe:
        // expiry ends this session rather than retrying the payload.
        let deadline = client_deadline;
        tokio::time::timeout_at(deadline, async {
            drain_lines(
                &mut line_buf,
                &configs,
                registry,
                live,
                hub,
                &mut upstream,
                &mut attempt,
                &mut last_fail,
                &mut latest_gga,
            )
            .await;
            recover_upstream(&configs, registry, live, hub, &mut upstream,
                &mut attempt, &mut last_fail, latest_gga.as_ref()).await;
            let retry_at = if latest_gga.is_some() && attempt.is_none() {
                last_fail.as_ref().map(|(_, when)| *when + RETRY_AFTER)
            } else {
                None
            };
            let client_n = tokio::select! {
                _ = health_tick.tick() => {
                    if !configs.borrow().sources.is_empty() || upstream.as_ref().is_some_and(|s| s.direct.is_some()) {
                        if let Some(gga) = latest_gga.as_ref() {
                            ensure_upstream(&configs, registry, live, hub, &mut upstream, &mut attempt, &mut last_fail, gga).await;
                        }
                    }
                    None
                }
                result = poll_attempt(&mut attempt) => {
                    let completed = attempt.take().expect("completed dial");
                    match result {
                        Ok((link, pending)) => {
                            // Only retire the retained caster once handshake and GGA succeed.
                            registry.upstream(&live.id, "connecting", None);
                            registry.upstream(&live.id, "connected", None);
                            registry.station(&live.id, &link.mount);
                            upstream = Some(link);
                            last_fail = None;
                            if !pending.is_empty() {
                                client_write.write_all(&pending).await.map_err(|e| e.to_string())?;
                                registry.add_bytes(&live.id, pending.len() as u64, 0);
                            }
                        }
                        Err(err) => {
                            registry.upstream(&live.id, if upstream.is_some() { "connected" } else { "error" }, Some(&err));
                            tracing::warn!(id = %live.id, mount = %completed.mount, %err,
                                retry_after_secs = RETRY_AFTER.as_secs(), "caster connect failed");
                            last_fail = Some((completed.mount, Instant::now()));
                        }
                    }
                    None
                }
                _ = async {
                    match retry_at {
                        Some(at) => tokio::time::sleep_until(at).await,
                        None => std::future::pending().await,
                    }
                } => None,
                n = client_read.read(&mut tmp) => Some(match n {
                    Ok(0) => Err("client closed".into()),
                    Ok(n) => Ok(n),
                    Err(err) => Err(err.to_string()),
                }),
                n = read_upstream(&mut upstream, &mut up_buf) => {
                    match n {
                        Ok(0) => {
                            registry.upstream(&live.id, "disconnected", Some("caster closed"));
                            if let Some(link) = upstream.take() {
                                tracing::warn!(id = %live.id, mount = %link.mount,
                                    uptime_ms = link.connected_at.elapsed().as_millis() as u64,
                                    idle_ms = link.last_data.elapsed().as_millis() as u64,
                                    bytes_received = link.bytes_received, "caster closed; reconnecting immediately");
                                last_fail = None;
                            }
                        }
                        Err(err) => {
                            registry.upstream(&live.id, "error", Some(&err.to_string()));
                            if let Some(link) = upstream.take() {
                                tracing::warn!(id = %live.id, mount = %link.mount, error = %err,
                                    error_kind = ?err.kind(), os_error = ?err.raw_os_error(),
                                    uptime_ms = link.connected_at.elapsed().as_millis() as u64,
                                    idle_ms = link.last_data.elapsed().as_millis() as u64,
                                    bytes_received = link.bytes_received, "caster read failed; reconnecting immediately");
                                last_fail = None;
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
                client_deadline = tokio::time::Instant::now() + READ_IDLE;
                registry.add_bytes(&live.id, 0, n as u64);
                line_buf.extend_from_slice(&tmp[..n]);
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "client idle timeout".to_string())??;
    }
}

async fn recover_upstream(
    configs: &watch::Receiver<Config>,
    registry: &Registry,
    live: &crate::registry::LiveSession,
    hub: &crate::caster::Hub,
    upstream: &mut Option<Upstream>,
    attempt: &mut Option<ConnectAttempt>,
    last_fail: &mut Option<(String, Instant)>,
    latest_gga: Option<&crate::nmea::Gga>,
) {
    let retry_due = last_fail
        .as_ref()
        .is_some_and(|(_, when)| when.elapsed() >= RETRY_AFTER);
    if retry_due {
        // Consume expired failures even if selection has changed.
        *last_fail = None;
    }
    if upstream.is_none() || retry_due {
        if let Some(gga) = latest_gga {
            let had_upstream = upstream.is_some();
            ensure_upstream(
                configs, registry, live, hub, upstream, attempt, last_fail, gga,
            )
            .await;
            if had_upstream && upstream.is_none() && last_fail.is_none() {
                ensure_upstream(
                    configs, registry, live, hub, upstream, attempt, last_fail, gga,
                )
                .await;
            }
        }
    }
}

async fn drain_lines(
    line_buf: &mut Vec<u8>,
    configs: &watch::Receiver<Config>,
    registry: &Registry,
    live: &crate::registry::LiveSession,
    hub: &crate::caster::Hub,
    upstream: &mut Option<Upstream>,
    attempt: &mut Option<ConnectAttempt>,
    last_fail: &mut Option<(String, Instant)>,
    latest_gga: &mut Option<crate::nmea::Gga>,
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
            *latest_gga = Some(gga.clone());
            ensure_upstream(
                configs, registry, live, hub, upstream, attempt, last_fail, &gga,
            )
            .await;
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
    hub: &crate::caster::Hub,
    upstream: &mut Option<Upstream>,
    attempt: &mut Option<ConnectAttempt>,
    last_fail: &mut Option<(String, Instant)>,
    gga: &crate::nmea::Gga,
) {
    let config = configs.borrow().clone();
    if upstream.as_ref().is_some_and(|s| {
        s.direct.is_some()
            && (!config
                .sources
                .iter()
                .any(|source| source.mount_point == s.mount && hub.ready(source)))
    }) {
        *upstream = None;
        *last_fail = None;
    }
    let current_mount = upstream.as_ref().map(|link| link.mount.clone());
    let stations = hub.stations(&config);
    let Some(chosen) = select_station(
        gga.latitude,
        gga.longitude,
        &stations,
        current_mount.as_deref(),
        SWITCH_MARGIN_M,
    ) else {
        *upstream = None;
        *attempt = None;
        // A config reload can remove the failed station while a retry is due.
        // Clear its deadline so an unavailable position cannot spin the timer.
        *last_fail = None;
        registry.upstream(
            &live.id,
            "unavailable",
            Some("no active station for this position"),
        );
        tracing::warn!(id = %live.id, "no active station for this position");
        return;
    };
    let mount = chosen.station.mount_point.clone();
    let station = chosen.station.clone();
    let distance_m = chosen.distance_m;
    if attempt
        .as_ref()
        .is_some_and(|pending| pending.mount != mount)
    {
        *attempt = None;
    }
    // Every selected fix reaches the retained caster, including during dial/backoff.
    if let Err(err) = forward_gga(upstream, gga).await {
        tracing::warn!(id = %live.id, mount = ?current_mount, target_mount = %mount,
            error = %err, "caster GGA write failed; reconnecting immediately");
        registry.upstream(&live.id, "error", Some("caster GGA write failed"));
        *last_fail = None;
        *upstream = None;
        return;
    }
    if current_mount.as_deref() == Some(mount.as_str()) {
        return;
    }
    if config.sources.iter().any(|s| s.mount_point == mount) {
        if let Some(receiver) = hub.subscribe(&mount) {
            *attempt = None;
            *last_fail = None;
            *upstream = Some(Upstream {
                read: None,
                write: None,
                direct: Some(receiver),
                mount: mount.clone(),
                last_data: Instant::now(),
                connected_at: Instant::now(),
                session_id: live.id.clone(),
                bytes_received: 0,
                gga_pending: Vec::new(),
                gga_latest: None,
            });
            registry.station(&live.id, &mount);
            registry.upstream(&live.id, "connected", None);
        }
        return;
    }
    if last_fail
        .as_ref()
        .is_some_and(|(failed, when)| failed == &mount && when.elapsed() < RETRY_AFTER)
    {
        return;
    }
    if let Some(pending) = attempt.as_mut() {
        // Coalesce fixes while the handshake or a candidate GGA write is pending.
        pending.latest_gga.send_replace(gga.sentence.clone());
        return;
    }
    if upstream.is_none() {
        registry.upstream(&live.id, "connecting", None);
    }
    tracing::info!(id = %live.id, mount = %mount, host = %station.caster_host,
        port = station.caster_port, previous_mount = ?current_mount, "caster connecting");
    let (gga_tx, mut gga_rx) = watch::channel(gga.sentence.clone());
    let user_agent = config.user_agent;
    let session_id = live.id.clone();
    *attempt = Some(ConnectAttempt {
        mount,
        latest_gga: gga_tx,
        future: Box::pin(async move {
            let started = Instant::now();
            let mut link = upstream::connect(&station, &user_agent).await?;
            // Keep writes inside the candidate future, polled alongside retained
            // correction reads. Catch updates arriving during a backpressured write
            // before publishing the candidate as the active connection.
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    let sentence = gga_rx.borrow_and_update().clone();
                    let line = format!("{sentence}\r\n");
                    link.stream
                        .write_all(line.as_bytes())
                        .await
                        .map_err(|err| format!("initial caster GGA write failed: {err}"))?;
                    if !gga_rx.has_changed().unwrap_or(false) {
                        return Ok::<(), String>(());
                    }
                }
            })
            .await
            .map_err(|_| "initial caster GGA write timed out".to_string())??;
            tracing::info!(id = %session_id, mount = %station.mount_point,
                connect_ms = started.elapsed().as_millis() as u64,
                initial_bytes = link.pending.len(), distance_m = distance_m.round(), "caster connected");
            let (read, write) = link.stream.into_split();
            Ok((
                Upstream {
                    read: Some(read),
                    write: Some(write),
                    direct: None,
                    mount: station.mount_point,
                    last_data: Instant::now(),
                    connected_at: Instant::now(),
                    session_id,
                    bytes_received: link.pending.len() as u64,
                    gga_pending: Vec::new(),
                    gga_latest: None,
                },
                link.pending,
            ))
        }),
    });
}

async fn forward_gga(
    upstream: &mut Option<Upstream>,
    gga: &crate::nmea::Gga,
) -> std::io::Result<()> {
    let Some(link) = upstream.as_mut() else {
        return Ok(());
    };
    if link.direct.is_some() {
        return Ok(());
    }
    link.gga_latest = Some(format!("{}\r\n", gga.sentence).into_bytes());
    flush_gga(link)
}

fn flush_gga(link: &mut Upstream) -> std::io::Result<()> {
    loop {
        if link.gga_pending.is_empty() {
            let Some(next) = link.gga_latest.take() else {
                return Ok(());
            };
            link.gga_pending = next;
        }
        match link
            .write
            .as_ref()
            .expect("remote writer")
            .try_write(&link.gga_pending)
        {
            Ok(0) => return Err(std::io::ErrorKind::WriteZero.into()),
            Ok(n) => {
                link.gga_pending.drain(..n);
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(err) => return Err(err),
        }
    }
}

async fn read_upstream(upstream: &mut Option<Upstream>, buf: &mut [u8]) -> std::io::Result<usize> {
    match upstream.as_mut() {
        Some(link) => {
            if let Some(receiver) = link.direct.as_mut() {
                let data = receiver.recv().await.map_err(|e| {
                    std::io::Error::new(std::io::ErrorKind::BrokenPipe, e.to_string())
                })?;
                if data.len() > buf.len() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "source chunk too large",
                    ));
                }
                buf[..data.len()].copy_from_slice(&data);
                link.last_data = Instant::now();
                link.bytes_received += data.len() as u64;
                return Ok(data.len());
            }
            let deadline = link.last_data + READ_IDLE;
            let io = async {
                loop {
                    tokio::select! {
                        n = link.read.as_mut().expect("remote reader").read(buf) => return n,
                        ready = link.write.as_ref().expect("remote writer").writable(), if !link.gga_pending.is_empty() => {
                            ready?;
                            flush_gga(link)?;
                        }
                    }
                }
            };
            match tokio::time::timeout_at(deadline, io).await {
                Ok(result) => {
                    if matches!(result, Ok(n) if n > 0) {
                        if link.bytes_received == 0 {
                            tracing::info!(id = %link.session_id, mount = %link.mount,
                                elapsed_ms = link.connected_at.elapsed().as_millis() as u64,
                                "caster first correction bytes received");
                        }
                        link.bytes_received += result.as_ref().copied().unwrap_or(0) as u64;
                        link.last_data = tokio::time::Instant::now();
                    }
                    result
                }
                Err(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "caster idle",
                )),
            }
        }
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
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retained_upstream_write_failure_clears_switch_backoff() {
        check_retained_write_failure(false).await;
    }

    #[tokio::test]
    async fn timer_retry_recovers_after_selection_returns_to_broken_retained_caster() {
        check_retained_write_failure(true).await;
    }

    async fn check_retained_write_failure(timer_retry: bool) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socket = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (_peer, _) = listener.accept().await.unwrap();
        let (read, mut write) = socket.into_split();
        // Force a deterministic write failure without relying on TCP reset timing.
        write.shutdown().await.unwrap();
        let mut upstream = Some(Upstream {
            read: Some(read),
            write: Some(write),
            direct: None,
            mount: "A".into(),
            last_data: Instant::now(),
            connected_at: Instant::now(),
            session_id: "test".into(),
            bytes_received: 0,
            gga_pending: Vec::new(),
            gga_latest: None,
        });
        let client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (_client_peer, addr) = listener.accept().await.unwrap();
        let (_, _client_write) = client.into_split();
        let mut attempt = None;
        let dir = std::env::temp_dir().join(format!(
            "neartrip-write-failure-{}-{timer_retry}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let registry = Registry::new(dir.join("sessions.json"));
        let live = registry.open(addr).await;
        let mut config = Config::parse(r#"{"stations":[
            {"mountPoint":"A","casterHost":"127.0.0.1","casterPort":9,"latitude":37,"longitude":-122},
            {"mountPoint":"B","casterHost":"127.0.0.1","casterPort":9,"latitude":38,"longitude":-122}
        ]}"#).unwrap();
        if timer_retry {
            config.stations[1].active = false;
        }
        let (_tx, configs) = watch::channel(config);
        let gga = crate::nmea::Gga {
            latitude: 38.0,
            longitude: -122.0,
            fix_quality: 2,
            num_satellites: 12,
            sentence: "$GPGGA,test".into(),
        };
        let mut last_fail = Some(("B".into(), Instant::now()));
        if timer_retry {
            last_fail = Some(("B".into(), Instant::now() - RETRY_AFTER));
            recover_upstream(
                &configs,
                &registry,
                &live,
                &crate::caster::Hub::default(),
                &mut upstream,
                &mut attempt,
                &mut last_fail,
                Some(&gga),
            )
            .await;
            assert!(
                attempt.is_some(),
                "timer-driven write failure must schedule recovery without rover input"
            );
            assert_eq!(attempt.as_ref().unwrap().mount, "A");
        } else {
            ensure_upstream(
                &configs,
                &registry,
                &live,
                &crate::caster::Hub::default(),
                &mut upstream,
                &mut attempt,
                &mut last_fail,
                &gga,
            )
            .await;
        }
        assert!(
            upstream.is_none(),
            "failed retained connection must be dropped"
        );
        assert!(
            last_fail.is_none(),
            "established write failure must allow immediate recovery"
        );
        drop(live);
        drop(registry);
        let _ = std::fs::remove_dir_all(dir);
    }
}
