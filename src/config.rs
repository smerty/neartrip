//! `config.json` shared with the Node admin UI.
use std::fs;
use std::path::Path;

use serde::Deserialize;
use tokio::sync::watch;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub users: Vec<User>,
    #[serde(default)]
    pub members: Vec<Member>,
    #[serde(default = "default_interface")]
    pub interface: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_mount")]
    pub mount_point: String,
    #[serde(default = "default_agent")]
    pub user_agent: String,
    #[serde(default)]
    pub stations: Vec<Station>,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub security: crate::security::Policy,
}

/// Rover accounts. A nonempty list replaces the legacy shared credentials.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct User {
    pub username: String,
    pub password: String,
    #[serde(default = "default_true")]
    pub active: bool,
    #[serde(default)]
    pub owner: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Member {
    pub username: String,
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Station {
    pub mount_point: String,
    pub caster_host: String,
    pub caster_port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    pub latitude: f64,
    pub longitude: f64,
    #[serde(default = "default_true")]
    pub active: bool,
}

/// Direct publishers use credentials separate from rover accounts.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub mount_point: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub latitude: Option<f64>,
    #[serde(default)]
    pub longitude: Option<f64>,
    #[serde(default = "default_settling")]
    pub settling_seconds: u64,
    #[serde(default = "default_tolerance")]
    pub position_tolerance_m: f64,
    #[serde(default = "default_true")]
    pub active: bool,
}

fn default_settling() -> u64 {
    60
}
fn default_tolerance() -> f64 {
    5.0
}

fn default_interface() -> String {
    "0.0.0.0".to_string()
}

fn default_port() -> u16 {
    2101
}

fn default_mount() -> String {
    "NEAR-Default".to_string()
}

fn default_agent() -> String {
    "NearTRIP/1.0".to_string()
}

fn default_true() -> bool {
    true
}

impl Config {
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        let config: Self = serde_json::from_str(text)?;
        config.validate().map_err(serde::de::Error::custom)?;
        Ok(config)
    }

    pub fn user_enabled(&self, user: &User) -> bool {
        user.active
            && user
                .owner
                .as_ref()
                .map(|owner| {
                    self.members
                        .iter()
                        .any(|m| &m.username == owner && m.active)
                })
                .unwrap_or(true)
    }

    fn validate(&self) -> Result<(), String> {
        self.security.validate()?;
        let mut member_names = std::collections::HashSet::new();
        for member in &self.members {
            if member.username.is_empty() || !member_names.insert(&member.username) {
                return Err("invalid or duplicate member".into());
            }
        }
        let mut usernames = std::collections::HashSet::new();
        for user in &self.users {
            if user
                .owner
                .as_ref()
                .is_some_and(|owner| !member_names.contains(owner))
                || user.username.is_empty()
                || user.username.len() > 64
                || matches!(user.username.as_str(), "." | "..")
                || !user
                    .username
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-.@".contains(&b))
                || user.password.is_empty()
                || user.password.len() > 256
                || !usernames.insert(&user.username)
            {
                return Err("invalid or duplicate rover account".into());
            }
        }

        let mut mounts = std::collections::HashSet::new();
        mounts.insert(self.mount_point.as_str());
        for station in &self.stations {
            mounts.insert(station.mount_point.as_str());
        }
        for source in &self.sources {
            if source.mount_point.is_empty()
                || matches!(source.mount_point.as_str(), "." | "..")
                || !source
                    .mount_point
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
                || !mounts.insert(source.mount_point.as_str())
            {
                return Err(
                    "source mountpoints must be unique, cannot be . or .., and must use letters, digits, _, - or .".into(),
                );
            }
            if source.password.is_empty() {
                return Err("source password must not be empty".into());
            }
            if source.settling_seconds > 86400 {
                return Err("settlingSeconds must be between 0 and 86400".into());
            }
            if !source.position_tolerance_m.is_finite()
                || source.position_tolerance_m <= 0.0
                || source.position_tolerance_m > 10000.0
            {
                return Err("positionToleranceM must be greater than 0 and at most 10000".into());
            }
            match (source.latitude, source.longitude) {
                (None, None) => {}
                (Some(lat), Some(lon))
                    if lat.is_finite()
                        && lon.is_finite()
                        && (-90.0..=90.0).contains(&lat)
                        && (-180.0..=180.0).contains(&lon) => {}
                _ => {
                    return Err("source coordinates must be a valid latitude/longitude pair".into())
                }
            }
        }
        Ok(())
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
        Self::parse(&text).map_err(|err| err.to_string())
    }

    pub fn requires_auth(&self) -> bool {
        !self.members.is_empty()
            || !self.users.is_empty()
            || !self.username.is_empty()
            || !self.password.is_empty()
    }
}

