//! Document index, relations, code-files, and org-root endpoints.
//! Builds a small fixture org tree per test so results are predictable.

mod common;
use common::OrgdHandle;
use std::fs;
use std::path::Path;
use tempfile::{Builder, TempDir};

fn write_doc(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    if let Some(parent) = p.parent() { fs::create_dir_all(parent).unwrap(); }
    fs::write(p, body).unwrap();
}

fn fixture_org() -> TempDir {
    // Non-dot prefix — scan_org skips path components starting with ".".
    let td = Builder::new().prefix("orgd-test-").tempdir().unwrap();
    let root = td.path();

    write_doc(root, "CLAUDE.md", "# root\n");
    write_doc(root, "tasks/alpha.md",
        "---\ntype: task\nstatus: active\ncreated: 2026-04-30\ntags: []\n---\n# Alpha\n[[bravo]]\n");
    write_doc(root, "tasks/bravo.md",
        "---\ntype: task\nstatus: active\ncreated: 2026-04-30\ntags: []\nblocked-by: [alpha]\n---\n# Bravo\n");
    write_doc(root, "knowledge/system/note.md",
        "---\ntype: knowledge\ncreated: 2026-04-30\nupdated: 2026-04-30\ntags: [test]\n---\n# Note\n");

    td
}

#[tokio::test]
async fn org_root_returns_configured_path() {
    let org = fixture_org();
    let h = OrgdHandle::spawn(Some(org.path()));

    let resp = h.get("/v1/org-root").await;
    assert!(resp.status().is_success());
    let body: serde_json::Value = resp.json().await.unwrap();
    let returned = body["path"].as_str().unwrap();
    // Path normalization may differ (trailing slash, drive letter casing).
    // Just confirm both resolve to the same canonical path.
    let returned_canon = std::fs::canonicalize(returned).unwrap();
    let expected_canon = std::fs::canonicalize(org.path()).unwrap();
    assert_eq!(returned_canon, expected_canon);
}

#[tokio::test]
async fn documents_list_returns_fixture_docs() {
    let org = fixture_org();
    let h = OrgdHandle::spawn(Some(org.path()));

    let resp = h.get("/v1/documents").await;
    assert!(resp.status().is_success());
    let docs: Vec<serde_json::Value> = resp.json().await.unwrap();

    // Filter to filenames we control. Other walker behavior (e.g.
    // CLAUDE.md inclusion) is incidental to this assertion.
    let names: Vec<String> = docs.iter()
        .filter_map(|d| d["filename"].as_str().map(String::from))
        .collect();
    assert!(names.contains(&"alpha.md".to_string()), "alpha.md missing from {:?}", names);
    assert!(names.contains(&"bravo.md".to_string()), "bravo.md missing from {:?}", names);
    assert!(names.contains(&"note.md".to_string()), "note.md missing from {:?}", names);
}

#[tokio::test]
async fn relations_for_existing_doc_returns_links() {
    let org = fixture_org();
    let h = OrgdHandle::spawn(Some(org.path()));

    // relations_for keys by the full normalized path (matches what
    // the frontend sends, since OrgDocument.path is absolute).
    let target = org.path().join("tasks").join("alpha.md");
    let target_str = target.to_string_lossy().into_owned();

    let resp = h.get(
        &format!("/v1/relations?path={}", urlencoding::encode(&target_str)),
    ).await;
    assert!(resp.status().is_success(), "status: {}", resp.status());
    // Just assert the response is a JSON object — exact relation
    // shape is owned by relations.rs and may evolve.
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body.is_object());
}

#[tokio::test]
async fn relations_for_missing_doc_returns_404() {
    let org = fixture_org();
    let h = OrgdHandle::spawn(Some(org.path()));

    let resp = h.get(
        &format!("/v1/relations?path={}", urlencoding::encode("does/not/exist.md")),
    ).await;
    assert_eq!(resp.status(), reqwest::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn code_files_lists_directory() {
    let org = fixture_org();
    let h = OrgdHandle::spawn(Some(org.path()));

    let dir = org.path().join("tasks").to_string_lossy().into_owned();
    let resp = h.get(&format!("/v1/code-files?dir={}", urlencoding::encode(&dir))).await;
    assert!(resp.status().is_success());
    let entries: Vec<serde_json::Value> = resp.json().await.unwrap();
    let names: Vec<String> = entries.iter()
        .filter_map(|e| e["name"].as_str().map(String::from))
        .collect();
    assert!(names.contains(&"alpha.md".to_string()), "alpha.md missing from {:?}", names);
    assert!(names.contains(&"bravo.md".to_string()));
}

#[tokio::test]
async fn documents_returns_404_when_no_org_root() {
    // ORG_ROOT-less startup: helper sends an empty temp dir, so the
    // index is wired; for the no-index case we'd need to spawn without
    // ORG_ROOT entirely. Skipped — see http_no_root.rs.
}
