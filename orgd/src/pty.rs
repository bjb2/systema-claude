use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};

use crate::events::{Event, EventBus};

const BUFFER_HARD_CAP: usize = 200_000;
const BUFFER_TRIM_TO: usize = 160_000;
// Bounded queue depth between the axum handler and the per-PTY writer thread.
// Hit this and `try_send` returns Full -> 503 BackpressureFull -> frontend
// flips a "stalled" badge instead of silently parking another blocking thread
// on `WriteFile`. 64 chunks is generous for normal typing bursts but small
// enough that a wedged child is detected within a second of typing.
const WRITE_QUEUE_CAP: usize = 64;

struct PtyInstance {
    write_tx: SyncSender<Vec<u8>>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    buffer: Arc<Mutex<String>>,
    // Storing the child handle is what makes `kill()` actually stop the child.
    // Dropping master alone is unreliable on Windows ConPTY — the cloned
    // reader keeps an independent handle and the child can outlive both.
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    shell: String,
    cwd: String,
    created_at: i64,
}

impl Clone for PtyInstance {
    fn clone(&self) -> Self {
        Self {
            write_tx: self.write_tx.clone(),
            master: self.master.clone(),
            buffer: self.buffer.clone(),
            child: self.child.clone(),
            shell: self.shell.clone(),
            cwd: self.cwd.clone(),
            created_at: self.created_at,
        }
    }
}

#[derive(Clone)]
pub struct PtyManager {
    inner: Arc<Mutex<HashMap<u32, PtyInstance>>>,
    counter: Arc<Mutex<u32>>,
    events: EventBus,
}

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub shell: String,
    pub args: Option<Vec<String>>,
    pub cwd: String,
}

#[derive(Debug, Serialize)]
pub struct CreateResponse {
    pub pty_id: u32,
}

#[derive(Debug, Serialize)]
pub struct PtyInfo {
    pub pty_id: u32,
    pub shell: String,
    pub cwd: String,
    pub created_at: i64,
}

pub enum WriteOutcome {
    Ok,
    Backpressure,
    NotFound,
}

impl PtyManager {
    pub fn new(events: EventBus) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            counter: Arc::new(Mutex::new(0)),
            events,
        }
    }

    pub fn create(&self, req: CreateRequest) -> Result<u32, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(&req.shell);
        if let Some(a) = req.args.clone() {
            for arg in a {
                cmd.arg(arg);
            }
        }
        cmd.cwd(&req.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "xterm");
        cmd.env("TERM_PROGRAM_VERSION", "");

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let id = {
            let mut c = self.counter.lock().unwrap();
            *c += 1;
            *c
        };

        let buffer = Arc::new(Mutex::new(String::new()));

        // Bounded writer channel + dedicated writer thread.
        // Per [[orgd-pty-lock-split]] the lock split prevents *cross-tile*
        // contagion when ConPTY input pipe fills. This channel converts the
        // remaining *same-tile* wedge from a silent parked-blocking-thread
        // pile-up into a visible 503 -> stalled-badge in the UI.
        let (write_tx, write_rx) = mpsc::sync_channel::<Vec<u8>>(WRITE_QUEUE_CAP);
        std::thread::spawn(move || {
            while let Ok(chunk) = write_rx.recv() {
                if writer.write_all(&chunk).is_err() {
                    break;
                }
                if writer.flush().is_err() {
                    break;
                }
            }
        });

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        self.inner.lock().unwrap().insert(
            id,
            PtyInstance {
                write_tx,
                master: Arc::new(Mutex::new(pair.master)),
                buffer: buffer.clone(),
                child: Arc::new(Mutex::new(child)),
                shell: req.shell,
                cwd: req.cwd,
                created_at: now_ms,
            },
        );

        let events = self.events.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        events.publish(Event::PtyExit { pty_id: id });
                        break;
                    }
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        {
                            let mut buf_guard = buffer.lock().unwrap();
                            buf_guard.push_str(&data);
                            if buf_guard.len() > BUFFER_HARD_CAP {
                                let keep_from = buf_guard.len().saturating_sub(BUFFER_TRIM_TO);
                                let trimmed = buf_guard.split_off(keep_from);
                                *buf_guard = trimmed;
                            }
                        }
                        events.publish(Event::PtyOutput { pty_id: id, data });
                    }
                }
            }
        });

        Ok(id)
    }

    pub fn buffer(&self, id: u32) -> String {
        let buf_arc = {
            let ptys = self.inner.lock().unwrap();
            match ptys.get(&id) {
                Some(p) => p.buffer.clone(),
                None => return String::new(),
            }
        };
        let s = buf_arc.lock().unwrap().clone();
        s
    }

    pub fn write(&self, id: u32, data: &str) -> WriteOutcome {
        let tx = {
            let ptys = self.inner.lock().unwrap();
            match ptys.get(&id) {
                Some(p) => p.write_tx.clone(),
                None => return WriteOutcome::NotFound,
            }
        };
        match tx.try_send(data.as_bytes().to_vec()) {
            Ok(_) => WriteOutcome::Ok,
            Err(TrySendError::Full(_)) => WriteOutcome::Backpressure,
            Err(TrySendError::Disconnected(_)) => WriteOutcome::NotFound,
        }
    }

    pub fn resize(&self, id: u32, rows: u16, cols: u16) -> Result<(), String> {
        let master_arc = {
            let ptys = self.inner.lock().unwrap();
            match ptys.get(&id) {
                Some(p) => p.master.clone(),
                None => return Ok(()),
            }
        };
        let res = master_arc
            .lock()
            .unwrap()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string());
        res
    }

    pub fn kill(&self, id: u32) {
        let removed = self.inner.lock().unwrap().remove(&id);
        if let Some(inst) = removed {
            // Closing the channel lets the writer thread exit on its next recv.
            drop(inst.write_tx);
            // Explicitly kill the child. Necessary because `try_clone_reader`
            // gave the reader thread an independent handle that survives master
            // drop; without an explicit kill the child can keep running and the
            // reader thread leaks until the child voluntarily exits.
            let _ = inst.child.lock().unwrap().kill();
            // master + buffer + child Arcs drop with `inst`.
        }
    }

    pub fn list(&self) -> Vec<PtyInfo> {
        let ptys = self.inner.lock().unwrap();
        let mut v: Vec<PtyInfo> = ptys
            .iter()
            .map(|(id, p)| PtyInfo {
                pty_id: *id,
                shell: p.shell.clone(),
                cwd: p.cwd.clone(),
                created_at: p.created_at,
            })
            .collect();
        v.sort_by_key(|p| p.pty_id);
        v
    }
}
