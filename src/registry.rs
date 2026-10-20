//! Live session table written to `logs/sessions.json` for the admin UI.
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Notify};

const MAX_RECORDS: usize = 16384;
const MAX_LOG_BYTES: usize = 1024 * 1024;
// Also bound detached writers draining queues after rapid authenticated reconnects.
static NMEA_WRITERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8192);
const HISTORY_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct SessionRecord {
    id: String,
    client_ip: String,
    client_port: u16,
    connected_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    disconnected_at: Option<String>,
    active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    latitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    longitude: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fix_quality: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    num_satellites: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_station: Option<String>,
    bytes_sent: u64,
    bytes_received: u64,
    nmea_log_file: String,
    status: String,
    authenticated: bool,
    role: String,
    username: Option<String>,
    #[serde(skip)]
    credential: Option<String>,
    upstream_status: String,
    last_upstream_error: Option<String>,
    last_gga_at: Option<String>,
    disconnect_reason: Option<String>,
    read_idle_timeout_secs: u64,
    #[serde(skip)]
    disconnected_unix: Option<u64>,
    #[serde(skip)]
    log_state: Arc<LogState>,
    #[serde(skip)]
    pending: Option<crate::admission::Pending>,
}

pub struct Registry {
    path: PathBuf,
    inner: Mutex<SessionTable>,
    flush_lock: Mutex<()>,
    changed: Notify,
    pub security: crate::security::Security,
    stats: crate::stats::Stats,
}

#[derive(Default)]
struct SessionTable {
    records: Vec<SessionRecord>,
    by_id: HashMap<String, usize>,
    closed: VecDeque<String>,
    removed: Vec<SessionRecord>,
}

