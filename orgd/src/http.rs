use std::sync::Arc;

use axum::{
    Router,
    extract::{Path, State},
    middleware,
    routing::{delete, get, post},
    Json,
};
use serde::{Deserialize, Serialize};

use axum::extract::Query;

use crate::auth;
use crate::capabilities::{Capability, CapabilityStatus, LaunchRequest, LaunchResponse};
use crate::documents::FileEntry;
use crate::pty::{CreateRequest, CreateResponse};
use crate::relations::Relations;
use crate::routines::{CreateRoutine, Routine, RunRecord, TriggerBody, UpdateRoutine};
use crate::state::AppState;
use crate::worker::{StartRequest, StartResponse, WorkerStatus};

pub fn routes(state: Arc<AppState>) -> Router {
    let protected = Router::new()
        .route("/v1/pty", post(pty_create))
        .route("/v1/pty/:id/buffer", get(pty_buffer))
        .route("/v1/pty/:id/write", post(pty_write))
        .route("/v1/pty/:id/resize", post(pty_resize))
        .route("/v1/pty/:id", delete(pty_kill))
        .route("/v1/worker", post(worker_start))
        .route("/v1/worker/:id/buffer", get(worker_buffer))
        .route("/v1/worker/:id/status", get(worker_status))
        .route("/v1/worker/:id", delete(worker_kill))
        .route("/v1/documents", get(documents_list))
        .route("/v1/relations", get(relations_get))
        .route("/v1/code-files", get(code_files_list))
        .route("/v1/org-root", get(org_root_get))
        .route("/v1/capabilities", get(capabilities_list))
        .route("/v1/capabilities/:id/health", get(capability_health))
        .route("/v1/capabilities/:id/launch", post(capability_launch))
        .route("/v1/routines", get(routines_list).post(routine_create))
        .route("/v1/routines/:name", get(routine_get).put(routine_update).delete(routine_delete))
        .route("/v1/routines/:name/trigger", post(routine_trigger))
        .route("/v1/routines/:name/runs", get(routine_runs))
        .route("/v1/runs", get(runs_list))
        .route("/v1/runs/:id", get(run_get))
        .route("/v1/file/read", get(file_read))
        .route("/v1/file/read-base64", get(file_read_base64))
        .route("/v1/file/write", post(file_write))
        .route("/v1/file/write-bytes", post(file_write_bytes))
        .route("/v1/file/append", post(file_append))
        .route("/v1/file/move", post(file_move))
        .route("/v1/file/copy", post(file_copy))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_token))
        .with_state(state.clone());

    // /v1/health is unauthenticated so probes can detect a live daemon
    // without needing the token (token mismatch is handled by callers
    // re-reading the lifecycle file).
    let public = Router::new()
        .route("/v1/health", get(health))
        .with_state(state);

    public.merge(protected)
}

#[derive(Serialize)]
struct Health { ok: bool, version: &'static str }

async fn health() -> Json<Health> {
    Json(Health { ok: true, version: env!("CARGO_PKG_VERSION") })
}

async fn pty_create(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateRequest>,
) -> Result<Json<CreateResponse>, (axum::http::StatusCode, String)> {
    state
        .ptys()
        .create(req)
        .map(|pty_id| Json(CreateResponse { pty_id }))
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Serialize)]
struct BufferResponse { data: String }

async fn pty_buffer(
    State(state): State<Arc<AppState>>,
    Path(id): Path<u32>,
) -> Json<BufferResponse> {
    Json(BufferResponse { data: state.ptys().buffer(id) })
}

#[derive(Deserialize)]
struct WriteRequest { data: String }

async fn pty_write(
    State(state): State<Arc<AppState>>,
    Path(id): Path<u32>,
    Json(req): Json<WriteRequest>,
) -> Result<(), (axum::http::StatusCode, String)> {
    // write_all on the PTY master is synchronous and can block on a wedged
    // ConPTY pipe; offload to spawn_blocking so the tokio runtime stays free.
    let ptys = state.ptys().clone();
    tokio::task::spawn_blocking(move || ptys.write(id, &req.data))
        .await
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))
}

#[derive(Deserialize)]
struct ResizeRequest { rows: u16, cols: u16 }

async fn pty_resize(
    State(state): State<Arc<AppState>>,
    Path(id): Path<u32>,
    Json(req): Json<ResizeRequest>,
) -> Result<(), (axum::http::StatusCode, String)> {
    state.ptys().resize(id, req.rows, req.cols).map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn pty_kill(
    State(state): State<Arc<AppState>>,
    Path(id): Path<u32>,
) {
    state.ptys().kill(id);
}

async fn worker_start(
    State(state): State<Arc<AppState>>,
    Json(req): Json<StartRequest>,
) -> Result<Json<StartResponse>, (axum::http::StatusCode, String)> {
    state
        .workers()
        .start(req)
        .map(|worker_id| Json(StartResponse { worker_id }))
        .map_err(|e| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e))
}

