//! File-ops surface: write/read/append/copy/move/write-bytes/read-base64.

mod common;
use common::OrgdHandle;
use tempfile::{Builder, TempDir};

fn workdir() -> TempDir {
    Builder::new().prefix("orgd-test-").tempdir().unwrap()
}

fn p(dir: &TempDir, name: &str) -> String {
    dir.path().join(name).to_string_lossy().into_owned()
}

#[tokio::test]
async fn file_write_then_read_round_trips_content() {
    let workdir = workdir();
    let h = OrgdHandle::spawn(None);
    let path = p(&workdir, "hello.txt");

    let resp = h.post_json("/v1/file/write", &serde_json::json!({
        "path": path, "content": "round-trip body",
    })).await;
    assert!(resp.status().is_success());

    let resp = h.get(&format!("/v1/file/read?path={}", urlencoding::encode(&path))).await;
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["content"].as_str().unwrap(), "round-trip body");
}

#[tokio::test]
async fn file_write_creates_missing_parents() {
    let workdir = workdir();
    let h = OrgdHandle::spawn(None);
    let path = p(&workdir, "nested/deeper/file.txt");

    let resp = h.post_json("/v1/file/write", &serde_json::json!({
        "path": path, "content": "x",
    })).await;
    assert!(resp.status().is_success(), "status: {}", resp.status());
    assert!(std::fs::read_to_string(&path).unwrap() == "x");
}

#[tokio::test]
async fn file_append_extends_existing_file() {
    let workdir = workdir();
    let h = OrgdHandle::spawn(None);
    let path = p(&workdir, "log.txt");

    let _ = h.post_json("/v1/file/write", &serde_json::json!({
        "path": path, "content": "first\n",
    })).await;
    let resp = h.post_json("/v1/file/append", &serde_json::json!({
        "path": path, "content": "second\n",
    })).await;
    assert!(resp.status().is_success());

    let on_disk = std::fs::read_to_string(&path).unwrap();
    assert_eq!(on_disk, "first\nsecond\n");
}

#[tokio::test]
async fn file_copy_and_move_preserve_content() {
    let workdir = workdir();
    let h = OrgdHandle::spawn(None);
    let src = p(&workdir, "src.md");
    let copy_dst = p(&workdir, "copy.md");
    let move_dst = p(&workdir, "moved.md");

    let _ = h.post_json("/v1/file/write", &serde_json::json!({
        "path": &src, "content": "payload",
    })).await;

    let resp = h.post_json("/v1/file/copy", &serde_json::json!({
        "src": &src, "dst": &copy_dst,
    })).await;
    assert!(resp.status().is_success());
    assert_eq!(std::fs::read_to_string(&src).unwrap(), "payload");
    assert_eq!(std::fs::read_to_string(&copy_dst).unwrap(), "payload");

    let resp = h.post_json("/v1/file/move", &serde_json::json!({
        "src": &src, "dst": &move_dst,
    })).await;
    assert!(resp.status().is_success());
    assert!(!std::path::Path::new(&src).exists());
    assert_eq!(std::fs::read_to_string(&move_dst).unwrap(), "payload");
}

#[tokio::test]
async fn file_write_bytes_then_read_base64_round_trips() {
    use base64::{Engine as _, engine::general_purpose};

    let workdir = workdir();
    let h = OrgdHandle::spawn(None);
    let path = p(&workdir, "bin.dat");

    // Non-utf8 payload (deliberately includes 0xff) to exercise the
    // bytes path rather than text.
    let bytes: Vec<u8> = vec![0x00, 0xff, 0x7f, 0x80, b'h', b'i'];
    let b64 = general_purpose::STANDARD.encode(&bytes);

    let resp = h.post_json("/v1/file/write-bytes", &serde_json::json!({
        "path": &path, "b64": &b64,
    })).await;
    assert!(resp.status().is_success());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);

    let resp = h.get(&format!("/v1/file/read-base64?path={}", urlencoding::encode(&path))).await;
    let body: serde_json::Value = resp.json().await.unwrap();
    let decoded = general_purpose::STANDARD.decode(body["b64"].as_str().unwrap()).unwrap();
    assert_eq!(decoded, bytes);
}

#[tokio::test]
async fn file_read_missing_returns_error_status() {
    let h = OrgdHandle::spawn(None);
    let path = "C:/nonexistent/definitely/not/here.txt";
    let resp = h.get(&format!("/v1/file/read?path={}", urlencoding::encode(path))).await;
    assert!(resp.status().is_client_error() || resp.status().is_server_error(),
        "expected error status, got {}", resp.status());
}
