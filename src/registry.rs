//! Live session table written to `logs/sessions.json` for the admin UI.
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

const HISTORY_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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
    #[serde(skip)]
    disconnected_unix: Option<u64>,
}

pub struct Registry {
    path: PathBuf,
    inner: Mutex<SessionTable>,
    flush_lock: Mutex<()>,
}

#[derive(Default)]
struct SessionTable {
    records: Vec<SessionRecord>,
    by_id: HashMap<String, usize>,
}

impl SessionTable {
    fn push(&mut self, record: SessionRecord) {
        self.by_id.insert(record.id.clone(), self.records.len());
        self.records.push(record);
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut SessionRecord> {
        let index = *self.by_id.get(id)?;
        self.records.get_mut(index)
    }

    fn prune(&mut self, now: u64) {
        let previous_len = self.records.len();
        self.records.retain(|session| match session.disconnected_unix {
            Some(then) => now.saturating_sub(then) < HISTORY_SECS,
            None => true,
        });
        if self.records.len() != previous_len {
            self.by_id.clear();
            for (index, session) in self.records.iter().enumerate() {
                self.by_id.insert(session.id.clone(), index);
            }
        }
    }
}

pub struct LiveSession {
    pub(crate) id: String,
    nmea: mpsc::Sender<String>,
}

impl Registry {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::create_dir_all(Path::new("logs/connections"));
        Self {
            path,
            inner: Mutex::new(SessionTable::default()),
            flush_lock: Mutex::new(()),
        }
    }

    pub async fn open(&self, peer: SocketAddr) -> LiveSession {
        let id = session_id();
        let nmea_log_file = format!("logs/connections/{id}.nmea.log");
        let (tx, mut rx) = mpsc::channel::<String>(64);
        let log_path = nmea_log_file.clone();
        tokio::spawn(async move {
            let _ = tokio::fs::create_dir_all("logs/connections").await;
            let mut file = match OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .await
            {
                Ok(file) => file,
                Err(err) => {
                    tracing::warn!(%err, %log_path, "nmea log unavailable");
                    return;
                }
            };
            while let Some(line) = rx.recv().await {
                if file.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        let (now, _) = now_unix();
        self.with_mut(|sessions| {
            sessions.push(SessionRecord {
                id: id.clone(),
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
                nmea_log_file,
                disconnected_unix: None,
            });
        });
        LiveSession { id, nmea: tx }
    }

    pub fn position(&self, id: &str, lat: f64, lon: f64, fix_quality: u32, satellites: u32) {
        self.with_mut(|sessions| {
            if let Some(session) = sessions.get_mut(id) {
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
    }

    pub fn add_bytes(&self, id: &str, sent: u64, received: u64) {
        self.with_mut(|sessions| {
            if let Some(session) = sessions.get_mut(id) {
                session.bytes_sent += sent;
                session.bytes_received += received;
            }
        });
    }

    pub fn note_nmea(&self, session: &LiveSession, sentence: &str) {
        let _ = session.nmea.try_send(format!("{sentence}\n"));
    }

    pub fn close(&self, id: &str) {
        let (stamp, unix) = now_unix();
        self.with_mut(|sessions| {
            if let Some(session) = sessions.get_mut(id) {
                session.active = false;
                session.disconnected_at = Some(stamp);
                session.disconnected_unix = Some(unix);
            }
        });
    }

    pub fn flush(&self) {
        // Serialize writers to the shared temporary path, without holding the
        // session lock during serialization or filesystem I/O.
        let _writer = self.flush_lock.lock().unwrap_or_else(|err| err.into_inner());
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
        if let Ok(mut file) = fs::File::create(&tmp) {
            if file.write_all(&text).is_ok() {
                let _ = fs::rename(&tmp, &self.path);
            }
        }
    }

    fn with_mut<T>(&self, f: impl FnOnce(&mut SessionTable) -> T) -> T {
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        f(&mut guard)
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
        }
    }

    #[test]
    fn pruning_reindexes_surviving_sessions_and_preserves_active_ones() {
        let mut table = SessionTable::default();
        table.push(record("expired", Some(1)));
        table.push(record("active", None));
        table.push(record("recent", Some(HISTORY_SECS)));
        table.prune(HISTORY_SECS + 1);
        assert!(table.get_mut("expired").is_none());
        assert_eq!(table.by_id.len(), 2);
        table.get_mut("active").unwrap().bytes_sent = 42;
        assert_eq!(table.records[0].id, "active");
        assert_eq!(table.records[0].bytes_sent, 42);
        assert_eq!(table.get_mut("recent").unwrap().id, "recent");
        table.push(record("new", None));
        assert_eq!(table.get_mut("new").unwrap().id, "new");
    }

    #[test]
    fn concurrent_counters_and_snapshots_preserve_the_admin_schema() {
        let path = std::env::temp_dir().join(format!(
            "neartrip-registry-test-{}-{}.json", std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
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

    #[test]
    fn epoch_formats_as_utc() {
        assert_eq!(unix_to_rfc3339(0, 0), "1970-01-01T00:00:00.000Z");
    }
}
