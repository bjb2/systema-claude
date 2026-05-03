//! In-memory document index. Cache scans the org root on demand and
//! rebuilds when the watcher reports a change burst, so the frontend
//! never pays the scan cost on a cold view mount.

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use crate::documents::{scan_org, OrgDocument};
use crate::relations::{relations_for, Relations};

#[derive(Clone)]
pub struct IndexManager {
    root: Arc<PathBuf>,
    cache: Arc<RwLock<Option<Vec<OrgDocument>>>>,
}

impl IndexManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: Arc::new(root),
            cache: Arc::new(RwLock::new(None)),
        }
    }

    pub fn root(&self) -> &PathBuf { &self.root }

    /// Returns a snapshot of documents, rebuilding the cache if dirty.
    /// We clone the Vec so callers don't hold the lock while serializing
    /// large JSON payloads.
    pub fn documents(&self) -> Vec<OrgDocument> {
        if let Some(docs) = self.cache.read().unwrap().as_ref() {
            return docs.clone();
        }
        let docs = scan_org(&self.root);
        *self.cache.write().unwrap() = Some(docs.clone());
        docs
    }

    pub fn invalidate(&self) {
        *self.cache.write().unwrap() = None;
    }

    pub fn relations_for(&self, path: &str) -> Option<Relations> {
        let docs = self.documents();
        relations_for(path, &docs, &self.root)
    }
}
