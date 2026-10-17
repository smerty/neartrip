//! NearTRIP NTRIP listener. The admin UI stays a separate Node process.
#![forbid(unsafe_code)]

use std::env;
use std::path::PathBuf;
use std::time::Duration;

use neartrip::config::{publish_reload, Config};
use neartrip::registry::Registry;
use neartrip::server::serve;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::info;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let path = env::var("NEARTRIP_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("config.json"));
    let config = Config::load(&path).unwrap_or_else(|err| {
        eprintln!("could not load {}: {err}", path.display());
        std::process::exit(1);
    });

    let sessions_path = env::var("NEARTRIP_SESSIONS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("logs/sessions.json"));
    let registry = Arc::new(Registry::new(sessions_path));
    registry.flush();

    let listener = TcpListener::bind((config.interface.as_str(), config.port))
        .await
        .unwrap_or_else(|err| {
            eprintln!(
                "could not bind {}:{}: {err}",
                config.interface, config.port
            );
            std::process::exit(1);
        });
    info!(
        addr = %listener.local_addr().map(|a| a.to_string()).unwrap_or_default(),
        mount = %config.mount_point,
        stations = config.stations.len(),
        "NearTRIP core listening"
    );

    let (config_tx, config_rx) = watch::channel(config);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let reload_path = path.clone();
    tokio::spawn(async move {
        let mut last_modified = std::fs::metadata(&reload_path).and_then(|m| m.modified()).ok();
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let modified = std::fs::metadata(&reload_path).and_then(|m| m.modified()).ok();
            if modified == last_modified {
                continue;
            }
            last_modified = modified;
            match std::fs::read_to_string(&reload_path) {
                Ok(text) => publish_reload(&config_tx, &text),
                Err(err) => tracing::error!(%err, "config reload failed; keeping previous"),
            }
        }
    });

    registry.start_snapshots();

    tokio::spawn(async move {
        shutdown_signal().await;
        info!("shutdown requested");
        let _ = shutdown_tx.send(true);
    });

    serve(listener, config_rx, registry.clone(), shutdown_rx).await;
    registry.flush();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut sig) = signal(SignalKind::terminate()) {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}