/// Replace the live config when `text` parses. A bad file leaves the previous value in place.
pub fn publish_reload(tx: &watch::Sender<Config>, text: &str) {
    match Config::parse(text) {
        Ok(config) => {
            tracing::info!(
                mount = %config.mount_point,
                stations = config.stations.len(),
                "configuration reloaded"
            );
            let _ = tx.send(config);
        }
        Err(err) => {
            tracing::error!(%err, "config reload failed; keeping previous");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sample_shape_and_defaults_active() {
        let raw = r#"{
            "username": "you",
            "password": "secret",
            "mountPoint": "NEAR",
            "stations": [{
                "mountPoint": "A",
                "casterHost": "caster.example",
                "casterPort": 2101,
                "latitude": 10.0,
                "longitude": 20.0
            }]
        }"#;
        let config = Config::parse(raw).unwrap();
        assert!(config.requires_auth());
        assert_eq!(config.mount_point, "NEAR");
        assert!(config.stations[0].active);
        assert_eq!(config.port, 2101);
    }

    #[test]
    fn validates_source_coordinates_credentials_and_namespaces() {
        let valid = r#"{"mountPoint":"NEAR","sources":[{"mountPoint":"BASE","username":"b","password":"s","latitude":0,"longitude":0}]}"#;
        assert!(Config::parse(valid).is_ok());
        for invalid in [
            valid.replace("\"mountPoint\":\"BASE\"", "\"mountPoint\":\"NEAR\""),
            valid.replace("\"mountPoint\":\"BASE\"", "\"mountPoint\":\".\""),
            valid.replace("\"mountPoint\":\"BASE\"", "\"mountPoint\":\"..\""),
            valid.replace("\"latitude\":0", "\"latitude\":91"),
            valid.replace("\"longitude\":0", "\"longitude\":null"),
            valid.replace("\"password\":\"s\"", "\"password\":\"\""),
            valid.replace("\"mountPoint\":\"BASE\"", "\"mountPoint\":\"bad/name\""),
        ] {
            assert!(Config::parse(&invalid).is_err(), "{invalid}");
        }
        let parsed = Config::parse(valid).unwrap();
        let (tx, rx) = watch::channel(parsed.clone());
        publish_reload(&tx, &valid.replace("\"latitude\":0", "\"latitude\":91"));
        assert_eq!(*rx.borrow(), parsed);
    }

    #[test]
    fn onboarding_defaults_and_bounds_are_validated() {
        let raw = r#"{"sources":[{"mountPoint":"BASE","username":"b","password":"s"}]}"#;
        let source = Config::parse(raw).unwrap().sources.remove(0);
        assert_eq!(source.settling_seconds, 60);
        assert_eq!(source.position_tolerance_m, 5.0);
        for fields in [
            r#","settlingSeconds":-1"#,
            r#","settlingSeconds":1.5"#,
            r#","settlingSeconds":86401"#,
            r#","settlingSeconds":null"#,
            r#","positionToleranceM":0"#,
            r#","positionToleranceM":10001"#,
        ] {
            let invalid = raw.replace(r#""password":"s""#, &format!(r#""password":"s"{fields}"#));
            assert!(Config::parse(&invalid).is_err(), "{invalid}");
        }
        let zero = raw.replace(r#""password":"s""#, r#""password":"s","settlingSeconds":0"#);
        assert_eq!(Config::parse(&zero).unwrap().sources[0].settling_seconds, 0);
    }

    #[test]
    fn failed_reload_keeps_the_previous_config() {
        let current = Config::parse(
            r#"{"mountPoint":"KEEP","stations":[{"mountPoint":"A","casterHost":"h","casterPort":2101,"latitude":1.0,"longitude":2.0}]}"#,
        )
        .unwrap();
        let (tx, rx) = watch::channel(current);
        publish_reload(&tx, "{");
        assert_eq!(rx.borrow().mount_point, "KEEP");
        assert_eq!(rx.borrow().stations.len(), 1);
    }
}
