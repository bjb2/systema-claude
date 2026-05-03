//! PTY lifecycle: create → write → buffer → kill. Uses cmd.exe on
//! Windows / sh on POSIX so the test stays self-contained.

mod common;
use common::OrgdHandle;

#[tokio::test]
async fn pty_create_write_buffer_kill_round_trip() {
    let h = OrgdHandle::spawn(None);

    let (shell, cwd) = if cfg!(windows) {
        ("cmd.exe", "C:\\")
    } else {
        ("/bin/sh", "/")
    };

    let resp = h.post_json("/v1/pty", &serde_json::json!({
        "shell": shell,
        "cwd": cwd,
    })).await;
    assert!(resp.status().is_success(), "create status: {}", resp.status());
    let body: serde_json::Value = resp.json().await.unwrap();
    let pty_id = body["pty_id"].as_u64().expect("pty_id");

    // Write a marker line. PowerShell-style banners + cmd's prompt land
    // in the buffer too; we only need to find OUR marker substring.
    let cmd = if cfg!(windows) { "echo HELLO_FROM_TEST\r\n" } else { "echo HELLO_FROM_TEST\n" };
    let resp = h.post_json(
        &format!("/v1/pty/{}/write", pty_id),
        &serde_json::json!({"data": cmd}),
    ).await;
    assert!(resp.status().is_success());

    // Poll the buffer for up to ~3s.
    let mut found = false;
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let resp = h.get(&format!("/v1/pty/{}/buffer", pty_id)).await;
        let body: serde_json::Value = resp.json().await.unwrap();
        let data = body["data"].as_str().unwrap_or("");
        if data.contains("HELLO_FROM_TEST") { found = true; break; }
    }
    assert!(found, "marker never appeared in PTY buffer");

    // Resize is fire-and-forget.
    let resp = h.post_json(
        &format!("/v1/pty/{}/resize", pty_id),
        &serde_json::json!({"rows": 30u16, "cols": 100u16}),
    ).await;
    assert!(resp.status().is_success());

    // Kill and verify buffer goes empty.
    let resp = h.delete(&format!("/v1/pty/{}", pty_id)).await;
    assert!(resp.status().is_success());

    let resp = h.get(&format!("/v1/pty/{}/buffer", pty_id)).await;
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["data"].as_str().unwrap_or(""), "", "buffer should be empty after kill");
}