async fn worker_buffer(
    State(state): State<Arc<AppState>>,
    Path(id): Path<u32>,
) -> Json<BufferResponse> {
    Json(BufferResponse { data: state.workers().buffer(id) })
}

async fn worker_status(
    State(state): State<Arc<AppState>>,
    Path(id): Path<u32>,
) -> Json<WorkerStatus> {
    Json(state.workers().status(id))
}

async fn worker_kill(
    State(state): State<Arc<AppState>>,
    Path(id): Path<u32>,
) {
    state.workers().kill(id);
}

#[derive(Serialize)]
struct OrgRootResp { path: String }

async fn org_root_get(State(state): State<Arc<AppState>>)
    -> Result<Json<OrgRootResp>, axum::http::StatusCode> {
    state.index()
        .map(|i| Json(OrgRootResp { path: i.root().to_string_lossy().into_owned() }))
        .ok_or(axum::http::StatusCode::NOT_FOUND)
}

async fn documents_list(State(state): State<Arc<AppState>>)
    -> Result<Json<Vec<crate::documents::OrgDocument>>, axum::http::StatusCode> {
    state.index()
        .map(|i| Json(i.documents()))
        .ok_or(axum::http::StatusCode::NOT_FOUND)
}

#[derive(Deserialize)]
struct RelationsQuery { path: String }

async fn relations_get(
    State(state): State<Arc<AppState>>,
    Query(q): Query<RelationsQuery>,
) -> Result<Json<Relations>, axum::http::StatusCode> {
    let idx = state.index().ok_or(axum::http::StatusCode::NOT_FOUND)?;
    idx.relations_for(&q.path)
        .map(Json)
        .ok_or(axum::http::StatusCode::NOT_FOUND)
}

#[derive(Deserialize)]
struct CodeFilesQuery { dir: String }

async fn code_files_list(Query(q): Query<CodeFilesQuery>) -> Json<Vec<FileEntry>> {
    Json(crate::documents::list_files(&q.dir))
}

async fn capabilities_list(State(state): State<Arc<AppState>>) -> Json<Vec<Capability>> {
    Json(state.capabilities().list())
}

async fn capability_health(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Json<CapabilityStatus> {
    Json(state.capabilities().health(&id))
}

async fn capability_launch(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<LaunchRequest>,
) -> Result<Json<LaunchResponse>, (axum::http::StatusCode, String)> {
    state
        .capabilities()
        .launch(&id, req)
        .map(Json)
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))
}

async fn routines_list(State(state): State<Arc<AppState>>)
    -> Result<Json<Vec<Routine>>, (axum::http::StatusCode, String)> {
    state.routines()
        .ok_or((axum::http::StatusCode::NOT_FOUND, "routines unavailable".to_string()))?
        .list()
        .map(Json)
        .map_err(internal_error)
}

