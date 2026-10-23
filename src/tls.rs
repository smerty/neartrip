//! Load and hot-reload PEM certificate material for NTRIPS.
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;
use tokio::sync::RwLock;
use tokio_rustls::TlsAcceptor;

/// Reloading TLS acceptor backed by on-disk PEM files.
pub struct ReloadingAcceptor {
    cert_file: PathBuf,
    key_file: PathBuf,
    acceptor: RwLock<TlsAcceptor>,
    stamp: RwLock<(SystemTime, SystemTime)>,
}

impl ReloadingAcceptor {
    pub fn load(cert_file: impl Into<PathBuf>, key_file: impl Into<PathBuf>) -> Result<Self, String> {
        let cert_file = cert_file.into();
        let key_file = key_file.into();
        let config = load_server_config(&cert_file, &key_file)?;
        let stamp = file_stamps(&cert_file, &key_file)?;
        Ok(Self {
            cert_file,
            key_file,
            acceptor: RwLock::new(TlsAcceptor::from(Arc::new(config))),
            stamp: RwLock::new(stamp),
        })
    }

    /// Rebuild the acceptor when either PEM file changes. Returns true when reloaded.
    pub async fn refresh_if_changed(&self) -> Result<bool, String> {
        let next = file_stamps(&self.cert_file, &self.key_file)?;
        {
            let current = self.stamp.read().await;
            if *current == next {
                return Ok(false);
            }
        }
        let config = load_server_config(&self.cert_file, &self.key_file)?;
        *self.acceptor.write().await = TlsAcceptor::from(Arc::new(config));
        *self.stamp.write().await = next;
        Ok(true)
    }

    pub async fn acceptor(&self) -> TlsAcceptor {
        self.acceptor.read().await.clone()
    }
}

pub fn load_server_config(cert_file: &Path, key_file: &Path) -> Result<ServerConfig, String> {
    let certs = load_certs(cert_file)?;
    let key = load_key(key_file)?;
    ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|err| format!("invalid TLS certificate/key: {err}"))
}

fn load_certs(path: &Path) -> Result<Vec<CertificateDer<'static>>, String> {
    let file = File::open(path).map_err(|err| format!("open {}: {err}", path.display()))?;
    let mut reader = BufReader::new(file);
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("parse {}: {err}", path.display()))?;
    if certs.is_empty() {
        return Err(format!("no certificates in {}", path.display()));
    }
    Ok(certs)
}

fn load_key(path: &Path) -> Result<PrivateKeyDer<'static>, String> {
    let file = File::open(path).map_err(|err| format!("open {}: {err}", path.display()))?;
    let mut reader = BufReader::new(file);
    rustls_pemfile::private_key(&mut reader)
        .map_err(|err| format!("parse {}: {err}", path.display()))?
        .ok_or_else(|| format!("no private key in {}", path.display()))
}

fn file_stamps(cert_file: &Path, key_file: &Path) -> Result<(SystemTime, SystemTime), String> {
    let cert = std::fs::metadata(cert_file)
        .and_then(|m| m.modified())
        .map_err(|err| format!("stat {}: {err}", cert_file.display()))?;
    let key = std::fs::metadata(key_file)
        .and_then(|m| m.modified())
        .map_err(|err| format!("stat {}: {err}", key_file.display()))?;
    Ok((cert, key))
}
