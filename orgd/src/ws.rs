use std::sync::Arc;

use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    response::Response,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast::error::RecvError;
use tracing::warn;

use crate::state::AppState;

pub fn routes(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/v1/events", get(events_handler))
        .with_state(state)
}

#[derive(Deserialize)]
struct AuthQuery { token: String }

async fn events_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(auth): Query<AuthQuery>,
) -> Response {
    if auth.token != state.token() {
        return Response::builder()
            .status(axum::http::StatusCode::UNAUTHORIZED)
            .body(axum::body::Body::empty())
            .unwrap();
    }
    ws.on_upgrade(move |socket| run_events(socket, state))
}

async fn run_events(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.events().subscribe();

    let send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let payload = match serde_json::to_string(&event) {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    if sender.send(Message::Text(payload)).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    warn!(missed = n, "ws subscriber lagged");
                    // Tell client to refetch buffers.
                    let _ = sender.send(Message::Text(r#"{"type":"lag"}"#.to_string())).await;
                }
                Err(RecvError::Closed) => break,
            }
        }
    });

    // Drain inbound (client may send pings or close).
    while let Some(Ok(msg)) = receiver.next().await {
        if matches!(msg, Message::Close(_)) {
            break;
        }
    }
    send_task.abort();
}
