//! Conservative peer-IP admission. Runtime observations and automatic bans never persist.
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    sync::Mutex,
};

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Policy {
    pub auto_soft_ban: bool,
    pub failure_threshold: usize,
    pub window_seconds: u64,
    pub soft_ban_seconds: u64,
    pub allowlisted_ips: Vec<IpAddr>,
    pub permanent_bans: Vec<Ban>,
    pub temporary_bans: Vec<TemporaryBan>,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            auto_soft_ban: false,
            failure_threshold: 20,
            window_seconds: 300,
            soft_ban_seconds: 600,
            allowlisted_ips: vec![],
            permanent_bans: vec![],
            temporary_bans: vec![],
        }
    }
}
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ban {
    pub ip: IpAddr,
    #[serde(default)]
    pub reason: String,
}
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TemporaryBan {
    pub ip: IpAddr,
    pub until: u64,
    #[serde(default)]
    pub reason: String,
}
impl Policy {
    pub fn validate(&self) -> Result<(), String> {
        if !(10..=1000).contains(&self.failure_threshold)
            || !(60..=3600).contains(&self.window_seconds)
            || !(60..=86400).contains(&self.soft_ban_seconds)
        {
            return Err("invalid soft-ban threshold or duration".into());
        }
        if self.permanent_bans.len() + self.temporary_bans.len() + self.allowlisted_ips.len()
            > 10000
        {
            return Err("too many IP policy entries".into());
        }
        Ok(())
    }
}
pub fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        other => other,
    }
}
#[derive(Default)]
struct Entry {
    connections: u64,
    failures: u64,
    malformed: u64,
    blocked: u64,
    successes: u64,
    active_authenticated: u64,
    last_seen: u64,
    last_success: Option<u64>,
    recent_failures: VecDeque<u64>,
    automatic_until: Option<u64>,
}
#[derive(Default)]
pub struct Security {
    entries: Mutex<HashMap<IpAddr, Entry>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub ip: String,
    pub connections: u64,
    pub authentication_failures: u64,
    pub malformed_requests: u64,
    pub blocked_connections: u64,
    pub successful_connections: u64,
    pub active_authenticated: u64,
    pub last_seen: u64,
    pub recent_failures: usize,
    pub ban: Option<&'static str>,
    pub until: Option<u64>,
    pub reason: Option<String>,
}
impl Security {
    fn ban(
        ip: IpAddr,
        entry: Option<&Entry>,
        policy: &Policy,
        now: u64,
    ) -> Option<(&'static str, Option<u64>, String)> {
        if let Some(ban) = policy.permanent_bans.iter().find(|b| canonical(b.ip) == ip) {
            return Some(("permanent", None, ban.reason.clone()));
        }
        if let Some(ban) = policy
            .temporary_bans
            .iter()
            .find(|b| canonical(b.ip) == ip && b.until > now)
        {
            return Some(("temporary", Some(ban.until), ban.reason.clone()));
        }
        let exempt = ip.is_loopback()
            || policy
                .allowlisted_ips
                .iter()
                .any(|allow| canonical(*allow) == ip);
        if policy.auto_soft_ban && !exempt {
            if let Some(entry) = entry {
                if entry.active_authenticated == 0 {
                    if let Some(until) = entry.automatic_until.filter(|until| *until > now) {
                        return Some((
                            "automatic",
                            Some(until),
                            "Repeated authentication failures".into(),
                        ));
                    }
                }
            }
        }
        None
    }
    fn entry(entries: &mut HashMap<IpAddr, Entry>, ip: IpAddr, now: u64) -> Option<&mut Entry> {
        if !entries.contains_key(&ip) && entries.len() >= 10000 {
            entries.retain(|_, e| {
                e.active_authenticated > 0 || now.saturating_sub(e.last_seen) < 86400000
            });
            if entries.len() >= 10000 {
                return None;
            }
        }
        Some(entries.entry(ip).or_default())
    }
    pub fn blocked(&self, ip: IpAddr, policy: &Policy, now: u64) -> bool {
        let ip = canonical(ip);
        let entries = self.entries.lock().unwrap();
        Self::ban(ip, entries.get(&ip), policy, now).is_some()
    }
    pub fn admit(&self, ip: IpAddr, policy: &Policy, now: u64) -> bool {
        let ip = canonical(ip);
        let mut entries = self.entries.lock().unwrap();
        let blocked = Self::ban(ip, entries.get(&ip), policy, now).is_some();
        if let Some(entry) = Self::entry(&mut entries, ip, now) {
            entry.connections += 1;
            entry.last_seen = now;
            if blocked {
                entry.blocked += 1;
            }
        }
        !blocked
    }
    pub fn failure(&self, ip: IpAddr, authentication: bool, policy: &Policy, now: u64) {
        let ip = canonical(ip);
        let mut entries = self.entries.lock().unwrap();
        let Some(entry) = Self::entry(&mut entries, ip, now) else {
            return;
        };
        entry.last_seen = now;
        if !authentication {
            entry.malformed += 1;
            return;
        }
        entry.failures += 1;
        while entry
            .recent_failures
            .front()
            .is_some_and(|at| now.saturating_sub(*at) >= policy.window_seconds * 1000)
        {
            entry.recent_failures.pop_front();
        }
        entry.recent_failures.push_back(now);
        while entry.recent_failures.len() > 1000 {
            entry.recent_failures.pop_front();
        }
        let recently_successful = entry
            .last_success
            .is_some_and(|at| now.saturating_sub(at) < 1800000);
        if policy.auto_soft_ban
            && !ip.is_loopback()
            && !policy
                .allowlisted_ips
                .iter()
                .any(|allow| canonical(*allow) == ip)
            && entry.active_authenticated == 0
            && !recently_successful
            && entry.recent_failures.len() >= policy.failure_threshold
        {
            entry.automatic_until = Some(now + policy.soft_ban_seconds * 1000);
            entry.recent_failures.clear();
        }
    }
    pub fn authenticated(&self, ip: IpAddr, now: u64) {
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = Self::entry(&mut entries, canonical(ip), now) {
            entry.successes += 1;
            entry.active_authenticated += 1;
            entry.last_success = Some(now);
            entry.last_seen = now;
            entry.recent_failures.clear();
            entry.automatic_until = None;
        }
    }
    pub fn closed(&self, ip: IpAddr) {
        if let Some(entry) = self.entries.lock().unwrap().get_mut(&canonical(ip)) {
            entry.active_authenticated = entry.active_authenticated.saturating_sub(1);
        }
    }
    pub fn snapshot(&self, policy: &Policy, now: u64) -> Vec<Activity> {
        let mut entries = self.entries.lock().unwrap();
        // Include manually banned addresses even before they make a connection.
        for ip in policy.permanent_bans.iter().map(|b| b.ip).chain(
            policy
                .temporary_bans
                .iter()
                .filter(|b| b.until > now)
                .map(|b| b.ip),
        ) {
            let _ = Self::entry(&mut entries, canonical(ip), now);
        }
        let mut rows: Vec<_> = entries
            .iter()
            .map(|(ip, e)| {
                let ban = Self::ban(*ip, Some(e), policy, now);
                Activity {
                    ip: ip.to_string(),
                    connections: e.connections,
                    authentication_failures: e.failures,
                    malformed_requests: e.malformed,
                    blocked_connections: e.blocked,
                    successful_connections: e.successes,
                    active_authenticated: e.active_authenticated,
                    last_seen: e.last_seen,
                    recent_failures: e
                        .recent_failures
                        .iter()
                        .filter(|at| now.saturating_sub(**at) < policy.window_seconds * 1000)
                        .count(),
                    ban: ban.as_ref().map(|b| b.0),
                    until: ban.as_ref().and_then(|b| b.1),
                    reason: ban.map(|b| b.2),
                }
            })
            .collect();
        rows.sort_by(|a, b| b.last_seen.cmp(&a.last_seen).then(a.ip.cmp(&b.ip)));
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn soft_bans_are_opt_in_temporary_and_do_not_punish_successful_shared_ips() {
        let guard = Security::default();
        let ip = "192.0.2.1".parse().unwrap();
        let mut policy = Policy::default();
        for n in 0..25 {
            guard.failure(ip, true, &policy, n);
        }
        assert!(!guard.blocked(ip, &policy, 26));
        policy.auto_soft_ban = true;
        guard.failure(ip, true, &policy, 30);
        assert!(guard.blocked(ip, &policy, 31));
        assert!(!guard.admit(ip, &policy, 31));
        assert!(!guard.blocked(ip, &policy, 600031));
        guard.authenticated(ip, 700000);
        for n in 0..25 {
            guard.failure(ip, true, &policy, 900000 + n);
        }
        assert!(!guard.blocked(ip, &policy, 900030));
        guard.closed(ip);
        for n in 0..25 {
            guard.failure(ip, true, &policy, 900100 + n);
        }
        assert!(!guard.blocked(ip, &policy, 900130));
        for n in 0..25 {
            guard.failure(ip, false, &policy, 3000000 + n);
        }
        assert!(
            !guard.blocked(ip, &policy, 3000030),
            "malformed requests alone do not cause automatic bans"
        );
    }
    #[test]
    fn explicit_bans_apply_to_mapped_ipv4_and_allowlisted_addresses_still_allow_manual_bans() {
        let guard = Security::default();
        let ip = "192.0.2.2".parse().unwrap();
        let mut policy = Policy {
            auto_soft_ban: true,
            allowlisted_ips: vec![ip],
            ..Policy::default()
        };
        for n in 0..25 {
            guard.failure(ip, true, &policy, n);
        }
        assert!(!guard.blocked(ip, &policy, 30));
        policy.permanent_bans.push(Ban {
            ip,
            reason: "manual".into(),
        });
        assert!(guard.blocked("::ffff:192.0.2.2".parse().unwrap(), &policy, 30));
        policy.permanent_bans.clear();
        policy.temporary_bans.push(TemporaryBan {
            ip,
            reason: "manual".into(),
            until: 100,
        });
        assert!(guard.blocked(ip, &policy, 99));
        assert!(!guard.blocked(ip, &policy, 100));
    }
}
