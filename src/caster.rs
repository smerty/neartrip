//! Direct publisher streams. Bounded queues disconnect lagging rovers.
use crate::{
    config::{Config, Source, Station},
    registry::{LiveSession, Registry},
    server::{auth_matches, ct_eq, decode_basic},
};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::tcp::{OwnedReadHalf, OwnedWriteHalf},
    sync::{broadcast, watch},
};

pub const FRESH_FOR: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct Hub {
    streams: Mutex<HashMap<String, SourceState>>,
}
struct SourceState {
    tx: Option<broadcast::Sender<Vec<u8>>>,
    connected_at: u64,
    last_data: Option<tokio::time::Instant>,
    last_data_at: Option<u64>,
    bytes_received: u64,
    last_error: Option<String>,
    qualification: crate::onboarding::Qualification,
    decoder: crate::rtcm::Decoder,
    position: Option<crate::rtcm::Position>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    mount_point: String,
    status: String,
    connected_at: Option<u64>,
    last_data_at: Option<u64>,
    bytes_received: u64,
    subscribers: usize,
    last_error: Option<String>,
    position: Option<crate::rtcm::Position>,
    onboarding: crate::onboarding::Onboarding,
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
impl Hub {
    pub fn healthy(&self, mount: &str) -> bool {
        self.streams.lock().unwrap().get(mount).is_some_and(|s| {
            s.tx.is_some() && s.last_data.is_some_and(|at| at.elapsed() < FRESH_FOR)
        })
    }
    pub fn ready(&self, source: &Source) -> bool {
        let streams = self.streams.lock().unwrap();
        let Some(state) = streams.get(&source.mount_point) else {
            return false;
        };
        state
            .qualification
            .view(
                source,
                state.tx.is_some(),
                state.last_data.is_some(),
                state.last_data.is_some_and(|at| at.elapsed() < FRESH_FOR),
            )
            .status
            == "ready"
    }
    pub fn subscribe(&self, mount: &str) -> Option<broadcast::Receiver<Vec<u8>>> {
        self.streams
            .lock()
            .unwrap()
            .get(mount)?
            .tx
            .as_ref()
            .map(|tx| tx.subscribe())
    }
    pub fn stations(&self, config: &Config) -> Vec<Station> {
        let mut stations = config.stations.clone();
        for source in &config.sources {
            if source.active && self.ready(source) {
                let detected = self.position(&source.mount_point);
                let coordinates = detected
                    .map(|p| (p.latitude, p.longitude))
                    .or_else(|| Some((source.latitude?, source.longitude?)));
                if let Some((latitude, longitude)) = coordinates {
                    stations.push(Station {
                        mount_point: source.mount_point.clone(),
                        caster_host: "direct".into(),
                        caster_port: 0,
                        username: String::new(),
                        password: String::new(),
                        latitude,
                        longitude,
                        active: true,
                    });
                }
            }
        }
        stations
    }
    pub fn position(&self, mount: &str) -> Option<crate::rtcm::Position> {
        self.streams.lock().unwrap().get(mount)?.position.clone()
    }
    /// Fill a transient configuration for sourcetable output; never persist learned positions.
    pub fn located_config(&self, config: &Config) -> Config {
        let mut located = config.clone();
        for source in &mut located.sources {
            if let Some(position) = self.position(&source.mount_point) {
                source.latitude = Some(position.latitude);
                source.longitude = Some(position.longitude);
            }
        }
        located
    }
    fn publish(&self, source: &Source, bytes: &[u8]) {
        let mut streams = self.streams.lock().unwrap();
        if let Some(state) = streams.get_mut(&source.mount_point) {
            let positions = state.decoder.feed_positions(bytes);
            let interrupted = state.last_data.is_some_and(|at| at.elapsed() >= FRESH_FOR);
            if positions.is_empty() {
                state
                    .qualification
                    .observe(source, state.position.as_ref(), false, interrupted);
            } else {
                // Inspect every position report, even when TCP coalesces several frames.
                for (index, position) in positions.into_iter().enumerate() {
                    state.position = Some(position);
                    state.qualification.observe(
                        source,
                        state.position.as_ref(),
                        true,
                        interrupted && index == 0,
                    );
                }
            }
            state.last_data = Some(tokio::time::Instant::now());
            state.last_data_at = Some(now_ms());
            state.bytes_received += bytes.len() as u64;
            if let Some(tx) = &state.tx {
                let _ = tx.send(bytes.to_vec());
            }
        }
    }
    pub fn health(&self, config: &Config) -> Vec<Health> {
        let streams = self.streams.lock().unwrap();
        config
            .sources
            .iter()
            .map(|source| {
                let state = streams.get(&source.mount_point);
                let connected = state.is_some_and(|s| s.tx.is_some());
                let status = if !source.active {
                    "disabled"
                } else if !connected {
                    "offline"
                } else if state.unwrap().last_data.is_none() {
                    "waiting"
                } else if state.unwrap().last_data.unwrap().elapsed() >= FRESH_FOR {
                    "stale"
                } else {
                    "healthy"
                };
                Health {
                    mount_point: source.mount_point.clone(),
                    status: status.into(),
                    connected_at: state.map(|s| s.connected_at),
                    last_data_at: state.and_then(|s| s.last_data_at),
                    bytes_received: state.map_or(0, |s| s.bytes_received),
                    subscribers: state
                        .and_then(|s| s.tx.as_ref())
                        .map_or(0, |tx| tx.receiver_count()),
                    last_error: state.and_then(|s| s.last_error.clone()),
                    position: state.and_then(|s| s.position.clone()),
                    onboarding: state
                        .map(|s| {
                            s.qualification.view(
                                source,
                                connected,
                                s.last_data.is_some(),
                                s.last_data.is_some_and(|at| at.elapsed() < FRESH_FOR),
                            )
                        })
                        .unwrap_or_else(|| {
                            crate::onboarding::Qualification::default()
                                .view(source, false, false, false)
                        }),
                }
            })
            .collect()
    }
    /// Atomic, credential-free snapshot consumed by the admin process.
    pub async fn snapshots(
        self: std::sync::Arc<Self>,
        path: std::path::PathBuf,
        configs: watch::Receiver<Config>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = interval.tick() => {},
                _ = shutdown.changed() => break,
            }
            let sources = self.health(&configs.borrow());
            let body = serde_json::json!({ "updatedAt": now_ms(), "sources": sources });
            let temp = path.with_extension("json.tmp");
            if let Some(parent) = path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let result = async {
                tokio::fs::write(&temp, body.to_string()).await?;
                tokio::fs::rename(&temp, &path).await
            }
            .await;
            if let Err(err) = result {
                tracing::warn!(%err, "source health snapshot failed");
            }
        }
        let _ = tokio::fs::remove_file(path).await;
    }
}
struct Publisher<'a> {
    hub: &'a Hub,
    mount: String,
}
impl Drop for Publisher<'_> {
    fn drop(&mut self) {
        if let Some(state) = self.hub.streams.lock().unwrap().get_mut(&self.mount) {
            state.tx = None;
            if state.last_error.is_none() {
                state.last_error = Some("source disconnected".into());
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn route(
    head: &str,
    rest: &[u8],
    configs: &watch::Receiver<Config>,
    hub: &Hub,
    read: &mut OwnedReadHalf,
    write: &mut OwnedWriteHalf,
    registry: &Registry,
    live: &LiveSession,
) -> Option<Result<(), String>> {
    let first = head.lines().next().unwrap_or("");
    let parts: Vec<_> = first.split_whitespace().collect();
    let method = *parts.first()?;
    let publishing = method == "SOURCE" || method == "POST";
    let path = if method == "SOURCE" {
        *parts.get(2)?
    } else {
        *parts.get(1)?
    };
    let mount = path.trim_start_matches('/').split('?').next().unwrap_or("");
    let config = configs.borrow().clone();
    let source = config
        .sources
        .iter()
        .find(|s| s.active && s.mount_point == mount);
    if !publishing && !(method == "GET" && source.is_some() && mount != config.mount_point) {
        return None;
    }
    let auth = head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case("authorization")
            .then(|| decode_basic(value.trim()))
            .flatten()
    });
    let authorized = if publishing {
        source.is_some_and(|s| {
            !s.password.is_empty()
                && if method == "SOURCE" {
                    ct_eq(
                        parts.get(1).unwrap_or(&"").as_bytes(),
                        s.password.as_bytes(),
                    )
                } else {
                    auth.as_ref().is_some_and(|(u, p)| {
                        ct_eq(u.as_bytes(), s.username.as_bytes())
                            & ct_eq(p.as_bytes(), s.password.as_bytes())
                    })
                }
        })
    } else {
        !config.requires_auth() || auth_matches(&config, auth.as_ref())
    };
    if !authorized {
        return Some(reject(write, "401 Unauthorized").await);
    }
    if publishing && (mount.is_empty() || mount == config.mount_point || mount.contains('/')) {
        return Some(reject(write, "409 Conflict").await);
    }
    if publishing {
        // Version 2 chunk framing must never leak into correction payloads.
        if head.lines().skip(1).any(|l| {
            l.split_once(':')
                .is_some_and(|(k, _)| k.eq_ignore_ascii_case("transfer-encoding"))
        }) {
            return Some(reject(write, "501 Not Implemented").await);
        }
        let tx = {
            let mut streams = hub.streams.lock().unwrap();
            if streams.get(mount).is_some_and(|s| s.tx.is_some()) {
                None
            } else {
                let (tx, _) = broadcast::channel(64);
                streams.insert(
                    mount.to_string(),
                    SourceState {
                        tx: Some(tx.clone()),
                        connected_at: now_ms(),
                        last_data: None,
                        last_data_at: None,
                        bytes_received: 0,
                        last_error: None,
                        qualification: crate::onboarding::Qualification::default(),
                        decoder: crate::rtcm::Decoder::default(),
                        position: None,
                    },
                );
                Some(tx)
            }
        };
        let Some(_tx) = tx else {
            return Some(reject(write, "409 Conflict").await);
        };
        drop(_tx);
        let _guard = Publisher {
            hub,
            mount: mount.to_string(),
        };
        registry.station(&live.id, mount);
        registry.publisher(&live.id);
        let mut live_configs = configs.clone();
        let result: Result<(), String> = async {
                let response: &[u8] = if method == "SOURCE" {
                    b"ICY 200 OK\r\n\r\n"
                } else {
                    b"HTTP/1.1 200 OK\r\n\r\n"
                };
                write.write_all(response).await.map_err(|e| e.to_string())?;
                if !rest.is_empty() {
                    hub.publish(source.unwrap(), rest);
                }
                let mut buf = [0u8; 4096];
                let mut deadline = tokio::time::Instant::now() + Duration::from_secs(30);
                loop {
                    let n = tokio::select! {
                        changed = live_configs.changed() => {
                            if changed.is_err() { return Err("configuration closed".into()); }
                            let allowed = live_configs.borrow().sources.iter().any(|s| s == source.unwrap() && s.active);
                            if !allowed { return Err("publisher configuration changed".into()); }
                            continue;
                        }
                        n = tokio::time::timeout_at(deadline, read.read(&mut buf)) =>
                            n.map_err(|_| "source idle timeout")?.map_err(|e| e.to_string())?,
                    };
                    if n == 0 {
                        return Err("source disconnected".into());
                    }
                    deadline = tokio::time::Instant::now() + Duration::from_secs(30);
                    registry.add_bytes(&live.id, 0, n as u64);
                    hub.publish(source.unwrap(), &buf[..n]);
                }
            }.await;
        if let Err(err) = &result {
            if let Some(state) = hub.streams.lock().unwrap().get_mut(mount) {
                state.last_error = Some(err.clone());
            }
        }
        Some(result)
    } else {
        let receiver = hub.subscribe(mount);
        let Some(mut rx) = receiver else {
            return Some(reject(write, "503 Service Unavailable").await);
        };
        registry.authenticated(&live.id);
        registry.station(&live.id, mount);
        registry.upstream(&live.id, "connected", None);
        let mut live_configs = configs.clone();
        Some(async {
            write.write_all(b"ICY 200 OK\r\n\r\n").await.map_err(|e| e.to_string())?;
            let mut buf = [0u8; 1024];
            loop {
                tokio::select! {
                    changed = live_configs.changed() => {
                        if changed.is_err() || !live_configs.borrow().sources.iter().any(|s| s.active && s.mount_point == mount) {
                            return Err("source disabled or removed".into());
                        }
                    }
                    data = rx.recv() => {
                        let data = data.map_err(|e| format!("source stream ended: {e}"))?;
                        tokio::time::timeout(Duration::from_secs(10), write.write_all(&data)).await.map_err(|_| "slow rover")?.map_err(|e| e.to_string())?;
                        registry.add_bytes(&live.id, data.len() as u64, 0);
                    }
                    n = read.read(&mut buf) => {
                        let n = n.map_err(|e| e.to_string())?;
                        if n == 0 { return Err("rover disconnected".into()); }
                        registry.add_bytes(&live.id, 0, n as u64);
                    }
                }
            }
        }.await)
    }
}
async fn reject(write: &mut OwnedWriteHalf, status: &str) -> Result<(), String> {
    let _ = write
        .write_all(format!("HTTP/1.1 {status}\r\n\r\n").as_bytes())
        .await;
    Err(status.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn health_excludes_waiting_stale_disabled_and_offline_sources() {
        let config = Config::parse(r#"{"sources":[{"mountPoint":"BASE","username":"b","password":"secret","latitude":0,"longitude":0,"settlingSeconds":0}]}"#).unwrap();
        let hub = Hub::default();
        let (tx, _) = broadcast::channel(64);
        hub.streams.lock().unwrap().insert(
            "BASE".into(),
            SourceState {
                tx: Some(tx),
                connected_at: now_ms(),
                last_data: None,
                last_data_at: None,
                bytes_received: 0,
                last_error: None,
                qualification: crate::onboarding::Qualification::default(),
                decoder: crate::rtcm::Decoder::default(),
                position: None,
            },
        );
        assert_eq!(hub.health(&config)[0].status, "waiting");
        assert!(hub.stations(&config).is_empty());
        let mut receiver = hub.subscribe("BASE").unwrap();
        hub.publish(&config.sources[0], b"data");
        assert_eq!(receiver.recv().await.unwrap(), b"data");
        assert_eq!(hub.health(&config)[0].subscribers, 1);
        assert_eq!(hub.health(&config)[0].bytes_received, 4);
        assert_eq!(hub.stations(&config)[0].latitude, 0.0);
        assert_eq!(hub.health(&config)[0].status, "healthy");
        tokio::time::advance(FRESH_FOR).await;
        assert_eq!(hub.health(&config)[0].status, "stale");
        assert!(hub.stations(&config).is_empty());
        hub.publish(&config.sources[0], b"new");
        assert!(hub.healthy("BASE"));
        let mut disabled = config.clone();
        disabled.sources[0].active = false;
        assert_eq!(hub.health(&disabled)[0].status, "disabled");
        assert!(hub.stations(&disabled).is_empty());
        drop(Publisher {
            hub: &hub,
            mount: "BASE".into(),
        });
        assert_eq!(hub.health(&config)[0].status, "offline");
        assert!(!hub.healthy("BASE"));
        assert_eq!(
            hub.health(&config)[0].last_error.as_deref(),
            Some("source disconnected")
        );
        assert!(!serde_json::to_string(&hub.health(&config))
            .unwrap()
            .contains("secret"));
    }

    #[test]
    fn direct_sources_without_coordinates_remain_fixed_only() {
        let config =
            Config::parse(r#"{"sources":[{"mountPoint":"BASE","username":"b","password":"s"}]}"#)
                .unwrap();
        let hub = Hub::default();
        let (tx, _) = broadcast::channel(64);
        hub.streams.lock().unwrap().insert(
            "BASE".into(),
            SourceState {
                tx: Some(tx),
                connected_at: now_ms(),
                last_data: Some(tokio::time::Instant::now()),
                last_data_at: Some(now_ms()),
                bytes_received: 1,
                last_error: None,
                qualification: crate::onboarding::Qualification::default(),
                decoder: crate::rtcm::Decoder::default(),
                position: None,
            },
        );
        assert!(hub.healthy("BASE"));
        assert!(hub.stations(&config).is_empty());
    }
}
