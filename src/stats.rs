//! Process-lifetime counters. Snapshots are IPC only and are never read back.
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex};
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counter {
    pub key: String,
    pub sessions: u64,
    pub active: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub connected_seconds: u64,
    pub last_seen: u64,
}
struct Tracked {
    key: String,
    publisher: bool,
    since: u64,
}
pub struct Stats {
    started_at: u64,
    inner: Mutex<Inner>,
}
#[derive(Default)]
struct Inner {
    clients: HashMap<String, Counter>,
    bases: HashMap<String, Counter>,
    sessions: HashMap<String, Tracked>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    started_at: u64,
    pub clients: Vec<Counter>,
    pub bases: Vec<Counter>,
}
impl Default for Stats {
    fn default() -> Self {
        Self {
            started_at: crate::caster::now_ms(),
            inner: Mutex::new(Inner::default()),
        }
    }
}
impl Stats {
    pub fn start(&self, id: &str, key: String, publisher: bool, now: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.sessions.contains_key(id) {
            return;
        }
        let map = if publisher {
            &mut inner.bases
        } else {
            &mut inner.clients
        };
        // Bound identities while retaining active counters; avoid unbounded anonymous-IP growth.
        if !map.contains_key(&key) && map.len() >= 10000 {
            if let Some(oldest) = map
                .iter()
                .filter(|(_, c)| c.active == 0)
                .min_by_key(|(_, c)| c.last_seen)
                .map(|(key, _)| key.clone())
            {
                map.remove(&oldest);
            } else {
                return;
            }
        }
        let counter = map.entry(key.clone()).or_insert_with(|| Counter {
            key: key.clone(),
            ..Counter::default()
        });
        counter.sessions += 1;
        counter.active += 1;
        counter.last_seen = now;
        inner.sessions.insert(
            id.into(),
            Tracked {
                key,
                publisher,
                since: now,
            },
        );
    }
    pub fn bytes(&self, id: &str, sent: u64, received: u64, publisher: bool, now: u64) {
        let mut inner = self.inner.lock().unwrap();
        let Some(tracked) = inner.sessions.get(id) else {
            return;
        };
        if tracked.publisher != publisher {
            return;
        }
        let key = tracked.key.clone();
        let map = if publisher {
            &mut inner.bases
        } else {
            &mut inner.clients
        };
        if let Some(counter) = map.get_mut(&key) {
            counter.bytes_sent += sent;
            counter.bytes_received += received;
            counter.last_seen = now;
        }
    }
    pub fn close(&self, id: &str, now: u64) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(tracked) = inner.sessions.remove(id) {
            let map = if tracked.publisher {
                &mut inner.bases
            } else {
                &mut inner.clients
            };
            if let Some(counter) = map.get_mut(&tracked.key) {
                counter.active = counter.active.saturating_sub(1);
                counter.connected_seconds += now.saturating_sub(tracked.since) / 1000;
                counter.last_seen = now;
            }
        }
    }
    pub fn snapshot(&self, now: u64) -> Snapshot {
        let inner = self.inner.lock().unwrap();
        let mut active_seconds: HashMap<(bool, &str), u64> = HashMap::new();
        for tracked in inner.sessions.values() {
            *active_seconds
                .entry((tracked.publisher, tracked.key.as_str()))
                .or_default() += now.saturating_sub(tracked.since) / 1000;
        }
        let counters = |publisher| {
            let map = if publisher {
                &inner.bases
            } else {
                &inner.clients
            };
            let mut counters: Vec<_> = map.values().cloned().collect();
            for counter in &mut counters {
                counter.connected_seconds += active_seconds
                    .get(&(publisher, counter.key.as_str()))
                    .copied()
                    .unwrap_or(0);
            }
            counters.sort_by(|a, b| a.key.cmp(&b.key));
            counters
        };
        Snapshot {
            started_at: self.started_at,
            clients: counters(false),
            bases: counters(true),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_logins_aggregate_and_upload_payload_counts_survive_reconnections() {
        let stats = Stats::default();
        stats.start("1", "login:tractor".into(), false, 1000);
        stats.start("2", "login:tractor".into(), false, 2000);
        stats.bytes("1", 10, 2, false, 3000);
        stats.bytes("2", 20, 4, false, 3000);
        let snap = stats.snapshot(4000);
        assert_eq!(snap.clients[0].active, 2);
        assert_eq!(snap.clients[0].connected_seconds, 5);
        assert_eq!(snap.clients[0].bytes_sent, 30);
        stats.close("1", 4000);
        stats.close("1", 5000);
        stats.start("3", "BASE".into(), true, 4000);
        stats.bytes("3", 0, 42, true, 5000);
        stats.close("3", 6000);
        stats.start("4", "BASE".into(), true, 7000);
        stats.bytes("4", 0, 12, true, 8000);
        let snap = stats.snapshot(8000);
        assert_eq!(snap.bases[0].sessions, 2);
        assert_eq!(snap.bases[0].bytes_received, 54);
        assert_eq!(snap.clients[0].active, 1);
        assert!(Stats::default().snapshot(0).clients.is_empty());
    }
}
