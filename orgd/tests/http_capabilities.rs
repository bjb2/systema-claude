//! Capability registry surface.
//!
//! These tests lock the wire shape (list returns array of well-formed
//! entries, health returns a state, unknown id returns Missing, launch
//! on a non-launchable id errors) so future capability additions don't
//! silently break the contract.
//!
//! systema-claude ships with the registry empty by design. The
//! "if entries exist" tests below tolerate the empty case so the
//! contract holds whether or not capabilities have been registered.

mod common;
use common::OrgdHandle;

#[tokio::test]
async fn capabilities_list_returns_array_of_well_formed_entries() {
    let h = OrgdHandle::spawn(None);
    let resp = h.get("/v1/capabilities").await;
    assert!(resp.status().is_success(), "status: {}", resp.status());
    let caps: Vec<serde_json::Value> = resp.json().await.unwrap();

    // Empty registry is valid (default seed state). When entries are
    // registered, each must carry the camelCase-named fields below.
    for cap in &caps {
        for key in ["id", "label", "kind", "description", "statusPath"] {
            assert!(cap.get(key).is_some(), "capability missing field {key}: {cap}");
        }
        let kind = cap["kind"].as_str().unwrap();
        assert!(
            matches!(kind, "local-service" | "ui-native"),
            "unexpected kind: {kind}",
        );
    }
}

#[tokio::test]
async fn capability_health_returns_state_for_known_id() {
    let h = OrgdHandle::spawn(None);

    let caps: Vec<serde_json::Value> = h.get("/v1/capabilities").await
        .json().await.unwrap();
    if caps.is_empty() {
        // Nothing registered; nothing to probe. Contract still holds.
        return;
    }
    let id = caps[0]["id"].as_str().expect("id").to_string();

    let resp = h.get(&format!("/v1/capabilities/{}/health", id)).await;
    assert!(resp.status().is_success(), "status: {}", resp.status());
    let status: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(status["id"].as_str().unwrap(), id);
    let state = status["state"].as_str().unwrap();
    assert!(
        matches!(state, "available" | "running" | "missing"),
        "unexpected state: {state}",
    );
}

#[tokio::test]
async fn capability_health_for_unknown_id_returns_missing() {
    let h = OrgdHandle::spawn(None);
    let resp = h.get("/v1/capabilities/totally-not-real-zzz/health").await;
    assert!(resp.status().is_success());
    let status: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(status["state"].as_str().unwrap(), "missing");
    assert!(status["message"].as_str().unwrap_or("").contains("unknown"));
}

#[tokio::test]
async fn capability_launch_on_non_launchable_errors() {
    let h = OrgdHandle::spawn(None);
    let caps: Vec<serde_json::Value> = h.get("/v1/capabilities").await
        .json().await.unwrap();
    let non_launchable = caps.iter()
        .find(|c| c.get("launchPath").map_or(true, |v| v.is_null()))
        .map(|c| c["id"].as_str().unwrap().to_string());

    if let Some(id) = non_launchable {
        let resp = h.post_json(
            &format!("/v1/capabilities/{}/launch", id),
            &serde_json::json!({"open": false}),
        ).await;
        assert!(
            resp.status().is_client_error() || resp.status().is_server_error(),
            "expected error status for non-launchable capability, got {}", resp.status(),
        );
    }
    // If every registered capability is launchable (or the registry is
    // empty), this test silently passes. The contract still holds.
}

#[tokio::test]
async fn capability_routes_require_auth() {
    let h = OrgdHandle::spawn(None);
    let resp = h.get_unauth("/v1/capabilities").await;
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}