impl SessionTable {
    fn push(&mut self, record: SessionRecord) {
        // Closed IDs form an eviction queue; swap removal updates only the moved
        // record's index. Connection churn never shifts/reindexes the table.
        if self.records.len() >= MAX_RECORDS {
            if let Some(id) = self.closed.pop_front() {
                self.remove(&id);
            }
        }
        if !record.active {
            self.closed.push_back(record.id.clone());
        }
        self.by_id.insert(record.id.clone(), self.records.len());
        self.records.push(record);
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut SessionRecord> {
        let index = *self.by_id.get(id)?;
        self.records.get_mut(index)
    }

    fn remove(&mut self, id: &str) {
        let Some(index) = self.by_id.remove(id) else {
            return;
        };
        let removed = self.records.swap_remove(index);
        if let Some(moved) = self.records.get(index) {
            *self.by_id.get_mut(&moved.id).expect("indexed session") = index;
        }
        removed.log_state.evicted.store(true, Ordering::Release);
        removed.log_state.changed.notify_one();
        self.removed.push(removed);
    }

    fn prune(&mut self, now: u64) {
        let expired: Vec<_> = self
            .records
            .iter()
            .filter(|s| {
                s.disconnected_unix
                    .is_some_and(|then| now.saturating_sub(then) >= HISTORY_SECS)
            })
            .map(|s| s.id.clone())
            .collect();
        for id in expired {
            self.remove(&id);
        }
        self.closed.retain(|id| self.by_id.contains_key(id));
    }
}

#[derive(Default)]
struct LogState {
    evicted: AtomicBool,
    changed: Notify,
}

// Eviction may occur before, during, or after asynchronous file creation.
// The eviction path removes existing files; the writer removes late-created ones.
struct LogCleanup {
    state: Arc<LogState>,
    path: String,
}
impl Drop for LogCleanup {
    fn drop(&mut self) {
        if self.state.evicted.load(Ordering::Acquire) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

// Never trust a pathname loaded from a historical JSON file.
fn remove_nmea_log(record: &SessionRecord) {
    if record.id.len() == 32
        && record.id.bytes().all(|b| b.is_ascii_hexdigit())
        && record.nmea_log_file == format!("logs/connections/{}.nmea.log", record.id)
    {
        let _ = fs::remove_file(&record.nmea_log_file);
    }
}

pub struct LiveSession {
    pub(crate) id: String,
    nmea: OnceLock<mpsc::Sender<String>>,
    log_state: Arc<LogState>,
}

impl Registry {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::create_dir_all(Path::new("logs/connections"));
        let mut table = SessionTable::default();
        match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Vec<SessionRecord>>(&bytes) {
                Ok(records) => {
                    let (stamp, now) = now_unix();
                    for mut record in records {
                        if record.active {
                            record.active = false;
                            record.disconnected_at = Some(stamp.clone());
                            record.disconnect_reason = Some("core restarted".into());
                        }
                        record.status = "disconnected".into();
                        record.upstream_status = "disconnected".into();
                        record.disconnected_unix = record
                            .disconnected_at
                            .as_deref()
                            .and_then(parse_timestamp)
                            .or_else(|| {
                                // Persist the recovery time so another restart cannot
                                // extend retention for the same malformed record.
                                record.disconnected_at = Some(stamp.clone());
                                Some(now)
                            });
                        table.push(record);
                    }
                    table.prune(now);
                }
                Err(err) => {
                    // Preserve the evidence before the startup snapshot replaces it.
                    let backup = path.with_extension(format!("json.corrupt-{}", session_id()));
                    fs::copy(&path, &backup).expect("cannot preserve invalid session history");
                    tracing::warn!(%err, path = %backup.display(), "invalid session history preserved");
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => panic!("cannot read session history {}: {err}", path.display()),
        }
        Self {
            path,
            inner: Mutex::new(table),
            flush_lock: Mutex::new(()),
            changed: Notify::new(),
            security: crate::security::Security::default(),
            stats: crate::stats::Stats::default(),
        }
    }

    /// Publish the session table at most once a second.
    ///
    /// Connect, station-switch, and disconnect mark the table dirty, but a
    /// burst still produces one rewrite per second. Byte counters use the
    /// same cadence. Rewriting the whole history on every close was the cost
    /// removed from the 2,000-rover runs.
    pub fn start_snapshots(self: &Arc<Self>) {
        let registry = Arc::clone(self);
        tokio::spawn(async move {
            let interval = std::time::Duration::from_secs(1);
            let mut next_flush = tokio::time::Instant::now();
            loop {
                tokio::select! {
                    _ = registry.changed.notified() => {
                        tokio::time::sleep_until(next_flush).await;
                    }
                    _ = tokio::time::sleep_until(next_flush) => {}
                }
                let registry = Arc::clone(&registry);
                if tokio::task::spawn_blocking(move || registry.flush())
                    .await
                    .is_err()
                {
                    break;
                }
                next_flush = tokio::time::Instant::now() + interval;
            }
        });
    }

    pub async fn open(&self, peer: SocketAddr) -> LiveSession {
        self.open_inner(peer, None)
    }

    pub(crate) fn open_admitted(
        &self,
        peer: SocketAddr,
        pending: crate::admission::Pending,
    ) -> LiveSession {
        self.open_inner(peer, Some(pending))
    }

    fn open_inner(
        &self,
        peer: SocketAddr,
        pending: Option<crate::admission::Pending>,
    ) -> LiveSession {
        let id = session_id();
        let log_state = Arc::new(LogState::default());
        let (now, _) = now_unix();
        self.with_mut(|sessions| {
            sessions.push(SessionRecord {
                id: id.clone(),
                log_state: log_state.clone(),
                pending,
                client_ip: display_ip(peer),
                client_port: peer.port(),
                connected_at: now,
                disconnected_at: None,
                active: true,
                latitude: None,
                longitude: None,
                fix_quality: None,
                num_satellites: None,
                current_station: None,
                bytes_sent: 0,
                bytes_received: 0,
                nmea_log_file: String::new(),
                status: "tcp_connected".into(),
                upstream_status: "disconnected".into(),
                read_idle_timeout_secs: 120,
                disconnected_unix: None,
                ..SessionRecord::default()
            });
        });
        self.changed.notify_one();
        LiveSession {
            id,
            nmea: OnceLock::new(),
            log_state,
        }
    }

    pub fn publisher(&self, id: &str) {
        let identity = self.with_mut(|sessions| {
            let session = sessions.get_mut(id)?;
            if session.role == "publisher" {
                return None;
            }
            if let Some(pending) = session.pending.take() {
                pending.release();
            }
            session.role = "publisher".into();
            session.status = "publishing".into();
            session.read_idle_timeout_secs = 30;
            Some((session.client_ip.clone(), session.current_station.clone()?))
        });
        if let Some((ip, mount)) = identity {
            let now = crate::caster::now_ms();
            self.stats.start(id, mount, true, now);
            if let Ok(ip) = ip.parse() {
                self.security.authenticated(ip, now);
            }
        }
    }

    pub fn publisher_bytes(&self, id: &str, bytes: usize) {
        self.stats
            .bytes(id, 0, bytes as u64, true, crate::caster::now_ms());
    }

    pub fn position(&self, id: &str, lat: f64, lon: f64, fix_quality: u32, satellites: u32) {
        self.with_mut(|sessions| {
            if let Some(session) = sessions.get_mut(id) {
                session.last_gga_at = Some(now_unix().0);
                session.latitude = Some(lat);
                session.longitude = Some(lon);
                session.fix_quality = Some(fix_quality);
                session.num_satellites = Some(satellites);
            }
        });
    }

    pub fn station(&self, id: &str, mount: &str) {
        self.with_mut(|sessions| {
            if let Some(session) = sessions.get_mut(id) {
                session.current_station = Some(mount.to_string());
            }
        });
        self.changed.notify_one();
    }

    pub fn add_bytes(&self, id: &str, sent: u64, received: u64) {
        self.stats
            .bytes(id, sent, received, false, crate::caster::now_ms());
        self.with_mut(|sessions| {
            if let Some(session) = sessions.get_mut(id) {
                if sent > 0 {
                    session.status = "streaming".into();
                }
                session.bytes_sent += sent;
                session.bytes_received += received;
            }
        });
    }

    pub fn note_nmea(&self, session: &LiveSession, sentence: &str) {
        if sentence.len() > 1024 {
            return;
        }
        // No per-socket log task or file until an authenticated rover emits NMEA.
        let sender = session.nmea.get_or_init(|| {
            let (tx, mut rx) = mpsc::channel::<String>(64);
            let Ok(permit) = NMEA_WRITERS.try_acquire() else {
                return tx;
            };
            let log_path = format!("logs/connections/{}.nmea.log", session.id);
            self.with_mut(|sessions| {
                if let Some(record) = sessions.get_mut(&session.id) {
                    record.nmea_log_file = log_path.clone();
                }
            });
            let state = session.log_state.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let cleanup = LogCleanup {
                    state,
                    path: log_path.clone(),
                };
                let mut options = OpenOptions::new();
                options.create_new(true).write(true);
                #[cfg(unix)]
                options.mode(0o600);
                let mut file = match options.open(&log_path).await {
                    Ok(file) => file,
                    Err(err) => {
                        tracing::warn!(%err, "nmea log unavailable");
                        return;
                    }
                };
                let mut written = 0;
                loop {
                    if cleanup.state.evicted.load(Ordering::Acquire) {
                        break;
                    }
                    let line = tokio::select! {
                        _ = cleanup.state.changed.notified() => continue,
                        line = rx.recv() => match line { Some(line) => line, None => break },
                    };
                    if written + line.len() > MAX_LOG_BYTES {
                        break;
                    }
                    if file.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    written += line.len();
                }
                let _ = file.flush().await;
            });
            tx
        });
        let _ = sender.try_send(format!("{sentence}\n"));
    }

