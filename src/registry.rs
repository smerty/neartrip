//! Live session table written to `logs/sessions.json` for the admin UI.
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
    inner: Mutex<Vec<SessionRecord>>,
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
            inner: Mutex::new(Vec::new()),
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
            if let Some(session) = sessions.iter_mut().find(|s| s.id == id) {
                session.latitude = Some(lat);
                session.longitude = Some(lon);
                session.fix_quality = Some(fix_quality);
                session.num_satellites = Some(satellites);
            }
        });
    }

    pub fn station(&self, id: &str, mount: &str) {
        self.with_mut(|sessions| {
            if let Some(session) = sessions.iter_mut().find(|s| s.id == id) {
                session.current_station = Some(mount.to_string());
            }
        });
    }

    pub fn add_bytes(&self, id: &str, sent: u64, received: u64) {
        self.with_mut(|sessions| {
            if let Some(session) = sessions.iter_mut().find(|s| s.id == id) {
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
            if let Some(session) = sessions.iter_mut().find(|s| s.id == id) {
                session.active = false;
                session.disconnected_at = Some(stamp);
                session.disconnected_unix = Some(unix);
            }
        });
    }

    pub fn flush(&self) {
        let snapshot = self.with_mut(|sessions| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            sessions.retain(|session| match session.disconnected_unix {
                Some(then) => now.saturating_sub(then) < HISTORY_SECS,
                None => true,
            });
            sessions.clone()
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

    fn with_mut<T>(&self, f: impl FnOnce(&mut Vec<SessionRecord>) -> T) -> T {
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

    #[test]
    fn epoch_formats_as_utc() {
        assert_eq!(unix_to_rfc3339(0, 0), "1970-01-01T00:00:00.000Z");
    }
}
