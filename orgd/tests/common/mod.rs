//! Test scaffolding for orgd integration tests.
//!
//! Each test gets its own temp dir for ORGD_DATA_DIR (so the spawned
//! orgd writes its lockfile + info JSON there, not into the user's
//! %LOCALAPPDATA% where the live daemon lives) and an optional ORG_ROOT
//! that's a freshly populated fixture tree.

#![allow(dead_code)] // helpers are used selectively per test file

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use serde::Deserialize;
use tempfile::{Builder, TempDir};

/// Tempdir with a non-dot prefix. orgd's `scan_org` skips any path
/// component starting with `.`, which collides with tempfile's
/// default `.tmp` prefix.
fn org_tempdir() -> TempDir {
    Builder::new().prefix("orgd-test-").tempdir().expect("tempdir")
}

#[derive(Debug, Deserialize, Clone)]
pub struct InstanceInfo {
    pub port: u16,
    pub pid: u32,
    pub token: String,
    pub version: String,
}

/// A spawned orgd instance with isolated data dir + (optional) org root.
/// Drop kills the child and cleans up the temp dirs.
pub struct OrgdHandle {
    pub info: InstanceInfo,
    pub base_url: String,
    pub http: reqwest::Client,
    child: Child,
    _data_dir: TempDir,
    _org_root: Option<TempDir>,
}

impl OrgdHandle {
    /// Spawn orgd with an isolated data dir and optional ORG_ROOT
    /// fixture. Reads the InstanceInfo JSON line from stdout (the
    /// handshake) and returns once the daemon is ready to serve.
    pub fn spawn(org_root: Option<&Path>) -> Self {
        let data_dir = org_tempdir();

        // If caller didn't supply an org root, create an empty one so
        // the watcher path exists — that's harmless to point at.
        let (root_arg, owned_root): (PathBuf, Option<TempDir>) = match org_root {
            Some(p) => (p.to_path_buf(), None),
            None => {
                let td = org_tempdir();
                (td.path().to_path_buf(), Some(td))
            }
        };

        let exe = locate_orgd_binary();
        let mut child = Command::new(&exe)
            .env("ORGD_DATA_DIR", data_dir.path())
            .env("ORG_ROOT", &root_arg)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn orgd");

        // Read the first non-empty line of stdout — orgd prints
        // InstanceInfo there as its handshake.
        let stdout = child.stdout.take().expect("orgd stdout");
        let mut reader = BufReader::new(stdout);
        let mut info: Option<InstanceInfo> = None;
        for _ in 0..40 {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() { continue; }
                    if let Ok(parsed) = serde_json::from_str::<InstanceInfo>(trimmed) {
                        info = Some(parsed);
                        break;
                    }
                    // Some lines are tracing output; keep scanning.
                }
                Err(_) => break,
            }
        }
        let info = info.expect("orgd handshake (InstanceInfo JSON line) not received");
        let base_url = format!("http://127.0.0.1:{}", info.port);
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client");

        Self { info, base_url, http, child, _data_dir: data_dir, _org_root: owned_root }
    }

    pub fn token(&self) -> &str { &self.info.token }
    pub fn port(&self) -> u16 { self.info.port }

    pub async fn get(&self, path: &str) -> reqwest::Response {
        self.http.get(format!("{}{}", self.base_url, path))
            .bearer_auth(self.token())
            .send().await.expect("get")
    }

    pub async fn get_unauth(&self, path: &str) -> reqwest::Response {
        self.http.get(format!("{}{}", self.base_url, path))
            .send().await.expect("get unauth")
    }

    pub async fn post_json<B: serde::Serialize>(&self, path: &str, body: &B) -> reqwest::Response {
        self.http.post(format!("{}{}", self.base_url, path))
            .bearer_auth(self.token())
            .json(body)
            .send().await.expect("post")
    }

    pub async fn delete(&self, path: &str) -> reqwest::Response {
        self.http.delete(format!("{}{}", self.base_url, path))
            .bearer_auth(self.token())
            .send().await.expect("delete")
    }
}

impl Drop for OrgdHandle {
    fn drop(&mut self) {
        // Best effort. On Windows the child might already have exited.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn locate_orgd_binary() -> PathBuf {
    // CARGO_BIN_EXE_<name> is set automatically for integration tests
    // and points at the freshly built test artifact for the named bin.
    if let Some(p) = option_env!("CARGO_BIN_EXE_orgd") {
        return PathBuf::from(p);
    }
    // Fallback for direct cargo test invocations that don't go through
    // the standard test runner (rare). Walk up from current_exe.
    let exe = std::env::current_exe().expect("current_exe");
    let target_dir = exe.ancestors().nth(2).expect("walk up to target/<profile>").to_path_buf();
    let bin = if cfg!(windows) { "orgd.exe" } else { "orgd" };
    let candidate = target_dir.join(bin);
    if candidate.is_file() { return candidate; }
    panic!("could not locate orgd binary; expected at {}", candidate.display());
}