    pub fn authenticated(&self, id: &str) {
        self.authenticated_as(id, None);
    }

    pub fn accepted(&self, id: &str) -> bool {
        self.with_mut(|sessions| {
            sessions
                .get_mut(id)
                .is_some_and(|session| session.authenticated || session.role == "publisher")
        })
    }

    pub fn rover_revoked(&self, id: &str, config: &crate::config::Config) -> bool {
        let state = self.inner.lock().expect("registry lock");
        let Some(session) = state
            .by_id
            .get(id)
            .and_then(|index| state.records.get(*index))
        else {
            return false;
        };
        if session.role != "rover" {
            return false;
        }
        match session.username.as_ref() {
            Some(name) => {
                !(config.users.iter().any(|u| {
                    &u.username == name
                        && config.user_enabled(u)
                        && session.credential.as_ref() == Some(&u.password)
                }) || (config.users.is_empty()
                    && config.members.is_empty()
                    && &config.username == name
                    && session.credential.as_ref() == Some(&config.password)))
            }
            None => config.requires_auth(),
        }
    }

    pub fn authenticated_as(&self, id: &str, auth: Option<&(String, String)>) {
        let username = auth.map(|a| a.0.as_str());
        let identity = self.with_mut(|sessions| {
            let session = sessions.get_mut(id)?;
            if session.authenticated {
                return None;
            }
            if let Some(pending) = session.pending.take() {
                pending.release();
            }
            session.authenticated = true;
            session.role = "rover".into();
            session.username = username.map(str::to_string);
            session.credential = auth.map(|a| a.1.clone());
            session.status = "awaiting_gga".into();
            Some((session.client_ip.clone(), session.bytes_received))
        });
        if let Some((ip, received)) = identity {
            let now = crate::caster::now_ms();
            let key = username
                .map(|u| format!("login:{u}"))
                .unwrap_or_else(|| format!("ip:{ip}"));
            self.stats.start(id, key, false, now);
            self.stats.bytes(id, 0, received, false, now);
            if let Ok(ip) = ip.parse() {
                self.security.authenticated(ip, now);
            }
        }
        self.changed.notify_one();
    }

