//! Health endpoint is public; everything else requires bearer auth.

mod common;
use common::OrgdHandle;

#[tokio::test]
async fn health_is_public_and_returns_version() {
    let h = OrgdHandle::spawn(None);
    let resp = h.get_unauth("/v1/health").await;
    assert!(resp.status().is_success(), "status: {}", resp.status());
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["ok"], true);
    assert!(body["version"].is_string());
}

#[tokio::test]
async fn protected_routes_reject_missing_token() {
    let h = OrgdHandle::spawn(None);
    let resp = h.get_unauth("/v1/documents").await;
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn protected_routes_reject_wrong_token() {
    let h = OrgdHandle::spawn(None);
    let resp = h.http
        .get(format!("{}/v1/documents", h.base_url))
        .bearer_auth("not-the-token")
        .send().await.unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::UNAUTHORIZED);
}
