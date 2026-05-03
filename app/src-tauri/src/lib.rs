mod frontmatter;
mod orgd_client;
mod pty;
mod worker;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// Global flag tracking whether the main window is still alive.
///
/// Background: WebView2 returns `HRESULT(0x8007139F)` ("group or resource not in
/// correct state") for every IPC call made while the WebView is tearing down. A
/// flood of these — most often from PTY reader threads or the FS watcher —
/// drives msedge.dll into an internal CHECK and crashes the browser process,
/// which takes the whole app with it (and any Claude Code sessions running in
/// embedded terminals). Rust never panics so the panic hook can't catch it.
///
/// Every code path that calls `emit*` from a long-running thread MUST gate on
/// this flag. See knowledge/tools/tauri-webview2-native-crash-diagnosis.md.
pub static WINDOW_ALIVE: AtomicBool = AtomicBool::new(true);

/// Find the org root by searching for a directory containing CLAUDE.md.
/// Search order: exe ancestors, then cwd ancestors (with sibling check).
/// Production: exe is shipped inside the org root, so exe's parent wins.
/// Dev: cwd may be deep (e.g. target/debug); the sibling check below
/// handles the case where the workspace is a sibling of the dev tree.
fn find_org_root() -> PathBuf {
    // Check exe ancestors (works in production)
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().unwrap_or(&exe).to_path_buf();
        loop {
            if dir.join("CLAUDE.md").exists() {
                return dir;
            }
            match dir.parent() {
                Some(p) => dir = p.to_path_buf(),
                None => break,
            }
        }
    }

    // Walk cwd ancestors; at each level check the dir itself and its siblings.
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = cwd.clone();
        loop {
            if dir.join("CLAUDE.md").exists() {
                return dir.clone();
            }
            if let Some(parent) = dir.parent() {
                if let Ok(entries) = std::fs::read_dir(parent) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_dir() && path != dir && path.join("CLAUDE.md").exists() {
                            return path;
                        }
                    }
                }
                dir = parent.to_path_buf();
            } else {
                break;
            }
        }
    }

    // Last resort: exe's parent
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}


pub struct AppState {
    pub org_root: PathBuf,
}

#[tauri::command]
fn get_org_root(state: tauri::State<Arc<AppState>>) -> String {
    state.org_root.to_string_lossy().to_string()
}

#[tauri::command]
async fn get_documents(client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    client.get("/v1/documents").await
}

#[tauri::command]
async fn get_relations(path: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    let q = format!("/v1/relations?path={}", urlencoding::encode(&path));
    client.get(&q).await
}

