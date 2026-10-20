//! NearTRIP NTRIP listener. The admin UI stays a separate Node process.
#![forbid(unsafe_code)]

use std::env;
use std::path::PathBuf;
use std::time::Duration;

use neartrip::config::{publish_reload, Config};
use neartrip::registry::Registry;
use neartrip::{caster::Hub, server::serve_with_hub};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tracing::info;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let path = env::var("NEARTRIP_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("config.json"));
    let config = Config::load(&path).unwrap_or_else(|err| {
        eprintln!("could not load {}: {err}", path.display());
        std::process::exit(1);
    });

    let listener = TcpListener::bind((config.interface.as_str(), config.port))
        .await
        .unwrap_or_else(|err| {
            eprintln!("could not bind {}:{}: {err}", config.interface, config.port);
            std::process::exit(1);
        });
    let sessions_path = env::var("NEARTRIP_SESSIONS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("logs/sessions.json"));
    let registry = Arc::new(Registry::new(sessions_path));
    registry.flush();

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
        let mut last_modified = std::fs::metadata(&reload_path)
            .and_then(|m| m.modified())
            .ok();
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let modified = std::fs::metadata(&reload_path)
                .and_then(|m| m.modified())
                .ok();
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

    let hub = Arc::new(Hub::default());
    let health_path = env::var("NEARTRIP_SOURCES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("logs/sources.json"));
    let health_task = tokio::spawn(hub.clone().snapshots(
        health_path,
        config_rx.clone(),
        shutdown_rx.clone(),
    ));
    let operations_path = env::var("NEARTRIP_OPERATIONS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("logs/operations.json"));
    let op_registry = registry.clone();
    let op_config = config_rx.clone();
    let mut op_shutdown = shutdown_rx.clone();
    let operations_task = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! { _ = interval.tick() => {}, _ = op_shutdown.changed() => break }
            let data = op_registry.operations(&op_config.borrow());
            let path = operations_path.clone();
            let result = tokio::task::spawn_blocking(move || {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let nonce = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let temp = path.with_extension(format!("{}.{}.tmp", std::process::id(), nonce));
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&temp)?;
                use std::io::Write;
                let result = file
                    .write_all(data.to_string().as_bytes())
                    .and_then(|_| std::fs::rename(&temp, &path));
                if result.is_err() {
                    let _ = std::fs::remove_file(temp);
                }
                result
            })
            .await;
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => tracing::warn!(%error, "operations snapshot failed"),
                Err(error) => tracing::warn!(%error, "operations snapshot task failed"),
            }
        }
        let _ = tokio::fs::remove_file(operations_path).await;
    });
    serve_with_hub(listener, config_rx, registry.clone(), shutdown_rx, hub).await;
    let _ = health_task.await;
    let _ = operations_task.await;
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
