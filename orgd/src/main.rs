mod auth;
mod capabilities;
mod documents;
mod events;
mod http;
mod index;
mod lifecycle;
mod pty;
mod relations;
mod routines;
mod state;
mod watcher;
mod worker;
mod ws;

use std::sync::Arc;

use anyhow::Result;
use axum::Router;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::lifecycle::{InstanceInfo, LifecycleGuard};
use crate::state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("orgd=info,tower_http=warn")))
        .init();

    // If an existing instance is healthy, print its info and exit 0.
    // Callers (the Tauri shell) read stdout to discover the running daemon.
    if let Some(existing) = lifecycle::probe_existing().await? {
        println!("{}", serde_json::to_string(&existing)?);
        return Ok(());
    }

    // Acquire single-instance lock. If another process grabs it first
    // we lose the race; re-probe and yield to it.
    let lock = match lifecycle::acquire_lock()? {
        Some(lock) => lock,
        None => {
            if let Some(existing) = lifecycle::probe_existing().await? {
                println!("{}", serde_json::to_string(&existing)?);
                return Ok(());
            }
            anyhow::bail!("could not acquire orgd lock and no live instance found");
        }
    };

    let token = auth::generate_token();
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    let info = InstanceInfo {
        port,
        pid: std::process::id(),
        token: token.clone(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    };
    lifecycle::write_instance_info(&info)?;

    let org_root = std::env::var("ORG_ROOT").ok().map(std::path::PathBuf::from);
    let state = Arc::new(AppState::new(token.clone(), org_root.clone()));

    // The Tauri shell sets ORG_ROOT when spawning orgd. If it's set,
    // start the FS watcher; otherwise we run headless (PTY/worker
    // only) which is fine for tests.
    if let Some(path) = org_root {
        watcher::spawn(path, state.events().clone(), state.index().cloned());
        if let Some(routines) = state.routines() {
            routines.spawn_loop();
        }
    }

    let app = Router::new()
        .merge(http::routes(state.clone()))
        .merge(ws::routes(state.clone()))
        .layer(tower_http::trace::TraceLayer::new_for_http());

    info!(port, pid = info.pid, "orgd listening");
    println!("{}", serde_json::to_string(&info)?);

    // Hold the lock guard for the lifetime of the server.
    let _guard = LifecycleGuard::new(lock);
    axum::serve(listener, app).await?;
    Ok(())
}
