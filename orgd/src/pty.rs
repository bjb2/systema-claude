use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};

use crate::events::{Event, EventBus};

const BUFFER_HARD_CAP: usize = 200_000;
const BUFFER_TRIM_TO: usize = 160_000;

struct PtyInstance {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    buffer: Arc<Mutex<String>>,
}

impl Clone for PtyInstance {
    fn clone(&self) -> Self {
        Self {
            writer: self.writer.clone(),
            master: self.master.clone(),
            buffer: self.buffer.clone(),
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
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(&req.shell);
        if let Some(a) = req.args {
            for arg in a { cmd.arg(arg); }
        }
        cmd.cwd(&req.cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERM_PROGRAM", "xterm");
        cmd.env("TERM_PROGRAM_VERSION", "");

        let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let id = {
            let mut c = self.counter.lock().unwrap();
            *c += 1;
            *c
        };

        let buffer = Arc::new(Mutex::new(String::new()));
        self.inner.lock().unwrap().insert(id, PtyInstance {
            writer: Arc::new(Mutex::new(writer)),
            master: Arc::new(Mutex::new(pair.master)),
            buffer: buffer.clone(),
        });

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
                        // Per [[orgd-pty-lock-split]]: the reader holds only its
                        // own buffer Arc, never the HashMap mutex. On kill(), the
                        // master is dropped, the slave fd closes, and reader.read
                        // returns EOF/Err naturally.
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

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        // Hold the HashMap mutex only long enough to clone the writer Arc,
        // then drop it before doing blocking I/O. This is the structural
        // fix for the terminal-freeze bug — see [[orgd-pty-lock-split]].
        let writer_arc = {
            let ptys = self.inner.lock().unwrap();
            match ptys.get(&id) {
                Some(p) => p.writer.clone(),
                None => return Ok(()),
            }
        };
        let mut writer = writer_arc.lock().unwrap();
        writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn resize(&self, id: u32, rows: u16, cols: u16) -> Result<(), String> {
        let master_arc = {
            let ptys = self.inner.lock().unwrap();
            match ptys.get(&id) {
                Some(p) => p.master.clone(),
                None => return Ok(()),
            }
        };
        let res = master_arc.lock().unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string());
        res
    }

    pub fn kill(&self, id: u32) {
        // Dropping the master PTY closes the slave fd; the child sees EOF
        // and the reader thread exits. Buffer drops with the entry.
        self.inner.lock().unwrap().remove(&id);
    }
}
