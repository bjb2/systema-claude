//! WebSocket event stream — confirms PTY output flows from the
//! broadcast bus into a connected subscriber.

mod common;
use common::OrgdHandle;

use futures_util::StreamExt;
use std::time::Duration;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

#[tokio::test]
async fn ws_emits_pty_output_for_connected_subscriber() {
    let h = OrgdHandle::spawn(None);

    // Connect first so we don't miss output.
    let url = format!("ws://127.0.0.1:{}/v1/events?token={}", h.port(), h.token());
    let (ws, _) = tokio_tungstenite::connect_async(&url).await
        .expect("ws connect");
    let (_, mut stream) = ws.split();

    // Spawn a PTY that prints a marker.
    let (shell, cwd) = if cfg!(windows) {
        ("cmd.exe", "C:\\")
    } else {
        ("/bin/sh", "/")
    };
    let resp = h.post_json("/v1/pty", &serde_json::json!({
        "shell": shell, "cwd": cwd,
    })).await;
    let body: serde_json::Value = resp.json().await.unwrap();
    let pty_id = body["pty_id"].as_u64().unwrap();

    let cmd = if cfg!(windows) { "echo WS_MARKER\r\n" } else { "echo WS_MARKER\n" };
    let _ = h.post_json(
        &format!("/v1/pty/{}/write", pty_id),
        &serde_json::json!({"data": cmd}),
    ).await;

    // Read up to a few seconds worth of frames; assert at least one
    // `pty-output` envelope referencing our pty_id contains the marker.
    let deadline = Duration::from_secs(5);
    let mut found = false;
    let _ = timeout(deadline, async {
        while let Some(Ok(msg)) = stream.next().await {
            if let Message::Text(text) = msg {
                let value: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if value["type"] == "pty-output"
                    && value["pty_id"].as_u64() == Some(pty_id)
                    && value["data"].as_str().unwrap_or("").contains("WS_MARKER")
                {
                    found = true;
                    break;
                }
            }
        }
    }).await;

    assert!(found, "WS_MARKER never arrived on the WS event stream");
}

#[tokio::test]
async fn ws_rejects_wrong_token() {
    let h = OrgdHandle::spawn(None);
    let url = format!("ws://127.0.0.1:{}/v1/events?token=not-the-token", h.port());
    let result = tokio_tungstenite::connect_async(&url).await;
    assert!(result.is_err(), "WS handshake should fail with wrong token");
}