    pub fn operations(&self, config: &crate::Config) -> serde_json::Value {
        let now = crate::caster::now_ms();
        serde_json::json!({ "updatedAt": now, "stats": self.stats.snapshot(now),
            "security": self.security.snapshot(&config.security, now) })
    }

    pub fn upstream(&self, id: &str, status: &str, error: Option<&str>) {
        self.with_mut(|sessions| {
            if let Some(session) = sessions.get_mut(id) {
                session.upstream_status = status.into();
                if let Some(error) = error {
                    session.last_upstream_error = Some(error.into());
                }
                session.status = match status {
                    "connected" if session.status == "streaming" => "streaming",
                    "connected" => "upstream_connected",
                    "connecting" => "connecting_upstream",
                    _ => "awaiting_upstream",
                }
                .into();
            }
        });
        self.changed.notify_one();
    }

    pub fn close(&self, id: &str) {
        self.close_with_reason(id, "client closed");
    }

    pub fn close_with_reason(&self, id: &str, reason: &str) {
        let (stamp, unix) = now_unix();
        self.stats.close(id, crate::caster::now_ms());
        self.with_mut(|sessions| {
            if let Some(session) = sessions.get_mut(id) {
                if !session.active {
                    return;
                }
                if session.active && (session.authenticated || session.role == "publisher") {
                    if let Ok(ip) = session.client_ip.parse() {
                        self.security.closed(ip);
                    }
                }
                session.active = false;
                session.credential = None;
                session.status = "disconnected".into();
                session.upstream_status = "disconnected".into();
                session.disconnect_reason = Some(reason.into());
                session.disconnected_at = Some(stamp);
                session.disconnected_unix = Some(unix);
                sessions.closed.push_back(id.to_owned());
            }
        });
        self.changed.notify_one();
    }

    pub fn flush(&self) {
        // Serialize writers to the shared temporary path, without holding the
        // session lock during serialization or filesystem I/O.
        let _writer = self
            .flush_lock
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let snapshot = self.with_mut(|sessions| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            sessions.prune(now);
            sessions.records.clone()
        });
        let Ok(text) = serde_json::to_vec_pretty(&snapshot) else {
            return;
        };
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = self.path.with_extension("json.tmp");
        if let Err(err) = (|| {
            let mut file = fs::File::create(&tmp)?;
            file.write_all(&text)?;
            fs::rename(&tmp, &self.path)?;
            Ok::<(), std::io::Error>(())
        })() {
            tracing::warn!(%err, path = %self.path.display(), "session snapshot failed");
        }
    }

