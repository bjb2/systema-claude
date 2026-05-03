use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};
use rand::RngCore;

use crate::state::AppState;

pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Bearer-token auth for HTTP. WS auth is handled separately because
/// browsers cannot set Authorization on a WebSocket handshake.
pub async fn require_token(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    req: axum::extract::Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let presented = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match presented {
        Some(t) if t == state.token() => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}
