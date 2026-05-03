//! Worker lifecycle: start a short-lived process, observe its output
//! buffer, watch its exit status flip from running → not running.

mod common;
use common::OrgdHandle;

#[tokio::test]
async fn worker_start_buffer_status_round_trip() {
    let h = OrgdHandle::spawn(None);

    // A command guaranteed to print something and exit fast on both
    // platforms. cmd.exe is the path-resolved name on Windows; "echo"
    // is a builtin and not a PE on its own, so use cmd /c instead.
    let (command, args) = if cfg!(windows) {
        ("cmd.exe", vec!["/c".to_string(), "echo HELLO_FROM_WORKER".to_string()])
    } else {
        ("/bin/sh", vec!["-c".to_string(), "echo HELLO_FROM_WORKER".to_string()])
    };

    let resp = h.post_json("/v1/worker", &serde_json::json!({
        "command": command,
        "args": args,
        "cwd": if cfg!(windows) { "C:\\" } else { "/" },
    })).await;
    assert!(resp.status().is_success(), "start status: {}", resp.status());
    let body: serde_json::Value = resp.json().await.unwrap();
    let worker_id = body["worker_id"].as_u64().expect("worker_id");

    // Poll buffer + status.
    let mut found_marker = false;
    let mut exited = false;
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let resp = h.get(&format!("/v1/worker/{}/buffer", worker_id)).await;
        let body: serde_json::Value = resp.json().await.unwrap();
        if body["data"].as_str().unwrap_or("").contains("HELLO_FROM_WORKER") {
            found_marker = true;
        }

        let resp = h.get(&format!("/v1/worker/{}/status", worker_id)).await;
        let body: serde_json::Value = resp.json().await.unwrap();
        if !body["running"].as_bool().unwrap_or(true) {
            exited = true;
            // Once exited, status fields should be filled in.
            assert_eq!(body["success"].as_bool(), Some(true), "worker should have succeeded");
            break;
        }
    }
    assert!(found_marker, "worker output never reached buffer");
    assert!(exited, "worker never reported exit");

    // Note: we deliberately don't hit DELETE here. On Windows, calling
    // `taskkill /F /PID` against an already-exited (and possibly
    // PID-recycled) worker can block well past reqwest's request
    // timeout. The kill-while-running path is exercised by the PTY
    // tests; an exited worker self-cleans on next process restart.
}
