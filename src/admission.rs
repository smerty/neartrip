//! Bounded socket admission, separate from optional IP bans.
use serde::Deserialize;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Limits {
    pub max_connections: usize,
    pub max_pending_handshakes: usize,
    pub max_pending_per_ip: usize,
    pub handshake_timeout_seconds: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_connections: 4096,
            max_pending_handshakes: 256,
            max_pending_per_ip: 32,
            handshake_timeout_seconds: 10,
        }
    }
}
impl Limits {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=8192).contains(&self.max_connections)
            || !(1..=1024).contains(&self.max_pending_handshakes)
            || self.max_pending_handshakes > self.max_connections
            || !(1..=self.max_pending_handshakes).contains(&self.max_pending_per_ip)
            || !(1..=60).contains(&self.handshake_timeout_seconds)
        {
            return Err("invalid caster connection limits".into());
        }
        Ok(())
    }
}
#[derive(Default)]
struct Counts {
    total: usize,
    pending: usize,
    peers: HashMap<IpAddr, usize>,
}
#[derive(Default, Clone)]
pub(crate) struct Admission(Arc<Mutex<Counts>>);
pub(crate) struct Lease {
    admission: Admission,
    pending: Pending,
}
impl Admission {
    pub fn acquire(&self, ip: IpAddr, limits: &Limits) -> Option<Lease> {
        let ip = crate::security::canonical(ip);
        let mut c = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if c.total >= limits.max_connections
            || c.pending >= limits.max_pending_handshakes
            || c.peers.get(&ip).copied().unwrap_or(0) >= limits.max_pending_per_ip
        {
            return None;
        }
        c.total += 1;
        c.pending += 1;
        *c.peers.entry(ip).or_default() += 1;
        Some(Lease {
            admission: self.clone(),
            pending: Pending(Arc::new(PendingState {
                admission: self.clone(),
                ip,
                pending: AtomicBool::new(true),
            })),
        })
    }
}
#[derive(Clone)]
pub(crate) struct Pending(Arc<PendingState>);
struct PendingState {
    admission: Admission,
    ip: IpAddr,
    pending: AtomicBool,
}
impl Pending {
    pub fn release(&self) {
        if !self.0.pending.swap(false, Ordering::AcqRel) {
            return;
        }
        let mut c = self.0.admission.0.lock().unwrap_or_else(|e| e.into_inner());
        c.pending -= 1;
        if let Some(n) = c.peers.get_mut(&self.0.ip) {
            *n -= 1;
            if *n == 0 {
                c.peers.remove(&self.0.ip);
            }
        }
    }
}
impl Lease {
    pub fn pending(&self) -> Pending {
        self.pending.clone()
    }
    pub fn is_pending(&self) -> bool {
        self.pending.0.pending.load(Ordering::Acquire)
    }
    pub fn authenticated(&self) {
        self.pending.release();
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.authenticated();
        self.admission
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .total -= 1;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_and_total_limits_release_on_authentication_and_drop() {
        let a = Admission::default();
        let limits = Limits {
            max_connections: 3,
            max_pending_handshakes: 2,
            max_pending_per_ip: 1,
            ..Limits::default()
        };
        let ip = "192.0.2.1".parse().unwrap();
        let first = a.acquire(ip, &limits).unwrap();
        assert!(a
            .acquire("::ffff:192.0.2.1".parse().unwrap(), &limits)
            .is_none());
        let second = a.acquire("192.0.2.2".parse().unwrap(), &limits).unwrap();
        assert!(a.acquire("192.0.2.3".parse().unwrap(), &limits).is_none());
        first.authenticated();
        let third = a.acquire(ip, &limits).unwrap();
        assert!(a.acquire("192.0.2.3".parse().unwrap(), &limits).is_none());
        drop(second);
        assert!(a.acquire("192.0.2.2".parse().unwrap(), &limits).is_some());
        drop((first, third));
        assert_eq!(a.0.lock().unwrap().total, 0);
        assert!(a.0.lock().unwrap().peers.is_empty());
    }
}
