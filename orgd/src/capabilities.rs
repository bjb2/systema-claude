//! Capability registry — mechanism present, no entries shipped.
//!
//! systema-claude exposes a generic capability registry over the HTTP
//! surface (`/v1/capabilities`) so a workspace can advertise local
//! services it knows how to launch and probe. The registry intentionally
//! ships **empty** in v0.1.0: the seed has nothing to advertise, and
//! every entry would be a kata in the bad sense (a prescribed service
//! the user did not ask for).
//!
//! To register a capability, instantiate one or more `Capability`
//! values inside `CapabilityManager::list` and add corresponding
//! arms to `health` and `launch`. The wire shape (camelCase JSON,
//! state enum, launch contract) is locked by the test suite in
//! `tests/http_capabilities.rs`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct CapabilityManager {
    #[allow(dead_code)]
    org_root: Option<PathBuf>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: CapabilityKind,
    pub description: &'static str,
    pub status_path: &'static str,
    pub launch_path: Option<&'static str>,
    pub primary_url: Option<&'static str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)] // variants used by future capability entries; part of the wire contract
pub enum CapabilityKind {
    LocalService,
    UiNative,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityStatus {
    pub id: String,
    pub state: CapabilityState,
    pub message: Option<String>,
    pub url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)] // Available/Running used when capability entries are registered
pub enum CapabilityState {
    Available,
    Running,
    Missing,
}

#[derive(Deserialize)]
pub struct LaunchRequest {
    #[serde(default, rename = "open")]
    pub _open: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResponse {
    pub id: String,
    pub state: CapabilityState,
    pub url: Option<String>,
    pub message: Option<String>,
}

impl CapabilityManager {
    pub fn new(org_root: Option<PathBuf>) -> Self {
        Self { org_root }
    }

    pub fn list(&self) -> Vec<Capability> {
        // No capabilities ship with the seed. Add entries here when the
        // workspace gains local services worth advertising.
        vec![]
    }

    pub fn health(&self, id: &str) -> CapabilityStatus {
        // Every id is unknown until entries are registered above.
        CapabilityStatus {
            id: id.to_string(),
            state: CapabilityState::Missing,
            message: Some(format!("unknown capability: {id}")),
            url: None,
        }
    }

    pub fn launch(&self, id: &str, _req: LaunchRequest) -> Result<LaunchResponse, String> {
        Err(format!("capability is not launchable: {id}"))
    }
}
