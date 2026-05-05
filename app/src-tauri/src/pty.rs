//! Tauri-side proxy. The PTY itself lives in orgd; this module just
//! forwards the existing pty_* commands over HTTP so the frontend
//! contract stays identical.

use serde::{Deserialize, Serialize};

use crate::orgd_client::OrgdClient;

#[derive(Serialize)]
struct CreateBody { shell: String, args: Option<Vec<String>>, cwd: String }

#[derive(Deserialize)]
struct CreateResp { pty_id: u32 }

#[derive(Serialize)]
struct WriteBody { data: String }

#[derive(Serialize)]
struct ResizeBody { rows: u16, cols: u16 }

#[derive(Deserialize)]
struct BufferResp { data: String }

#[tauri::command]
pub async fn pty_create(
    shell: String,
    args: Option<Vec<String>>,
    cwd: String,
    client: tauri::State<'_, OrgdClient>,
) -> Result<u32, String> {
    let resp: CreateResp = client.post("/v1/pty", &CreateBody { shell, args, cwd }).await?;
    Ok(resp.pty_id)
}

#[tauri::command]
pub async fn pty_buffer(
    pty_id: u32,
    client: tauri::State<'_, OrgdClient>,
) -> Result<String, String> {
    let resp: BufferResp = client.get(&format!("/v1/pty/{pty_id}/buffer")).await?;
    Ok(resp.data)
}

#[tauri::command]
pub async fn pty_write(
    pty_id: u32,
    data: String,
    client: tauri::State<'_, OrgdClient>,
) -> Result<(), String> {
    let _: serde_json::Value =
        client.post(&format!("/v1/pty/{pty_id}/write"), &WriteBody { data }).await?;
    Ok(())
}

#[tauri::command]
pub async fn pty_resize(
    pty_id: u32,
    rows: u16,
    cols: u16,
    client: tauri::State<'_, OrgdClient>,
) -> Result<(), String> {
    let _: serde_json::Value =
        client.post(&format!("/v1/pty/{pty_id}/resize"), &ResizeBody { rows, cols }).await?;
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(
    pty_id: u32,
    client: tauri::State<'_, OrgdClient>,
) -> Result<(), String> {
    client.delete(&format!("/v1/pty/{pty_id}")).await
}

/// Lists the PTYs orgd currently has alive. Used on org-viewer mount to
/// reconcile localStorage tile state — any tile whose persisted `ptyId`
/// is missing from this list has been killed (orgd restart, manual
/// taskkill, Claude exited) and should respawn instead of trying to
/// reattach with `pty_buffer`.
#[tauri::command]
pub async fn pty_list(
    client: tauri::State<'_, OrgdClient>,
) -> Result<serde_json::Value, String> {
    client.get::<serde_json::Value>("/v1/pty").await
}