#[tauri::command]
async fn read_file(path: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<String, String> {
    let q = format!("/v1/file/read?path={}", urlencoding::encode(&path));
    let resp: serde_json::Value = client.get(&q).await?;
    resp.get("content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "invalid file read response".to_string())
}

#[tauri::command]
async fn write_file(path: String, content: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<(), String> {
    client.post("/v1/file/write", &serde_json::json!({ "path": path, "content": content })).await
}

#[tauri::command]
async fn read_file_base64(path: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<String, String> {
    let q = format!("/v1/file/read-base64?path={}", urlencoding::encode(&path));
    let resp: serde_json::Value = client.get(&q).await?;
    resp.get("b64")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "invalid file read-base64 response".to_string())
}

#[tauri::command]
async fn move_file(src: String, dst: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<(), String> {
    client.post("/v1/file/move", &serde_json::json!({ "src": src, "dst": dst })).await
}

#[tauri::command]
async fn write_file_bytes(path: String, b64: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<(), String> {
    client.post("/v1/file/write-bytes", &serde_json::json!({ "path": path, "b64": b64 })).await
}

#[tauri::command]
async fn copy_file(src: String, dst: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<(), String> {
    client.post("/v1/file/copy", &serde_json::json!({ "src": src, "dst": dst })).await
}

#[tauri::command]
async fn list_code_files(dir: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    let q = format!("/v1/code-files?dir={}", urlencoding::encode(&dir));
    client.get(&q).await
}

#[tauri::command]
async fn list_capabilities(client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    client.get("/v1/capabilities").await
}

#[tauri::command]
async fn capability_health(id: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    let q = format!("/v1/capabilities/{}/health", urlencoding::encode(&id));
    client.get(&q).await
}

#[tauri::command]
async fn capability_launch(id: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    let q = format!("/v1/capabilities/{}/launch", urlencoding::encode(&id));
    client.post(&q, &serde_json::json!({ "open": false })).await
}

#[tauri::command]
async fn list_mcp_servers(client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    client.get("/v1/mcp/servers").await
}

#[tauri::command]
async fn get_mcp_server(id: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    let q = format!("/v1/mcp/servers/{}", urlencoding::encode(&id));
    client.get(&q).await
}

#[tauri::command]
async fn mcp_server_health(id: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    let q = format!("/v1/mcp/servers/{}/health", urlencoding::encode(&id));
    client.get(&q).await
}

#[tauri::command]
async fn sync_mcp_servers(apply: bool, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    client.post("/v1/mcp/sync", &serde_json::json!({ "apply": apply })).await
}

/// Mutate libraries/mcp/<id>/mcp.json's `hosts.<host>.enabled` flag in place.
/// Tauri-side because it's a tiny JSON write that doesn't need the orgd
/// supervisor; the file lives in ORG_ROOT and we already have AppState for it.
#[tauri::command]
async fn set_mcp_host_enabled(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    host: String,
    enabled: bool,
) -> Result<(), String> {
    if host != "claude" && host != "codex" {
        return Err(format!("unknown host: {host}"));
    }
    let path = state.org_root.join("libraries").join("mcp").join(&id).join("mcp.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let hosts = v.get_mut("hosts").and_then(|h| h.as_object_mut())
        .ok_or_else(|| "manifest has no hosts object".to_string())?;
    let host_cfg = hosts.entry(host.clone()).or_insert_with(|| serde_json::json!({ "enabled": false }));
    let host_obj = host_cfg.as_object_mut()
        .ok_or_else(|| format!("hosts.{host} is not an object"))?;
    host_obj.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{pretty}\n")).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_env_var(name: String) -> Result<String, String> {
    std::env::var(&name).map_err(|_| format!("env var {} not set", name))
}

/// Check whether `name` resolves to an executable on PATH.
///
/// Used by the frontend to detect missing agent CLIs (claude, codex, etc.)
/// on first run. Returns true if found, false otherwise. Never errors —
/// "not found" is a valid outcome, not a failure mode.
#[tauri::command]
fn check_command_on_path(name: String) -> bool {
    // Reject anything that looks like a path or contains shell metacharacters;
    // we only want to probe simple command names.
    if name.is_empty() || name.contains(['/', '\\', ' ', '"', '\'', ';', '&', '|']) {
        return false;
    }

    let probe = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(probe)
        .arg(&name)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Find the most recently modified Claude Code session id for `cwd`.
///
/// Claude stores per-project session transcripts at
/// `~/.claude/projects/<slug>/<sessionId>.jsonl`, where the slug is the cwd
/// with `:`, `\`, and `/` replaced by `-`. The session id is the file stem.
///
/// `since_ms` (Unix epoch milliseconds, optional) bounds the search to files
/// modified at or after that time — used by the AgentTile restart flow to
/// avoid latching onto a session from a previous tile that shared the cwd.
#[tauri::command]
fn find_recent_claude_session(cwd: String, since_ms: Option<i64>) -> Result<Option<String>, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| "no home directory in env".to_string())?;
    let slug: String = cwd.chars()
        .map(|c| if c == ':' || c == '\\' || c == '/' { '-' } else { c })
        .collect();
    let dir = PathBuf::from(home).join(".claude").join("projects").join(&slug);
    let entries = match std::fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return Ok(None),
    };
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
        let Ok(meta) = e.metadata() else { continue; };
        let Ok(mtime) = meta.modified() else { continue; };
        if let Some(since) = since_ms {
            if let Ok(d) = mtime.duration_since(std::time::UNIX_EPOCH) {
                if (d.as_millis() as i64) < since { continue; }
            }
        }
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else { continue; };
        match &best {
            Some((bt, _)) if mtime <= *bt => {}
            _ => best = Some((mtime, stem.to_string())),
        }
    }
    Ok(best.map(|(_, s)| s))
}

#[tauri::command]
async fn read_org_config(
    state: tauri::State<'_, Arc<AppState>>,
    client: tauri::State<'_, orgd_client::OrgdClient>,
) -> Result<String, String> {
    let path = state.org_root.join("org.config.json");
    let q = format!("/v1/file/read?path={}", urlencoding::encode(&path.to_string_lossy()));
    let resp: serde_json::Value = client.get(&q).await?;
    resp.get("content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "invalid file read response".to_string())
}

#[tauri::command]
async fn write_org_config(
    content: String,
    state: tauri::State<'_, Arc<AppState>>,
    client: tauri::State<'_, orgd_client::OrgdClient>,
) -> Result<(), String> {
    let path = state.org_root.join("org.config.json");
    client.post(
        "/v1/file/write",
        &serde_json::json!({ "path": path.to_string_lossy(), "content": content }),
    ).await
}

#[tauri::command]
fn log_frontend_error(level: String, message: String, source: Option<String>) {
    let src = source.unwrap_or_else(|| "frontend".to_string());
    match level.as_str() {
        "error" => log::error!(target: "frontend", "[{}] {}", src, message),
        "warn"  => log::warn!(target: "frontend", "[{}] {}", src, message),
        _       => log::info!(target: "frontend", "[{}] {}", src, message),
    }
}

#[tauri::command]
async fn list_routines(client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    client.get("/v1/routines").await
}

#[tauri::command]
async fn get_routine(name: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    let q = format!("/v1/routines/{}", urlencoding::encode(&name));
    client.get(&q).await
}

#[tauri::command]
async fn create_routine(name: String, content: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    client.post("/v1/routines", &serde_json::json!({ "name": name, "content": content })).await
}

#[tauri::command]
async fn update_routine(name: String, content: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    let q = format!("/v1/routines/{}", urlencoding::encode(&name));
    let url = format!("{}{}", client.base_url(), q);
    let resp = reqwest::Client::new()
        .put(&url)
        .bearer_auth(client.token())
        .json(&serde_json::json!({ "content": content }))
        .send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let raw = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() { return Err(format!("{status}: {raw}")); }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_routine(name: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<(), String> {
    let q = format!("/v1/routines/{}", urlencoding::encode(&name));
    client.delete(&q).await
}

#[tauri::command]
async fn trigger_routine(
    name: String,
    args: Option<serde_json::Value>,
    client: tauri::State<'_, orgd_client::OrgdClient>,
) -> Result<serde_json::Value, String> {
    let q = format!("/v1/routines/{}/trigger", urlencoding::encode(&name));
    let body = match args {
        Some(a) => serde_json::json!({ "args": a }),
        None => serde_json::json!({}),
    };
    client.post(&q, &body).await
}

#[tauri::command]
async fn list_runs(name: Option<String>, limit: Option<usize>, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    let q = match name {
        Some(n) => format!("/v1/routines/{}/runs?limit={}", urlencoding::encode(&n), limit.unwrap_or(20)),
        None => format!("/v1/runs?limit={}", limit.unwrap_or(20)),
    };
    client.get(&q).await
}

#[tauri::command]
async fn get_run(id: String, client: tauri::State<'_, orgd_client::OrgdClient>) -> Result<serde_json::Value, String> {
    let q = format!("/v1/runs/{}", urlencoding::encode(&id));
    client.get(&q).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillHostStatus {
    enabled: bool,
    state: &'static str,
    path: Option<String>,
    implicit: Option<bool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillValidation {
    state: &'static str,
    warnings: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillSummary {
    name: String,
    description: String,
    risk: String,
    tags: Vec<String>,
    hosts: serde_json::Value,
    validation: SkillValidation,
}

fn resolve_skill_artifact_path(org_root: &std::path::Path, raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return PathBuf::from(home).join(rest);
        }
    }
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        org_root.join(path)
    }
}

fn remove_skill_host_artifact(
    org_root: &std::path::Path,
    name: &str,
    host: &str,
    host_cfg: Option<&serde_json::Value>,
) -> Result<(), String> {
    if host == "openai" {
        let configured = host_cfg
            .and_then(|v| v.get("install_path"))
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| "");
        let raw_path = if configured.trim().is_empty() {
            format!(".agents/skills/{name}")
        } else {
            configured.to_string()
        };
        let target = resolve_skill_artifact_path(org_root, &raw_path);
        let allowed_root = org_root.join(".agents").join("skills");
        if !target.starts_with(&allowed_root) {
            return Err(format!("refusing to remove OpenAI skill artifact outside {}", allowed_root.display()));
        }
        if target.is_dir() {
            std::fs::remove_dir_all(&target)
                .map_err(|e| format!("failed to remove {}: {e}", target.display()))?;
        } else if target.is_file() {
            std::fs::remove_file(&target)
                .map_err(|e| format!("failed to remove {}: {e}", target.display()))?;
        }
        return Ok(());
    }

    let configured = host_cfg
        .and_then(|v| v.get("output_path"))
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| "");
    let raw_path = if configured.trim().is_empty() {
        format!("~/.claude/commands/{name}.md")
    } else {
        configured.to_string()
    };
    let configured_path = resolve_skill_artifact_path(org_root, &raw_path);
    let project_path = org_root.join(".claude").join("commands").join(format!("{name}.md"));
    let user_path = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .map(|h| h.join(".claude").join("commands").join(format!("{name}.md")));

    let mut targets = vec![configured_path, project_path];
    if let Some(path) = user_path {
        targets.push(path);
    }
    targets.sort();
    targets.dedup();

    let expected_file = format!("{name}.md");
    for target in targets {
        if target.file_name().and_then(|f| f.to_str()) != Some(expected_file.as_str()) {
            return Err(format!("refusing to remove unexpected Claude skill path {}", target.display()));
        }
        if target.is_file() {
            std::fs::remove_file(&target)
                .map_err(|e| format!("failed to remove {}: {e}", target.display()))?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn list_skills(state: tauri::State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    let dir = state.org_root.join("libraries").join("skills");
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
            let name = e.file_name().to_string_lossy().to_string();
            let manifest = e.path().join("skill.json");
            let skill_md = e.path().join("SKILL.md");
            let claude_project_path = state.org_root.join(".claude").join("commands").join(format!("{name}.md"));
            let claude_user_path = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from)
                .map(|h| h.join(".claude").join("commands").join(format!("{name}.md")));

            let mut description = String::new();
            let mut risk = "instruction-only".to_string();
            let mut tags = Vec::new();
            let mut host_cfg = serde_json::Value::Null;
            if let Ok(raw) = std::fs::read_to_string(&manifest) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(d) = v.get("description").and_then(|x| x.as_str()) {
                        description = d.to_string();
                    }
                    if let Some(r) = v.get("risk").and_then(|x| x.as_str()) {
                        risk = r.to_string();
                    }
                    tags = v.get("tags")
                        .and_then(|x| x.as_array())
                        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_default();
                    host_cfg = v.get("hosts").cloned().unwrap_or(serde_json::Value::Null);
                }
            }

            let mut warnings = Vec::new();
            if !manifest.is_file() { warnings.push("missing skill.json".to_string()); }
            if !skill_md.is_file() { warnings.push("missing SKILL.md".to_string()); }
            if description.trim().is_empty() { warnings.push("missing description".to_string()); }
            if !description.starts_with("Use ") && !description.starts_with("Run ") && !description.starts_with("Operate ") {
                warnings.push("description may be too weak for implicit skill matching".to_string());
            }

            let openai_cfg = host_cfg.get("openai").or_else(|| host_cfg.get("codex"));
            let openai_install_path = openai_cfg
                .and_then(|v| v.get("install_path"))
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| "");
            let openai_dir = if openai_install_path.trim().is_empty() {
                state.org_root.join(".agents").join("skills").join(&name)
            } else {
                resolve_skill_artifact_path(&state.org_root, openai_install_path)
            };
            let openai_skill_md = openai_dir.join("SKILL.md");
            let openai_enabled = openai_cfg.and_then(|v| v.get("enabled")).and_then(|v| v.as_bool()).unwrap_or(false);
            let openai_implicit = openai_cfg
                .and_then(|v| v.get("allow_implicit_invocation"))
                .and_then(|v| v.as_bool());
            let claude_enabled = host_cfg.get("claude")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool())
                .unwrap_or(true);

            let claude_path = if claude_project_path.is_file() {
                Some(claude_project_path)
            } else if let Some(p) = claude_user_path.filter(|p| p.is_file()) {
                Some(p)
            } else {
                None
            };

            let hosts = serde_json::json!({
                "openai": SkillHostStatus {
                    enabled: openai_enabled,
                    state: if openai_skill_md.is_file() { "installed" } else if openai_enabled { "missing" } else { "disabled" },
                    path: if openai_skill_md.is_file() { Some(openai_dir.to_string_lossy().into_owned()) } else { None },
                    implicit: openai_implicit,
                },
                "claude": SkillHostStatus {
                    enabled: claude_enabled,
                    state: if claude_path.is_some() { "installed" } else if claude_enabled { "missing" } else { "disabled" },
                    path: claude_path.map(|p| p.to_string_lossy().into_owned()),
                    implicit: None,
                }
            });

            out.push(serde_json::to_value(SkillSummary {
                name,
                description,
                risk,
                tags,
                hosts,
                validation: SkillValidation {
                    state: if warnings.is_empty() { "ok" } else { "warning" },
                    warnings,
                },
            }).map_err(|e| e.to_string())?);
        }
    }
    out.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")));
    Ok(serde_json::Value::Array(out))
}

fn run_skill_generator(org_root: &std::path::Path, args: &[&str]) -> Result<String, String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut cmd = std::process::Command::new("python");
    cmd.args(args).current_dir(org_root);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| format!("failed to run skill generator: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!("skill generator failed\n{stdout}\n{stderr}"));
    }
    Ok(stdout)
}

