use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct InstanceInfo {
    pub port: u16,
    pub pid: u32,
    pub token: String,
    pub version: String,
}

#[derive(Clone)]
pub struct OrgdClient {
    info: Arc<InstanceInfo>,
    http: reqwest::Client,
}

impl OrgdClient {
    pub fn base_url(&self) -> String { format!("http://127.0.0.1:{}", self.info.port) }
    pub fn token(&self) -> &str { &self.info.token }

    /// Discover or spawn a local orgd instance and return a client.
    /// orgd's single-instance protocol means a second invocation just
    /// prints the live instance's info to stdout and exits 0.
    pub fn start_or_attach(org_root: &std::path::Path) -> Result<Self, String> {
        let exe = locate_orgd()?;
        let mut child = spawn_detached(&exe, org_root)?;
        let stdout = child.stdout.take().ok_or_else(|| "orgd stdout missing".to_string())?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();

        // First non-empty line is the InstanceInfo JSON.
        for _ in 0..40 {
            line.clear();
            let n = reader.read_line(&mut line).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            if let Ok(info) = serde_json::from_str::<InstanceInfo>(trimmed) {
                let http = reqwest::Client::builder()
                    .timeout(Duration::from_secs(10))
                    .build()
                    .map_err(|e| e.to_string())?;
                return Ok(Self { info: Arc::new(info), http });
            }
        }
        Err(format!("orgd handshake failed; last line: {}", line.trim()))
    }

    pub async fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        let url = format!("{}{}", self.base_url(), path);
        let resp = self.http.get(&url)
            .bearer_auth(self.token())
            .send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("{status}: {body}"));
        }
        serde_json::from_str::<T>(&body).map_err(|e| e.to_string())
    }

    pub async fn post<B: Serialize, T: serde::de::DeserializeOwned>(
        &self, path: &str, body: &B,
    ) -> Result<T, String> {
        let url = format!("{}{}", self.base_url(), path);
        let resp = self.http.post(&url)
            .bearer_auth(self.token())
            .json(body)
            .send().await.map_err(|e| e.to_string())?;
        let status = resp.status();
        let raw = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("{status}: {raw}"));
        }
        if raw.is_empty() {
            // Endpoints returning () still need to deserialize to T = ().
            // Use null literal for unit types.
            return serde_json::from_str::<T>("null").map_err(|e| e.to_string());
        }
        serde_json::from_str::<T>(&raw).map_err(|e| e.to_string())
    }

    pub async fn delete(&self, path: &str) -> Result<(), String> {
        let url = format!("{}{}", self.base_url(), path);
        let resp = self.http.delete(&url)
            .bearer_auth(self.token())
            .send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("{}: {}", resp.status(), resp.text().await.unwrap_or_default()));
        }
        Ok(())
    }
}

fn locate_orgd() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("ORGD_PATH") {
        let p = PathBuf::from(p);
        if p.is_file() { return Ok(p); }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().ok_or_else(|| "no exe dir".to_string())?;
    let sibling = exe_dir.join(if cfg!(windows) { "orgd.exe" } else { "orgd" });
    if sibling.is_file() { return Ok(sibling); }

    // Walk up looking for a sibling `orgd/target/{release,debug}/orgd[.exe]`.
    // This is the dev-mode path; production builds should ship orgd next to
    // org-viewer.exe so the sibling check above wins.
    let bin_name = if cfg!(windows) { "orgd.exe" } else { "orgd" };
    let mut cursor: Option<&std::path::Path> = Some(exe_dir);
    while let Some(dir) = cursor {
        for profile in ["release", "debug"] {
            let candidate = dir.join("orgd").join("target").join(profile).join(bin_name);
            if candidate.is_file() { return Ok(candidate); }
        }
        cursor = dir.parent();
    }
    Err(format!("orgd binary not found (set ORGD_PATH or place {bin_name} next to org-viewer)"))
}

#[cfg(windows)]
fn spawn_detached(exe: &PathBuf, org_root: &std::path::Path) -> Result<std::process::Child, String> {
    use std::os::windows::process::CommandExt;
    // CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS — survives parent exit.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    Command::new(exe)
        .env("ORG_ROOT", org_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS)
        .spawn()
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn spawn_detached(exe: &PathBuf, org_root: &std::path::Path) -> Result<std::process::Child, String> {
    Command::new(exe)
        .env("ORG_ROOT", org_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())
}

/// Connects to orgd's WS event stream and re-emits each event back into
/// the webview under its existing Tauri event name (pty-output,
/// worker-output, worker-exit) with the same snake_case payload shape
/// the frontend already consumes. Auto-reconnects on transport failure.
///
/// Every emit is gated on `crate::WINDOW_ALIVE`. A stream of `app.emit`
/// calls during webview teardown is the canonical `0x8007139F` flood
/// trigger documented in `knowledge/tools/tauri-webview2-native-crash-diagnosis.md`
/// — without the gate the pump can drive msedge.dll into an internal
/// CHECK and crash the browser process while orgd happily keeps producing
/// events.
pub fn spawn_event_pump(client: OrgdClient, app: AppHandle) {
    use std::sync::atomic::Ordering;
    tauri::async_runtime::spawn(async move {
        loop {
            if !crate::WINDOW_ALIVE.load(Ordering::Relaxed) { break; }
            if let Err(e) = run_pump(&client, &app).await {
                log::warn!("orgd event pump disconnected: {e}");
            }
            if !crate::WINDOW_ALIVE.load(Ordering::Relaxed) { break; }
            tokio::time::sleep(Duration::from_millis(750)).await;
        }
    });
}

async fn run_pump(client: &OrgdClient, app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let url = format!(
        "ws://127.0.0.1:{}/v1/events?token={}",
        client.info.port, client.info.token
    );
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| e.to_string())?;
    let (mut sink, mut stream) = ws.split();

    while let Some(msg) = stream.next().await {
        if !crate::WINDOW_ALIVE.load(Ordering::Relaxed) { break; }
        let msg = msg.map_err(|e| e.to_string())?;
        match msg {
            Message::Text(text) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                let Some(kind) = value.get("type").and_then(|v| v.as_str()) else { continue };
                let mut payload = value.clone();
                if let Some(obj) = payload.as_object_mut() { obj.remove("type"); }
                if !crate::WINDOW_ALIVE.load(Ordering::Relaxed) { break; }
                match kind {
                    "pty-output" | "pty-exit" | "worker-output" | "worker-exit" => {
                        let _ = app.emit(kind, payload);
                    }
                    "org-changed" => {
                        // Frontend listens with no payload, matching the
                        // old Tauri-side notify watcher contract.
                        let _ = app.emit("org-changed", ());
                    }
                    "lag" => {
                        // Tell the webview to refetch buffers. Frontend
                        // can listen for this if it cares; a dropped
                        // frame is rare and self-heals on next mount.
                        let _ = app.emit("orgd-lag", ());
                    }
                    _ => {}
                }
            }
            Message::Ping(p) => { let _ = sink.send(Message::Pong(p)).await; }
            Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(())
}
