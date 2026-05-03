use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

/// One unified event stream. The webview-side proxy translates these
/// back into the Tauri events the existing frontend listens for
/// (pty-output, worker-output, worker-exit).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Event {
    #[serde(rename = "pty-output")]
    PtyOutput { pty_id: u32, data: String },
    #[serde(rename = "pty-exit")]
    PtyExit { pty_id: u32 },
    #[serde(rename = "worker-output")]
    WorkerOutput { worker_id: u32, stream: String, data: String },
    #[serde(rename = "worker-exit")]
    WorkerExit { worker_id: u32, code: Option<i32>, success: bool },
    /// Coalesced filesystem-change pulse for the registered org root.
    /// Frontend treats this exactly like Tauri's old `org-changed` emit.
    #[serde(rename = "org-changed")]
    OrgChanged,
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<Event>,
}

impl EventBus {
    pub fn new() -> Self {
        // Generous capacity. Slow subscribers get RecvError::Lagged
        // and recover by replaying buffered output via the buffer endpoint.
        let (tx, _rx) = broadcast::channel(4096);
        Self { tx }
    }

    pub fn publish(&self, event: Event) {
        // It is fine if there are no subscribers — drop on the floor.
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}
