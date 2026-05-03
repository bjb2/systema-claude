use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::events::{Event, EventBus};

const BUFFER_HARD_CAP: usize = 200_000;
const BUFFER_TRIM_TO: usize = 160_000;

// Windows' CreateProcessW only auto-resolves .exe/.com — not .cmd/.bat/.ps1 —
// so a bare `codex` (which ships as codex.cmd via npm) spawns with
// ERROR_FILE_NOT_FOUND. Walk PATH ourselves and respect PATHEXT.
#[cfg(windows)]
fn resolve_program(name: &str) -> Option<PathBuf> {
    let p = std::path::Path::new(name);
    if p.is_absolute() || name.contains('/') || name.contains('\\') {
        return Some(p.to_path_buf());
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let exts: Vec<String> = pathext
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in &exts {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn resolve_program(name: &str) -> Option<PathBuf> {
    Some(PathBuf::from(name))
}

struct WorkerInstance {
    pid: u32,
    buffer: String,
    running: bool,
    code: Option<i32>,
    success: bool,
}

#[derive(Clone)]
pub struct WorkerManager {
    inner: Arc<Mutex<HashMap<u32, WorkerInstance>>>,
    counter: Arc<Mutex<u32>>,
    events: EventBus,
}

#[derive(Debug, Deserialize)]
pub struct StartRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub stdin: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StartResponse {
    pub worker_id: u32,
}

#[derive(Debug, Serialize)]
pub struct WorkerStatus {
    pub running: bool,
    pub code: Option<i32>,
    pub success: bool,
}

impl WorkerManager {
    pub fn new(events: EventBus) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            counter: Arc::new(Mutex::new(0)),
            events,
        }
    }

    pub fn start(&self, req: StartRequest) -> Result<u32, String> {
        let resolved = resolve_program(&req.command)
            .ok_or_else(|| format!("program not found in PATH: {}", req.command))?;
        let mut cmd = Command::new(&resolved);
        cmd.args(req.args)
            .current_dir(req.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;

        if let Some(input) = req.stdin {
            if let Some(mut child_stdin) = child.stdin.take() {
                child_stdin.write_all(input.as_bytes()).map_err(|e| e.to_string())?;
                child_stdin.flush().map_err(|e| e.to_string())?;
            }
        }

        let stdout = child.stdout.take().ok_or_else(|| "worker stdout unavailable".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "worker stderr unavailable".to_string())?;

        let id = {
            let mut c = self.counter.lock().unwrap();
            *c += 1;
            *c
        };

        let pid = child.id();
        self.inner.lock().unwrap().insert(id, WorkerInstance {
            pid,
            buffer: String::new(),
            running: true,
            code: None,
            success: false,
        });

        spawn_stream(self.inner.clone(), self.events.clone(), id, stdout, "stdout");
        spawn_stream(self.inner.clone(), self.events.clone(), id, stderr, "stderr");

        let inner = self.inner.clone();
        let events = self.events.clone();
        std::thread::spawn(move || {
            let status = child.wait().ok();
            let code = status.as_ref().and_then(|s| s.code());
            let success = status.as_ref().map(|s| s.success()).unwrap_or(false);
            if let Ok(mut workers) = inner.lock() {
                if let Some(worker) = workers.get_mut(&id) {
                    worker.running = false;
                    worker.code = code;
                    worker.success = success;
                }
            }
            events.publish(Event::WorkerExit { worker_id: id, code, success });
        });

        Ok(id)
    }

    pub fn buffer(&self, id: u32) -> String {
        self.inner.lock().unwrap()
            .get(&id)
            .map(|w| w.buffer.clone())
            .unwrap_or_default()
    }

    pub fn status(&self, id: u32) -> WorkerStatus {
        self.inner.lock().unwrap()
            .get(&id)
            .map(|w| WorkerStatus { running: w.running, code: w.code, success: w.success })
            .unwrap_or(WorkerStatus { running: false, code: None, success: false })
    }

    pub fn kill(&self, id: u32) {
        let removed = self.inner.lock().unwrap().remove(&id);
        if let Some(w) = removed {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &w.pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            #[cfg(not(windows))]
            {
                let _ = w; // pid kill only matters on Windows here
            }
        }
    }
}

fn spawn_stream(
    inner: Arc<Mutex<HashMap<u32, WorkerInstance>>>,
    events: EventBus,
    worker_id: u32,
    mut reader: impl Read + Send + 'static,
    stream: &'static str,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Ok(mut workers) = inner.lock() {
                        if let Some(worker) = workers.get_mut(&worker_id) {
                            worker.buffer.push_str(&data);
                            if worker.buffer.len() > BUFFER_HARD_CAP {
                                let keep_from = worker.buffer.len().saturating_sub(BUFFER_TRIM_TO);
                                worker.buffer = worker.buffer.split_off(keep_from);
                            }
                        } else {
                            break;
                        }
                    }
                    events.publish(Event::WorkerOutput {
                        worker_id,
                        stream: stream.to_string(),
                        data,
                    });
                }
            }
        }
    });
}