async fn routine_get(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<Json<Routine>, (axum::http::StatusCode, String)> {
    state.routines()
        .ok_or((axum::http::StatusCode::NOT_FOUND, "routines unavailable".to_string()))?
        .get(&name)
        .map(Json)
        .map_err(internal_error)
}

async fn routine_create(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateRoutine>,
) -> Result<Json<Routine>, (axum::http::StatusCode, String)> {
    state.routines()
        .ok_or((axum::http::StatusCode::NOT_FOUND, "routines unavailable".to_string()))?
        .create(req)
        .map(Json)
        .map_err(internal_error)
}

async fn routine_update(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<UpdateRoutine>,
) -> Result<Json<Routine>, (axum::http::StatusCode, String)> {
    state.routines()
        .ok_or((axum::http::StatusCode::NOT_FOUND, "routines unavailable".to_string()))?
        .update(&name, req)
        .map(Json)
        .map_err(internal_error)
}

async fn routine_delete(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> Result<(), (axum::http::StatusCode, String)> {
    state.routines()
        .ok_or((axum::http::StatusCode::NOT_FOUND, "routines unavailable".to_string()))?
        .delete(&name)
        .map_err(internal_error)
}

async fn routine_trigger(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    body: Option<Json<TriggerBody>>,
) -> Result<Json<RunRecord>, (axum::http::StatusCode, String)> {
    let args = body.and_then(|Json(b)| b.args);
    state.routines()
        .ok_or((axum::http::StatusCode::NOT_FOUND, "routines unavailable".to_string()))?
        .trigger_now(&name, args)
        .map(Json)
        .map_err(internal_error)
}

#[derive(Deserialize)]
struct RunsQuery { limit: Option<usize> }

async fn routine_runs(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Query(q): Query<RunsQuery>,
) -> Result<Json<Vec<RunRecord>>, (axum::http::StatusCode, String)> {
    state.routines()
        .ok_or((axum::http::StatusCode::NOT_FOUND, "routines unavailable".to_string()))?
        .list_runs(Some(&name), q.limit.unwrap_or(20))
        .map(Json)
        .map_err(internal_error)
}

async fn runs_list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<RunsQuery>,
) -> Result<Json<Vec<RunRecord>>, (axum::http::StatusCode, String)> {
    state.routines()
        .ok_or((axum::http::StatusCode::NOT_FOUND, "routines unavailable".to_string()))?
        .list_runs(None, q.limit.unwrap_or(20))
        .map(Json)
        .map_err(internal_error)
}

async fn run_get(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<RunRecord>, (axum::http::StatusCode, String)> {
    state.routines()
        .ok_or((axum::http::StatusCode::NOT_FOUND, "routines unavailable".to_string()))?
        .get_run(&id)
        .map(Json)
        .map_err(internal_error)
}

#[derive(Deserialize)]
struct FilePathQuery { path: String }

#[derive(Serialize)]
struct FileContentResp { content: String }

#[derive(Serialize)]
struct FileBytesResp { b64: String }

#[derive(Deserialize)]
struct FileWriteBody { path: String, content: String }

#[derive(Deserialize)]
struct FileBytesWriteBody { path: String, b64: String }

#[derive(Deserialize)]
struct FileMoveBody { src: String, dst: String }

async fn file_read(Query(q): Query<FilePathQuery>)
    -> Result<Json<FileContentResp>, (axum::http::StatusCode, String)> {
    std::fs::read_to_string(&q.path)
        .map(|content| Json(FileContentResp { content }))
        .map_err(io_error)
}

async fn file_read_base64(Query(q): Query<FilePathQuery>)
    -> Result<Json<FileBytesResp>, (axum::http::StatusCode, String)> {
    use base64::{Engine as _, engine::general_purpose};
    std::fs::read(&q.path)
        .map(|bytes| Json(FileBytesResp { b64: general_purpose::STANDARD.encode(bytes) }))
        .map_err(io_error)
}

async fn file_write(Json(body): Json<FileWriteBody>)
    -> Result<(), (axum::http::StatusCode, String)> {
    if let Some(parent) = std::path::Path::new(&body.path).parent() {
        std::fs::create_dir_all(parent).map_err(io_error)?;
    }
    std::fs::write(&body.path, body.content).map_err(io_error)
}

async fn file_append(Json(body): Json<FileWriteBody>)
    -> Result<(), (axum::http::StatusCode, String)> {
    use std::io::Write;
    if let Some(parent) = std::path::Path::new(&body.path).parent() {
        std::fs::create_dir_all(parent).map_err(io_error)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&body.path)
        .map_err(io_error)?;
    f.write_all(body.content.as_bytes()).map_err(io_error)
}

async fn file_write_bytes(Json(body): Json<FileBytesWriteBody>)
    -> Result<(), (axum::http::StatusCode, String)> {
    use base64::{Engine as _, engine::general_purpose};
    let bytes = general_purpose::STANDARD
        .decode(&body.b64)
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e.to_string()))?;
    if let Some(parent) = std::path::Path::new(&body.path).parent() {
        std::fs::create_dir_all(parent).map_err(io_error)?;
    }
    std::fs::write(&body.path, bytes).map_err(io_error)
}

async fn file_move(Json(body): Json<FileMoveBody>)
    -> Result<(), (axum::http::StatusCode, String)> {
    if let Some(parent) = std::path::Path::new(&body.dst).parent() {
        std::fs::create_dir_all(parent).map_err(io_error)?;
    }
    std::fs::rename(&body.src, &body.dst).map_err(io_error)
}

async fn file_copy(Json(body): Json<FileMoveBody>)
    -> Result<(), (axum::http::StatusCode, String)> {
    if let Some(parent) = std::path::Path::new(&body.dst).parent() {
        std::fs::create_dir_all(parent).map_err(io_error)?;
    }
    std::fs::copy(&body.src, &body.dst).map(|_| ()).map_err(io_error)
}

fn io_error(e: std::io::Error) -> (axum::http::StatusCode, String) {
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
}

fn internal_error(e: String) -> (axum::http::StatusCode, String) {
    (axum::http::StatusCode::INTERNAL_SERVER_ERROR, e)
}