#[tauri::command]
async fn sync_skill(state: tauri::State<'_, Arc<AppState>>, name: String) -> Result<String, String> {
    run_skill_generator(&state.org_root, &["scripts/generate-skills.py", "--host", "openai", "--skill", &name])?;
    run_skill_generator(&state.org_root, &["scripts/generate-skills.py", "--host", "claude", "--skill", &name])
}

#[tauri::command]
async fn sync_all_skills(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    run_skill_generator(&state.org_root, &["scripts/generate-skills.py", "--host", "all"])
}

#[tauri::command]
async fn set_skill_host_enabled(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    host: String,
    enabled: bool,
) -> Result<(), String> {
    if host != "openai" && host != "claude" {
        return Err(format!("unsupported skill host: {host}"));
    }

    let path = state.org_root
        .join("libraries")
        .join("skills")
        .join(&name)
        .join("skill.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    let mut value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("invalid skill.json for {name}: {e}"))?;

    let obj = value.as_object_mut()
        .ok_or_else(|| format!("skill.json for {name} is not an object"))?;
    let hosts = obj.entry("hosts")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("hosts in {name}/skill.json is not an object"))?;

    if host == "openai" {
        let default_path = format!(".agents/skills/{name}");
        let host_cfg = hosts.entry("openai").or_insert_with(|| {
            serde_json::json!({
                "scope": "repo",
                "install_path": default_path,
                "allow_implicit_invocation": false
            })
        });
        let cfg = host_cfg.as_object_mut()
            .ok_or_else(|| format!("hosts.openai in {name}/skill.json is not an object"))?;
        cfg.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
        cfg.entry("scope").or_insert_with(|| serde_json::Value::String("repo".to_string()));
        cfg.entry("install_path").or_insert_with(|| serde_json::Value::String(format!(".agents/skills/{name}")));
        cfg.entry("allow_implicit_invocation").or_insert_with(|| serde_json::Value::Bool(false));
    } else {
        let host_cfg = hosts.entry("claude").or_insert_with(|| {
            serde_json::json!({
                "output_path": format!("~/.claude/commands/{name}.md")
            })
        });
        let cfg = host_cfg.as_object_mut()
            .ok_or_else(|| format!("hosts.claude in {name}/skill.json is not an object"))?;
        cfg.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
        cfg.entry("output_path").or_insert_with(|| serde_json::Value::String(format!("~/.claude/commands/{name}.md")));
    }

    let pretty = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{pretty}\n"))
        .map_err(|e| format!("failed to write {}: {e}", path.display()))?;

    if !enabled {
        let host_cfg = value.get("hosts").and_then(|hosts| hosts.get(&host));
        remove_skill_host_artifact(&state.org_root, &name, &host, host_cfg)?;
    }

    Ok(())
}

