//! Routines API and one-shot scheduling behavior.

mod common;
use common::OrgdHandle;
use tempfile::{Builder, TempDir};

fn org_root() -> TempDir {
    Builder::new().prefix("orgd-test-").tempdir().unwrap()
}

fn write_routine(root: &TempDir, name: &str, content: &str) {
    let dir = root.path().join("routines");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.md")), content).unwrap();
}

async fn wait_for_run(h: &OrgdHandle, id: &str) -> serde_json::Value {
    for _ in 0..40 {
        let resp = h.get(&format!("/v1/runs/{id}")).await;
        let body: serde_json::Value = resp.json().await.unwrap();
        if body["status"] != "running" {
            return body;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("run did not finish");
}

#[tokio::test]
async fn manual_trigger_persists_run_record_with_step_context() {
    let root = org_root();
    write_routine(&root, "hello", r#"---
type: routine
status: enabled
concurrency: skip
steps:
  - id: say
    run: "echo hello-routine"
---

# Hello
"#);
    let h = OrgdHandle::spawn(Some(root.path()));

    let resp = h.post_json("/v1/routines/hello/trigger", &serde_json::json!({})).await;
    assert!(resp.status().is_success(), "status: {}", resp.status());
    let started: serde_json::Value = resp.json().await.unwrap();
    let finished = wait_for_run(&h, started["id"].as_str().unwrap()).await;

    assert_eq!(finished["status"], "ok");
    assert_eq!(finished["steps"][0]["id"], "say");
    assert!(finished["context"]["steps"]["say"]["stdout"].as_str().unwrap().contains("hello-routine"));
}

#[tokio::test]
async fn past_run_at_fires_once_and_marks_routine_completed() {
    let root = org_root();
    write_routine(&root, "once", r#"---
type: routine
status: enabled
run-at: "2000-01-01T00:00:00Z"
concurrency: skip
steps:
  - id: write_marker
    write: "marker.txt"
    content: "fired {{ run.id }}"
---

# One shot
"#);

    {
        let h = OrgdHandle::spawn(Some(root.path()));
        for _ in 0..40 {
            if root.path().join("marker.txt").exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(root.path().join("marker.txt").exists(), "one-shot marker was not written");
        let runs: serde_json::Value = h.get("/v1/routines/once/runs?limit=10").await.json().await.unwrap();
        assert_eq!(runs.as_array().unwrap().len(), 1);
    }

    let routine_text = std::fs::read_to_string(root.path().join("routines").join("once.md")).unwrap();
    assert!(routine_text.contains("status: completed"), "routine was not marked completed:\n{routine_text}");

    {
        let h = OrgdHandle::spawn(Some(root.path()));
        tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        let runs: serde_json::Value = h.get("/v1/routines/once/runs?limit=10").await.json().await.unwrap();
        assert_eq!(runs.as_array().unwrap().len(), 1, "completed one-shot re-fired after restart");
    }
}
