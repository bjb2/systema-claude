use std::path::PathBuf;

use crate::capabilities::CapabilityManager;
use crate::events::EventBus;
use crate::index::IndexManager;
use crate::pty::PtyManager;
use crate::routines::RoutineManager;
use crate::worker::WorkerManager;

pub struct AppState {
    token: String,
    events: EventBus,
    ptys: PtyManager,
    workers: WorkerManager,
    capabilities: CapabilityManager,
    routines: Option<RoutineManager>,
    /// None when ORG_ROOT was not set at startup. PTY/worker traffic
    /// still works in that mode; index/relations endpoints return 404.
    index: Option<IndexManager>,
}

impl AppState {
    pub fn new(token: String, org_root: Option<PathBuf>) -> Self {
        let events = EventBus::new();
        let ptys = PtyManager::new(events.clone());
        let workers = WorkerManager::new(events.clone());
        let capabilities = CapabilityManager::new(org_root.clone());
        let routines = org_root.clone().map(RoutineManager::new);
        let index = org_root.map(IndexManager::new);
        Self { token, events, ptys, workers, capabilities, routines, index }
    }

    pub fn token(&self) -> &str { &self.token }
    pub fn events(&self) -> &EventBus { &self.events }
    pub fn ptys(&self) -> &PtyManager { &self.ptys }
    pub fn workers(&self) -> &WorkerManager { &self.workers }
    pub fn capabilities(&self) -> &CapabilityManager { &self.capabilities }
    pub fn routines(&self) -> Option<&RoutineManager> { self.routines.as_ref() }
    pub fn index(&self) -> Option<&IndexManager> { self.index.as_ref() }
}