#[tauri::command]
async fn append_permission_log(
    state: tauri::State<'_, Arc<AppState>>,
    client: tauri::State<'_, orgd_client::OrgdClient>,
    entry: String,
) -> Result<(), String> {
    let log_dir = state.org_root.join("setup").join("logs");
    let path = log_dir.join("permission-requests.jsonl");
    client.post(
        "/v1/file/append",
        &serde_json::json!({ "path": path.to_string_lossy(), "content": format!("{entry}\n") }),
    ).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let org_root = std::env::args().nth(1)
        .map(PathBuf::from)
        .or_else(|| std::env::var("ORG_ROOT").ok().map(PathBuf::from))
        .unwrap_or_else(|| find_org_root());

    // Capture panics with backtrace + thread + location to the log target.
    // Without this, a panic on a background thread silently exits the process.
    std::panic::set_hook(Box::new(|info| {
        let location = info.location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let thread = std::thread::current().name().unwrap_or("<unnamed>").to_string();
        let payload = info.payload();
        let msg = if let Some(s) = payload.downcast_ref::<&str>() { (*s).to_string() }
            else if let Some(s) = payload.downcast_ref::<String>() { s.clone() }
            else { "<non-string panic payload>".into() };
        log::error!(target: "panic", "PANIC [{thread}] at {location}: {msg}");
        eprintln!("PANIC [{thread}] at {location}: {msg}");
    }));

    let state = Arc::new(AppState { org_root: org_root.clone() });

    tauri::Builder::default()
        .on_window_event(|_window, event| {
            use tauri::WindowEvent;
            // Flip WINDOW_ALIVE the moment the window starts closing so PTY
            // reader threads and the FS watcher stop emitting into a
            // tearing-down WebView2. Without this, msedge.dll crashes under
            // the IPC flood and takes Claude PTY children with it.
            if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
                WINDOW_ALIVE.store(false, Ordering::Relaxed);
            }
        })
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("org-viewer".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .manage(state.clone())
        .setup(move |app| {
            let handle = app.handle().clone();

            // Clean up AUMID registry key if previously written — writing to
            // HKCU\SOFTWARE\Classes\AppUserModelId\<id> breaks WebView2's internal
            // content scheme (ERR_CONNECTION_REFUSED). No-op if key doesn't exist.
            let _ = std::process::Command::new("reg")
                .args(["delete", r"HKCU\SOFTWARE\Classes\AppUserModelId\com.org-viewer.app", "/f"])
                .output();

            // Bring up orgd (or attach to a running one). orgd owns the
            // FS watcher and emits `org-changed` over WS; the pump
            // re-emits it to the webview under the same name the
            // frontend already listens for.
            match orgd_client::OrgdClient::start_or_attach(&org_root) {
                Ok(client) => {
                    orgd_client::spawn_event_pump(client.clone(), handle.clone());
                    app.manage(client);
                }
                Err(e) => {
                    log::error!("orgd startup failed: {e}");
                    return Err(e.into());
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_org_root,
            get_documents,
            get_relations,
            read_file,
            write_file,
            read_file_base64,
            write_file_bytes,
            list_code_files,
            list_capabilities,
            capability_health,
            capability_launch,
            move_file,
            copy_file,
            pty::pty_create,
            pty::pty_buffer,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            worker::worker_start,
            worker::worker_kill,
            worker::worker_buffer,
            worker::worker_is_running,
            append_permission_log,
            list_routines,
            get_routine,
            create_routine,
            update_routine,
            delete_routine,
            trigger_routine,
            list_runs,
            get_run,
            list_skills,
            sync_skill,
            sync_all_skills,
            set_skill_host_enabled,
            list_mcp_servers,
            get_mcp_server,
            mcp_server_health,
            sync_mcp_servers,
            set_mcp_host_enabled,
            log_frontend_error,
            open_external_url,
            get_env_var,
            check_command_on_path,
            find_recent_claude_session,
            read_org_config,
            write_org_config,
            frontmatter::save_pasted_asset,
            frontmatter::save_clipboard_image,
            frontmatter::update_frontmatter,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            use tauri::RunEvent;
            // Belt-and-suspenders: catch app-level shutdown signals too, so any
            // background thread emitting after this point becomes a no-op.
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                WINDOW_ALIVE.store(false, Ordering::Relaxed);
            }
        });
}
