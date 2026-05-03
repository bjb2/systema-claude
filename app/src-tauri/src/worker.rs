//! Tauri-side proxy. The worker process itself lives in orgd; this
//! module just forwards the existing worker_* commands over HTTP so
//! the frontend contract stays identical.

use serde::{Deserialize, Serialize};

use crate::orgd_client::OrgdClient;

#[derive(Serialize)]
struct StartBody { command: String, args: Vec<String>, cwd: String, stdin: Option<String> }

#[derive(Deserialize)]
struct StartResp { worker_id: u32 }

#[derive(Deserialize)]
struct BufferResp { data: String }

#[derive(Deserialize)]
struct StatusResp { running: bool }

#[tauri::command]
pub async fn worker_start(
    command: String,
    args: Vec<String>,
    cwd: String,
    stdin: Option<String>,
    client: tauri::State<'_, OrgdClient>,
) -> Result<u32, String> {
    let resp: StartResp = client
        .post("/v1/worker", &StartBody { command, args, cwd, stdin })
        .await?;
    Ok(resp.worker_id)
}

#[tauri::command]
pub async fn worker_kill(
    worker_id: u32,
    client: tauri::State<'_, OrgdClient>,
) -> Result<(), String> {
    client.delete(&format!("/v1/worker/{worker_id}")).await
}

#[tauri::command]
pub async fn worker_buffer(
    worker_id: u32,
    client: tauri::State<'_, OrgdClient>,
) -> Result<String, String> {
    let resp: BufferResp = client.get(&format!("/v1/worker/{worker_id}/buffer")).await?;
    Ok(resp.data)
}

#[tauri::command]
pub async fn worker_is_running(
    worker_id: u32,
    client: tauri::State<'_, OrgdClient>,
) -> Result<bool, String> {
    let resp: StatusResp = client.get(&format!("/v1/worker/{worker_id}/status")).await?;
    Ok(resp.running)
}