    fn with_mut<T>(&self, f: impl FnOnce(&mut SessionTable) -> T) -> T {
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        let result = f(&mut guard);
        let removed = std::mem::take(&mut guard.removed);
        drop(guard);
        // Filesystem work must not hold the mutex used by live rover updates.
        for record in removed {
            remove_nmea_log(&record);
        }
        result
    }
}

fn display_ip(addr: SocketAddr) -> String {
    match addr.ip() {
        std::net::IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|v4| v4.to_string())
            .unwrap_or_else(|| ip.to_string()),
        ip => ip.to_string(),
    }
}

fn session_id() -> String {
    let mut bytes = [0u8; 16];
    if let Ok(mut file) = fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = file.read_exact(&mut bytes);
    } else {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        bytes = nanos.to_le_bytes();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_unix() -> (String, u64) {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let millis = duration.subsec_millis();
    (unix_to_rfc3339(secs, millis), secs)
}

fn unix_to_rfc3339(secs: u64, millis: u32) -> String {
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

// Read the UTC timestamps emitted by older versions, which had no persisted
// epoch field. Reject malformed dates instead of keeping them forever.
fn parse_timestamp(value: &str) -> Option<u64> {
    let date = value.get(..19)?;
    let parts: Vec<u64> = date
        .split(['-', 'T', ':'])
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    let [year, month, day, hour, minute, second] = parts.as_slice() else {
        return None;
    };
    if !(1970..=9999).contains(year)
        || !(1..=12).contains(month)
        || *hour > 23
        || *minute > 59
        || *second > 59
    {
        return None;
    }
    let leap = |y: u64| y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let months = [
        31,
        if leap(*year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if *day == 0 || *day > months[*month as usize - 1] {
        return None;
    }
    let days: u64 = (1970..*year)
        .map(|y| if leap(y) { 366 } else { 365 })
        .sum::<u64>()
        + months[..*month as usize - 1].iter().sum::<u64>()
        + day
        - 1;
    Some(days * 86400 + hour * 3600 + minute * 60 + second)
}

/// Howard Hinnant's civil_from_days. `days` is days since 1970-01-01.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, disconnected: Option<u64>) -> SessionRecord {
        SessionRecord {
            id: id.into(),
            client_ip: "127.0.0.1".into(),
            client_port: 1234,
            connected_at: "1970-01-01T00:00:00.000Z".into(),
            disconnected_at: None,
            active: disconnected.is_none(),
            latitude: None,
            longitude: None,
            fix_quality: None,
            num_satellites: None,
            current_station: None,
            bytes_sent: 0,
            bytes_received: 0,
            nmea_log_file: "test.nmea.log".into(),
            disconnected_unix: disconnected,
            ..SessionRecord::default()
        }
    }

    #[test]
    fn connection_churn_caps_history_without_evicting_active_sessions() {
        let mut table = SessionTable::default();
        table.push(record("active", None));
        for i in 0..MAX_RECORDS + 100 {
            table.push(record(&format!("closed{i}"), Some(1)));
            table.removed.clear();
        }
        assert_eq!(table.records.len(), MAX_RECORDS);
        assert!(table.get_mut("active").unwrap().active);
        assert!(table.get_mut("closed0").is_none());
        assert!(table
            .get_mut(&format!("closed{}", MAX_RECORDS + 99))
            .is_some());
    }

    #[tokio::test]
    async fn eviction_removes_logs_even_when_creation_is_delayed() {
        for start_writer in [false, true] {
            let path = std::env::temp_dir().join(format!(
                "neartrip-log-eviction-{}-{start_writer}.json",
                std::process::id()
            ));
            let registry = Registry::new(&path);
            let session = registry.open("192.0.2.1:1234".parse().unwrap()).await;
            registry.authenticated(&session.id);
            registry.note_nmea(&session, "first fix");
            let log = format!("logs/connections/{}.nmea.log", session.id);
            if start_writer {
                tokio::time::timeout(std::time::Duration::from_secs(2), async {
                    while !Path::new(&log).exists() {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
            }
            // With no await above, the current-thread writer has not started:
            // eviction's first unlink happens before the async file creation.
            registry.close(&session.id);
            for i in 0..MAX_RECORDS {
                registry.with_mut(|table| table.push(record(&format!("churn{i}"), Some(1))));
            }
            assert!(registry.with_mut(|table| table.get_mut(&session.id).is_none()));
            // Keep the sender alive: eviction must wake and terminate the writer.
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                session.nmea.get().unwrap().closed(),
            )
            .await
            .unwrap();
            assert!(!Path::new(&log).exists(), "orphaned log after eviction");
            let _ = fs::remove_file(path);
        }
    }

    #[test]
    fn capacity_eviction_updates_only_the_swapped_index() {
        let mut table = SessionTable::default();
        table.push(record("active", None));
        for i in 0..MAX_RECORDS - 1 {
            table.push(record(&format!("closed{i}"), Some(1)));
        }
        let untouched = table.by_id["closed1000"];
        let allocation = table.records.as_ptr();
        for i in 0..100 {
            table.push(record(&format!("new{i}"), Some(1)));
            table.removed.clear();
        }
        assert_eq!(table.records.as_ptr(), allocation);
        assert_eq!(table.by_id["active"], 0);
        assert_eq!(table.by_id["closed1000"], untouched);
        for (id, index) in &table.by_id {
            assert_eq!(&table.records[*index].id, id);
        }
        assert_eq!(table.closed.len(), MAX_RECORDS - 1);
    }

    #[tokio::test]
    async fn nmea_log_size_and_expiration_are_bounded() {
        let path =
            std::env::temp_dir().join(format!("neartrip-log-limit-{}.json", std::process::id()));
        let registry = Registry::new(&path);
        let session = registry.open("192.0.2.1:1234".parse().unwrap()).await;
        registry.authenticated(&session.id);
        registry.note_nmea(&session, "first");
        let sender = session.nmea.get().unwrap();
        for _ in 0..1100 {
            if sender.send("x".repeat(1023) + "\n").await.is_err() {
                break;
            }
        }
        let log = format!("logs/connections/{}.nmea.log", session.id);
        let size = std::fs::metadata(&log).unwrap().len();
        assert!(size <= MAX_LOG_BYTES as u64);
        assert!(size > (MAX_LOG_BYTES - 1024) as u64);
        registry.close(&session.id);
        registry.with_mut(|sessions| {
            sessions.get_mut(&session.id).unwrap().disconnected_unix = Some(0)
        });
        registry.flush();
        assert!(!Path::new(&log).exists());
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn unauthenticated_connections_do_not_create_nmea_files() {
        let path =
            std::env::temp_dir().join(format!("neartrip-no-log-{}.json", std::process::id()));
        let registry = Registry::new(&path);
        let session = registry.open("192.0.2.1:1234".parse().unwrap()).await;
        assert!(!Path::new(&format!("logs/connections/{}.nmea.log", session.id)).exists());
        assert!(session.nmea.get().is_none());
        registry.close(&session.id);
    }

    #[test]
    fn pruning_preserves_indices_and_active_sessions() {
        let mut table = SessionTable::default();
        table.push(record("expired", Some(1)));
        table.push(record("active", None));
        table.push(record("recent", Some(HISTORY_SECS)));
        table.prune(HISTORY_SECS + 1);
        assert!(table.get_mut("expired").is_none());
        assert_eq!(table.by_id.len(), 2);
        table.get_mut("active").unwrap().bytes_sent = 42;
        assert_eq!(table.get_mut("active").unwrap().bytes_sent, 42);
        assert_eq!(table.get_mut("recent").unwrap().id, "recent");
        table.push(record("new", None));
        assert_eq!(table.get_mut("new").unwrap().id, "new");
    }

    #[test]
    fn concurrent_counters_and_snapshots_preserve_the_admin_schema() {
        let path = std::env::temp_dir().join(format!(
            "neartrip-registry-test-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let registry = std::sync::Arc::new(Registry::new(&path));
        registry.with_mut(|table| table.push(record("rover", None)));
        let mut workers = Vec::new();
        for _ in 0..4 {
            let registry = registry.clone();
            workers.push(std::thread::spawn(move || {
                for _ in 0..1000 {
                    registry.add_bytes("rover", 10, 1);
                }
                registry.flush();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        registry.position("rover", 37.0, -122.0, 1, 8);
        registry.station("rover", "A");
        registry.close("rover");
        registry.flush();
        let json: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(json[0]["bytesSent"], 40000);
        assert_eq!(json[0]["bytesReceived"], 4000);
        assert_eq!(json[0]["currentStation"], "A");
        assert_eq!(json[0]["latitude"], 37.0);
        assert_eq!(json[0]["numSatellites"], 8);
        assert_eq!(json[0]["active"], false);
        assert!(json[0]["disconnectedAt"].is_string());
        fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn restart_preserves_history_counters_and_recovers_interrupted_sessions() {
        let path = std::env::temp_dir().join(format!("neartrip-restart-{}.json", session_id()));
        let registry = Registry::new(&path);
        let live = registry.open("127.0.0.1:1234".parse().unwrap()).await;
        registry.authenticated(&live.id);
        registry.position(&live.id, 0.0, 0.0, 4, 12);
        registry.add_bytes(&live.id, 100, 200);
        registry.with_mut(|table| {
            let mut expired = record("expired", Some(1));
            expired.disconnected_at = Some(unix_to_rfc3339(1, 0));
            table.push(expired);
            let mut recent = record("recent", Some(now_unix().1));
            recent.disconnected_at = Some(now_unix().0);
            recent.disconnect_reason = Some("client closed".into());
            table.push(recent);
        });
        // Serialize directly so the loader must prune an expired legacy entry.
        fs::write(
            &path,
            registry.with_mut(|table| serde_json::to_vec(&table.records).unwrap()),
        )
        .unwrap();
        let restored = Registry::new(&path);
        restored.flush();
        let records: Vec<SessionRecord> =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, live.id);
        assert!(!records[0].active);
        assert_eq!(
            records[0].disconnect_reason.as_deref(),
            Some("core restarted")
        );
        assert_eq!(records[0].bytes_sent, 100);
        assert_eq!(records[0].bytes_received, 200);
        assert_eq!(records[0].latitude, Some(0.0));
        assert_eq!(
            records[1].disconnect_reason.as_deref(),
            Some("client closed")
        );
        let again = Registry::new(&path);
        again.with_mut(|table| {
            assert_eq!(
                table.get_mut(&live.id).unwrap().disconnected_at,
                records[0].disconnected_at
            )
        });
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn malformed_disconnect_times_are_repaired_once_and_still_expire() {
        let path = std::env::temp_dir().join(format!("neartrip-fallback-{}.json", session_id()));
        let mut missing = record("missing", Some(1));
        missing.disconnected_at = None;
        let mut malformed = record("malformed", Some(1));
        malformed.disconnected_at = Some("not a timestamp".into());
        fs::write(
            &path,
            serde_json::to_vec(&vec![missing, malformed]).unwrap(),
        )
        .unwrap();
        let registry = Registry::new(&path);
        registry.flush();
        let repaired: Vec<SessionRecord> =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(repaired.len(), 2);
        for record in &repaired {
            assert!(parse_timestamp(record.disconnected_at.as_deref().unwrap()).is_some());
        }
        let restored = Registry::new(&path);
        restored.with_mut(|table| {
            for (record, original) in table.records.iter().zip(&repaired) {
                assert_eq!(record.disconnected_at, original.disconnected_at);
                assert_eq!(
                    record.disconnected_unix,
                    original
                        .disconnected_at
                        .as_deref()
                        .and_then(parse_timestamp)
                );
            }
            let cutoff = table.records[0].disconnected_unix.unwrap() + HISTORY_SECS;
            table.prune(cutoff - 1);
            assert_eq!(table.records.len(), 2);
            table.prune(cutoff);
            assert!(table.records.is_empty());
        });
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_history_is_preserved_before_the_first_snapshot() {
        let dir = std::env::temp_dir().join(format!("neartrip-corrupt-{}", session_id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sessions.json");
        let invalid = b"[{truncated";
        fs::write(&path, invalid).unwrap();
        let registry = Registry::new(&path);
        registry.flush();
        assert_eq!(fs::read_to_string(&path).unwrap(), "[]");
        let backup = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p != &path)
            .unwrap();
        assert_eq!(fs::read(backup).unwrap(), invalid);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn legacy_utc_dates_round_trip_including_leap_days() {
        for secs in [0, 951782400, 1700000000, 1792300000] {
            assert_eq!(parse_timestamp(&unix_to_rfc3339(secs, 123)), Some(secs));
        }
        assert_eq!(parse_timestamp("2025-02-29T00:00:00.000Z"), None);
    }

    #[test]
    fn active_sessions_older_than_history_keep_counters_and_diagnostics() {
        let registry =
            Registry::new(std::env::temp_dir().join(format!("neartrip-old-{}.json", session_id())));
        registry.with_mut(|table| {
            table.push(record("rover", None));
            table.prune(HISTORY_SECS * 2);
        });
        registry.authenticated("rover");
        registry.position("rover", 37.0, -122.0, 4, 12);
        registry.upstream("rover", "connected", None);
        registry.add_bytes("rover", 4096, 80);
        registry.with_mut(|table| {
            let rover = table.get_mut("rover").unwrap();
            assert!(rover.active && rover.authenticated);
            assert_eq!(rover.status, "streaming");
            assert_eq!(rover.bytes_sent, 4096);
            assert!(rover.last_gga_at.is_some());
        });
    }

    #[test]
    fn epoch_formats_as_utc() {
        assert_eq!(unix_to_rfc3339(0, 0), "1970-01-01T00:00:00.000Z");
    }

    #[tokio::test]
    async fn a_connected_rover_is_published_for_the_admin_ui() {
        let path = std::env::temp_dir().join(format!(
            "neartrip-live-{}-{}.json",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let registry = std::sync::Arc::new(Registry::new(&path));
        registry.start_snapshots();
        let peer = "203.0.113.10:45000".parse().unwrap();
        let live = registry.open(peer).await;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut snapshot = String::new();
        while std::time::Instant::now() < deadline {
            if let Ok(text) = fs::read_to_string(&path) {
                snapshot = text;
                if snapshot.contains(&live.id) && snapshot.contains("\"active\": true") {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            snapshot.contains(&live.id) && snapshot.contains("\"active\": true"),
            "admin snapshot was {snapshot}"
        );
        assert!(snapshot.contains("203.0.113.10"), "{snapshot}");
        let _ = fs::remove_file(&path);
    }
    #[tokio::test]
    async fn authenticated_stats_include_handshake_input_once_and_later_input() {
        let registry = Registry::new(std::env::temp_dir().join("neartrip-handshake-stats.json"));
        let live = registry.open("127.0.0.1:5000".parse().unwrap()).await;
        let config = crate::Config::parse("{}").unwrap();
        // Headers and coalesced GGA arrive before authentication starts stats.
        registry.add_bytes(&live.id, 0, 180);
        let auth = ("rover".to_string(), "secret".to_string());
        registry.authenticated_as(&live.id, Some(&auth));
        registry.authenticated_as(&live.id, Some(&auth));
        registry.add_bytes(&live.id, 20, 75);
        let snapshot = registry.operations(&config);
        let counter = &snapshot["stats"]["clients"][0];
        assert_eq!(counter["bytesReceived"], 255);
        assert_eq!(counter["bytesSent"], 20);
        assert_eq!(counter["sessions"], 1);
        registry.close(&live.id);
    }
}
