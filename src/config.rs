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
}

/// Rover accounts. A nonempty list replaces the legacy shared credentials.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct User {
    pub username: String,
    pub password: String,
    #[serde(default = "default_true")]
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
        serde_json::from_str(text)
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let text = fs::read_to_string(path).map_err(|err| err.to_string())?;
        Self::parse(&text).map_err(|err| err.to_string())
    }

    pub fn requires_auth(&self) -> bool {
        !self.users.is_empty() || !self.username.is_empty() || !self.password.is_empty()
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
