use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result};
use fs4::FileExt;
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstanceInfo {
    pub port: u16,
    pub pid: u32,
    pub token: String,
    pub version: String,
}

fn data_dir() -> Result<PathBuf> {
    // Test override — integration tests set this to a temp dir per spawn
    // so they don't fight the user's live daemon for orgd.json/orgd.lock.
    if let Ok(p) = std::env::var("ORGD_DATA_DIR") {
        let dir = PathBuf::from(p);
        std::fs::create_dir_all(&dir)?;
        return Ok(dir);
    }
    let base = dirs::data_local_dir().context("could not locate local data dir")?;
    let dir = base.join("org");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn lock_path() -> Result<PathBuf> { Ok(data_dir()?.join("orgd.lock")) }
fn info_path() -> Result<PathBuf> { Ok(data_dir()?.join("orgd.json")) }
fn info_tmp_path() -> Result<PathBuf> { Ok(data_dir()?.join("orgd.json.tmp")) }

/// Try to acquire the exclusive lock. Returns None if another live
/// process holds it.
pub fn acquire_lock() -> Result<Option<File>> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(lock_path()?)?;
    match FileExt::try_lock_exclusive(&lock) {
        Ok(()) => Ok(Some(lock)),
        Err(_) => Ok(None),
    }
}

pub struct LifecycleGuard { _lock: File }
impl LifecycleGuard {
    pub fn new(lock: File) -> Self { Self { _lock: lock } }
}
impl Drop for LifecycleGuard {
    fn drop(&mut self) {
        // Best-effort cleanup; if orgd crashes the next start re-probes.
        if let Ok(p) = info_path() { let _ = std::fs::remove_file(p); }
    }
}

pub fn write_instance_info(info: &InstanceInfo) -> Result<()> {
    let tmp = info_tmp_path()?;
    let mut f = OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
    f.write_all(serde_json::to_string_pretty(info)?.as_bytes())?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, info_path()?)?;
    Ok(())
}

pub fn read_instance_info() -> Result<Option<InstanceInfo>> {
    let p = info_path()?;
    if !p.exists() { return Ok(None); }
    let raw = std::fs::read_to_string(&p)?;
    Ok(Some(serde_json::from_str(&raw)?))
}

/// Returns the existing live instance if one is reachable on its
/// recorded port, else None. Stale info files are removed.
pub async fn probe_existing() -> Result<Option<InstanceInfo>> {
    let Some(info) = read_instance_info()? else { return Ok(None) };

    // Cheap pid check first — avoids talking to a stranger's port.
    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    if sys.process(Pid::from_u32(info.pid)).is_none() {
        let _ = std::fs::remove_file(info_path()?);
        return Ok(None);
    }

    if probe_health(info.port).await {
        return Ok(Some(info));
    }
    let _ = std::fs::remove_file(info_path()?);
    Ok(None)
}

/// Lightweight HTTP/1.1 GET /v1/health probe. We avoid pulling reqwest
/// in just for one call.
async fn probe_health(port: u16) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::time::{Duration, timeout};

    let host_port = format!("127.0.0.1:{port}");
    let conn = timeout(Duration::from_millis(500), TcpStream::connect(&host_port)).await;
    let Ok(Ok(mut stream)) = conn else { return false; };
    let req = b"GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if timeout(Duration::from_millis(500), stream.write_all(req)).await.is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = match timeout(Duration::from_millis(500), stream.read(&mut buf)).await {
        Ok(Ok(n)) => n,
        _ => return false,
    };
    n >= 12 && buf[..12].starts_with(b"HTTP/1.1 200")
}
