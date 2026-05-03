//! FS watcher that coalesces bursts and publishes `org-changed` to the
//! event bus. Lifted from the old Tauri-side watcher in lib.rs — same
//! debounce window, same ignore set (extended for orgd binaries).

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{Event, RecursiveMode, Watcher};
use tracing::{info, warn};

use crate::events::{Event as OrgdEvent, EventBus};
use crate::index::IndexManager;

const DEBOUNCE_MS: u64 = 200;

fn is_ignored(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    // Deploy artifacts at the org root: rotating these triggers
    // Create/Remove/Modify storms the frontend can't act on.
    name == "org-viewer.exe"
        || name == "org-viewer-prev.exe"
        || (name.starts_with("org-viewer-old-") && name.ends_with(".exe"))
        || (name.starts_with("org-viewer-stale-") && name.ends_with(".exe"))
        || name == "org-viewer.exe.pending"
        || name == "orgd.exe"
        || name == "orgd-prev.exe"
        || (name.starts_with("orgd-stale-") && name.ends_with(".exe"))
        || name == "orgd.exe.pending"
}

fn junction_targets(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|entry| {
            let file_type = entry.file_type().ok()?;
            if !file_type.is_symlink() {
                return None;
            }
            let target = std::fs::read_link(entry.path()).ok()?;
            if target.is_dir() { Some(target) } else { None }
        })
        .collect()
}

/// Spawns the watcher on a dedicated thread and returns; the watcher
/// lives for the lifetime of the process. Failures are logged, not
/// fatal — orgd still serves PTY/worker traffic without a watcher.
pub fn spawn(root: PathBuf, events: EventBus, index: Option<IndexManager>) {
    if !root.exists() {
        warn!(path = %root.display(), "watcher: root does not exist; not watching");
        return;
    }

    let (tx, rx) = mpsc::channel::<()>();

    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        use notify::EventKind::*;
        match event.kind {
            Create(_) | Modify(_) | Remove(_) => {
                if !event.paths.is_empty() && event.paths.iter().all(|p| is_ignored(p)) {
                    return;
                }
                let _ = tx.send(());
            }
            _ => {}
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            warn!(error = %e, "watcher: failed to create notify watcher");
            return;
        }
    };

    if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
        warn!(error = %e, path = %root.display(), "watcher: watch() failed");
        return;
    }

    info!(path = %root.display(), "watcher: watching org root");

    for target in junction_targets(&root) {
        match watcher.watch(&target, RecursiveMode::Recursive) {
            Ok(()) => info!(path = %target.display(), "watcher: watching junction target"),
            Err(e) => warn!(error = %e, path = %target.display(), "watcher: failed to watch junction target"),
        }
    }

    // Hold the watcher for the whole process. notify drops the handle
    // (and stops watching) on drop, so we leak it deliberately.
    Box::leak(Box::new(watcher));

    std::thread::spawn(move || {
        // Coalescer: each tick from the watcher closure resets a quiet
        // window; we publish once when the burst settles.
        while let Ok(()) = rx.recv() {
            let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
            while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
                match rx.recv_timeout(remaining) {
                    Ok(()) => continue,
                    Err(_) => break,
                }
            }
            // Invalidate before publishing — by the time the frontend
            // refetches, the next index read will rebuild from disk.
            if let Some(idx) = index.as_ref() {
                idx.invalidate();
            }
            events.publish(OrgdEvent::OrgChanged);
        }
    });
}
