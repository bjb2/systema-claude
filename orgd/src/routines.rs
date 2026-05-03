use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, NaiveDateTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone)]
pub struct RoutineManager {
    root: PathBuf,
    running: Arc<Mutex<HashSet<String>>>,
    cron_fired: Arc<Mutex<HashSet<String>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Routine {
    #[serde(default, skip_deserializing)]
    pub name: String,
    #[serde(default, skip_deserializing)]
    pub path: PathBuf,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default, rename = "run-at")]
    pub run_at: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default = "default_concurrency")]
    pub concurrency: String,
    #[serde(default)]
    pub catchup: Option<bool>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub steps: Vec<Step>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub write: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub read: Option<String>,
    #[serde(default)]
    pub when: Option<String>,
    #[serde(default)]
    pub on_failure: Option<String>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerBody {
    #[serde(default)]
    pub args: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRoutine {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateRoutine {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub routine: String,
    pub started: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished: Option<String>,
    pub status: String,
    pub steps: Vec<StepSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub context: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepSummary {
    pub id: String,
    pub status: String,
    pub duration_ms: u128,
    pub attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TriggerInfo {
    #[serde(rename = "type")]
    kind: String,
    fired_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<Value>,
}

fn default_concurrency() -> String {
    "skip".to_string()
}

fn parse_error_routine(path: &Path, err: String) -> Routine {
    Routine {
        name: path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string(),
        path: path.to_path_buf(),
        status: "disabled".to_string(),
        cron: None,
        run_at: None,
        timezone: None,
        concurrency: default_concurrency(),
        catchup: None,
        tags: Vec::new(),
        description: Some(format!("Parse error: {err}")),
        steps: Vec::new(),
    }
}

impl RoutineManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            running: Arc::new(Mutex::new(HashSet::new())),
            cron_fired: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub fn spawn_loop(&self) {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tick.tick().await;
                manager.poll_due();
            }
        });
    }

    pub fn list(&self) -> Result<Vec<Routine>, String> {
        let dir = self.routines_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut routines = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) == Some("md") {
                match self.load_path(&path) {
                    Ok(routine) => routines.push(routine),
                    Err(err) => routines.push(parse_error_routine(&path, err)),
                }
            }
        }
        routines.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(routines)
    }

    pub fn get(&self, name: &str) -> Result<Routine, String> {
        validate_name(name)?;
        self.load_path(&self.routine_path(name))
    }

    pub fn create(&self, req: CreateRoutine) -> Result<Routine, String> {
        validate_name(&req.name)?;
        let path = self.routine_path(&req.name);
        if path.exists() {
            return Err(format!("routine already exists: {}", req.name));
        }
        fs::create_dir_all(self.routines_dir()).map_err(|e| e.to_string())?;
        fs::write(&path, req.content).map_err(|e| e.to_string())?;
        self.load_path(&path)
    }

    pub fn update(&self, name: &str, req: UpdateRoutine) -> Result<Routine, String> {
        validate_name(name)?;
        let path = self.routine_path(name);
        fs::write(&path, req.content).map_err(|e| e.to_string())?;
        self.load_path(&path)
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        validate_name(name)?;
        fs::remove_file(self.routine_path(name)).map_err(|e| e.to_string())
    }

    pub fn trigger_now(&self, name: &str, args: Option<Value>) -> Result<RunRecord, String> {
        let routine = self.get(name)?;
        self.start_run(routine, TriggerInfo {
            kind: "manual".to_string(),
            fired_at: now_iso(),
            args,
        })
    }

    pub fn list_runs(&self, routine: Option<&str>, limit: usize) -> Result<Vec<RunRecord>, String> {
        let dir = self.runs_dir();
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut runs = Vec::new();
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
            if let Ok(run) = serde_json::from_str::<RunRecord>(&text) {
                if routine.map(|name| name == run.routine).unwrap_or(true) {
                    runs.push(run);
                }
            }
        }
        runs.sort_by(|a, b| b.started.cmp(&a.started));
        runs.truncate(limit);
        Ok(runs)
    }

    pub fn get_run(&self, id: &str) -> Result<RunRecord, String> {
        validate_run_id(id)?;
        let text = fs::read_to_string(self.runs_dir().join(format!("{id}.json"))).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    fn poll_due(&self) {
        let Ok(routines) = self.list() else { return };
        let now = Local::now();
        let minute_key = now.format("%Y%m%d%H%M").to_string();
        for routine in routines {
            if routine.status != "enabled" {
                continue;
            }
            if let Some(run_at) = &routine.run_at {
                if parse_run_at(run_at).map(|dt| dt <= Utc::now()).unwrap_or(false) {
                    let _ = self.start_run(routine, TriggerInfo {
                        kind: "run-at".to_string(),
                        fired_at: now_iso(),
                        args: None,
                    });
                }
                continue;
            }
            if let Some(cron) = &routine.cron {
                if cron_matches(cron, now) {
                    let key = format!("{}:{minute_key}", routine.name);
                    let mut fired = self.cron_fired.lock().unwrap();
                    if fired.insert(key) {
                        drop(fired);
                        let _ = self.start_run(routine, TriggerInfo {
                            kind: "cron".to_string(),
                            fired_at: now_iso(),
                            args: None,
                        });
                    }
                }
            }
        }
    }

    fn start_run(&self, routine: Routine, trigger: TriggerInfo) -> Result<RunRecord, String> {
        if routine.cron.is_some() && routine.run_at.is_some() {
            return Err("routine cannot declare both cron and run-at".to_string());
        }
        if routine.concurrency == "skip" {
            let mut running = self.running.lock().unwrap();
            if running.contains(&routine.name) {
                return Err(format!("routine already running: {}", routine.name));
            }
            running.insert(routine.name.clone());
        }

        let id = format!("{}-{:06x}", Local::now().format("%Y%m%d-%H%M%S"), rand::random::<u32>() & 0x00ff_ffff);
        let run = RunRecord {
            id: id.clone(),
            routine: routine.name.clone(),
            started: now_iso(),
            finished: None,
            status: "running".to_string(),
            steps: Vec::new(),
            error: None,
            context: initial_context(&id, &routine.name, &trigger),
        };
        self.persist_run(&run)?;

        let manager = self.clone();
        tokio::spawn(async move {
            let finished = manager.execute_run(run, routine.clone()).await;
            manager.running.lock().unwrap().remove(&routine.name);
            if routine.run_at.is_some() && finished.as_ref().map(|r| r.status.as_str()) == Ok("ok") {
                let _ = manager.mark_completed(&routine.path);
            }
        });

        self.get_run(&id)
    }

    async fn execute_run(&self, mut run: RunRecord, routine: Routine) -> Result<RunRecord, String> {
        let mut failed = None;
        for step in &routine.steps {
            if !should_run(step, &run.context) {
                continue;
            }
            let started = std::time::Instant::now();
            match execute_step(&self.root, &mut run.context, &run.id, step).await {
                Ok(value) => {
                    set_step_context(&mut run.context, &step.id, value);
                    run.steps.push(StepSummary {
                        id: step.id.clone(),
                        status: "ok".to_string(),
                        duration_ms: started.elapsed().as_millis(),
                        attempts: 1,
                        error: None,
                    });
                }
                Err(err) => {
                    set_step_context(&mut run.context, &step.id, serde_json::json!({ "status": "failed", "error": err }));
                    run.steps.push(StepSummary {
                        id: step.id.clone(),
                        status: "failed".to_string(),
                        duration_ms: started.elapsed().as_millis(),
                        attempts: 1,
                        error: Some(err.clone()),
                    });
                    if step.on_failure.as_deref().unwrap_or("abort") != "continue" {
                        failed = Some(err);
                        let _ = self.persist_run(&run);
                        break;
                    }
                }
            }
            let _ = self.persist_run(&run);
        }
        run.finished = Some(now_iso());
        run.status = if failed.is_some() { "failed".to_string() } else { "ok".to_string() };
        run.error = failed;
        self.persist_run(&run)?;
        Ok(run)
    }

    fn load_path(&self, path: &Path) -> Result<Routine, String> {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let mut routine: Routine = serde_yaml::from_str(extract_frontmatter(&text)?).map_err(|e| e.to_string())?;
        routine.name = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        routine.path = path.to_path_buf();
        if routine.status.is_empty() {
            routine.status = "disabled".to_string();
        }
        Ok(routine)
    }

    fn persist_run(&self, run: &RunRecord) -> Result<(), String> {
        fs::create_dir_all(self.runs_dir()).map_err(|e| e.to_string())?;
        fs::write(
            self.runs_dir().join(format!("{}.json", run.id)),
            serde_json::to_string_pretty(run).map_err(|e| e.to_string())?,
        ).map_err(|e| e.to_string())
    }

    fn mark_completed(&self, path: &Path) -> Result<(), String> {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        fs::write(path, set_frontmatter_status(&text, "completed")?).map_err(|e| e.to_string())
    }

    fn routines_dir(&self) -> PathBuf { self.root.join("routines") }
    fn runs_dir(&self) -> PathBuf { self.routines_dir().join("runs") }
    fn routine_path(&self, name: &str) -> PathBuf { self.routines_dir().join(format!("{name}.md")) }
}

async fn execute_step(root: &Path, context: &mut Value, run_id: &str, step: &Step) -> Result<Value, String> {
    if let Some(cmd) = &step.run {
        return run_shell(root, &render(cmd, context));
    }
    if let Some(prompt) = &step.agent {
        return run_agent(root, run_id, &step.id, &render(prompt, context), step.model.as_deref());
    }
    if let Some(path) = &step.write {
        let rel = render(path, context);
        let full = root.join(&rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&full, render(step.content.as_deref().unwrap_or_default(), context)).map_err(|e| e.to_string())?;
        return Ok(serde_json::json!({ "status": "ok", "path": rel }));
    }
    if let Some(path) = &step.read {
        let rel = render(path, context);
        let content = fs::read_to_string(root.join(&rel)).map_err(|e| e.to_string())?;
        return Ok(serde_json::json!({ "status": "ok", "content": content, "path": rel }));
    }
    Err(format!("step {} has no executable action", step.id))
}

fn run_shell(root: &Path, command: &str) -> Result<Value, String> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    let output = cmd.current_dir(root).stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(if stderr.trim().is_empty() { stdout } else { stderr });
    }
    Ok(serde_json::json!({ "status": "ok", "stdout": stdout, "stderr": stderr, "exit": output.status.code().unwrap_or(0) }))
}

fn run_agent(root: &Path, run_id: &str, step_id: &str, prompt: &str, model: Option<&str>) -> Result<Value, String> {
    let program = resolve_program("claude").ok_or_else(|| "program not found in PATH: claude".to_string())?;
    let mut args = vec![
        "-p".to_string(),
        prompt.to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
    ];
    if let Some(model) = model {
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    let output = Command::new(program).args(args).current_dir(root).stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| e.to_string())?;
    let transcript_dir = root.join("routines").join("runs").join(run_id);
    fs::create_dir_all(&transcript_dir).map_err(|e| e.to_string())?;
    let transcript = transcript_dir.join(format!("{step_id}.transcript.jsonl"));
    fs::write(&transcript, &output.stdout).map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(serde_json::json!({ "status": "ok", "output": extract_agent_text(&stdout), "transcript": transcript.to_string_lossy() }))
}

#[cfg(windows)]
fn resolve_program(name: &str) -> Option<PathBuf> {
    let p = Path::new(name);
    if p.is_absolute() || name.contains('/') || name.contains('\\') {
        return Some(p.to_path_buf());
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let direct = dir.join(name);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in pathext.split(';').filter(|s| !s.is_empty()) {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn resolve_program(name: &str) -> Option<PathBuf> {
    Some(PathBuf::from(name))
}

fn extract_frontmatter(text: &str) -> Result<&str, String> {
    let rest = text.strip_prefix("---").ok_or_else(|| "missing frontmatter".to_string())?;
    let rest = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n')).unwrap_or(rest);
    Ok(rest.find("\n---").map(|marker| &rest[..marker]).unwrap_or(rest))
}

fn set_frontmatter_status(text: &str, status: &str) -> Result<String, String> {
    let rest = text.strip_prefix("---").ok_or_else(|| "missing frontmatter".to_string())?;
    let newline = if rest.starts_with("\r\n") { "\r\n" } else { "\n" };
    let rest = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n')).unwrap_or(rest);
    let marker = rest.find("\n---").ok_or_else(|| "unterminated frontmatter".to_string())?;
    let fm = &rest[..marker];
    let body = &rest[marker..];
    let mut saw = false;
    let mut lines = Vec::new();
    for line in fm.lines() {
        if line.trim_start().starts_with("status:") {
            lines.push(format!("status: {status}"));
            saw = true;
        } else {
            lines.push(line.to_string());
        }
    }
    if !saw {
        lines.push(format!("status: {status}"));
    }
    Ok(format!("---{newline}{}{body}", lines.join(newline)))
}

fn initial_context(id: &str, routine: &str, trigger: &TriggerInfo) -> Value {
    serde_json::json!({
        "run": {
            "id": id,
            "date": Local::now().format("%Y-%m-%d").to_string(),
            "started": now_iso(),
            "routine": routine,
        },
        "trigger": trigger,
        "steps": {},
    })
}

fn set_step_context(context: &mut Value, id: &str, mut value: Value) {
    if value.get("status").is_none() {
        if let Some(obj) = value.as_object_mut() {
            obj.insert("status".to_string(), Value::String("ok".to_string()));
        }
    }
    context["steps"][id] = value;
}

fn should_run(step: &Step, context: &Value) -> bool {
    match step.when.as_deref() {
        None | Some("") => true,
        Some(expr) => lookup(context, expr.trim()).map(|v| match v {
            Value::Bool(b) => *b,
            Value::String(s) => !s.is_empty() && s != "false",
            Value::Null => false,
            _ => true,
        }).unwrap_or(false),
    }
}

fn render(template: &str, context: &Value) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find("}}") {
            out.push_str(&lookup_string(context, after[..end].trim()));
            rest = &after[end + 2..];
        } else {
            out.push_str(&rest[start..]);
            return out;
        }
    }
    out.push_str(rest);
    out
}

fn lookup_string(context: &Value, key: &str) -> String {
    lookup(context, key).map(|v| match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }).unwrap_or_default()
}

fn lookup<'a>(context: &'a Value, key: &str) -> Option<&'a Value> {
    let mut cur = context;
    for part in key.split('.') {
        cur = cur.get(part)?;
    }
    Some(cur)
}

fn extract_agent_text(stdout: &str) -> String {
    let mut last_text = String::new();
    for line in stdout.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(text) = v.pointer("/message/content/0/text").and_then(|v| v.as_str()) {
                last_text = text.to_string();
            } else if let Some(text) = v.get("result").and_then(|v| v.as_str()) {
                last_text = text.to_string();
            }
        }
    }
    if last_text.is_empty() { stdout.to_string() } else { last_text }
}

fn parse_run_at(raw: &str) -> Result<DateTime<Utc>, String> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
        return Ok(dt.with_timezone(&Utc));
    }
    let naive = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S").map_err(|e| e.to_string())?;
    naive.and_local_timezone(Local).single()
        .map(|dt| dt.with_timezone(&Utc))
        .ok_or_else(|| "ambiguous local run-at datetime".to_string())
}

fn cron_matches(expr: &str, now: DateTime<Local>) -> bool {
    let parts: Vec<&str> = expr.split_whitespace().collect();
    parts.len() == 5
        && field_matches(parts[0], now.minute(), 0, 59, &[])
        && field_matches(parts[1], now.hour(), 0, 23, &[])
        && field_matches(parts[2], now.day(), 1, 31, &[])
        && field_matches(parts[3], now.month(), 1, 12, &month_names())
        && field_matches(parts[4], now.weekday().num_days_from_sunday(), 0, 6, &dow_names())
}

fn field_matches(expr: &str, value: u32, min: u32, max: u32, names: &[(&str, u32)]) -> bool {
    expr.split(',').any(|part| {
        let part = part.trim().to_ascii_uppercase();
        if part == "*" {
            return true;
        }
        if let Some(step) = part.strip_prefix("*/").and_then(|s| s.parse::<u32>().ok()) {
            return step > 0 && value % step == 0;
        }
        if let Some((a, b)) = part.split_once('-') {
            let start = parse_field_value(a, names).unwrap_or(min);
            let end = parse_field_value(b, names).unwrap_or(max);
            return value >= start && value <= end;
        }
        parse_field_value(&part, names).map(|v| v == value).unwrap_or(false)
    })
}

fn parse_field_value(raw: &str, names: &[(&str, u32)]) -> Option<u32> {
    names.iter().find(|(name, _)| *name == raw).map(|(_, v)| *v).or_else(|| raw.parse().ok())
}

fn month_names() -> [(&'static str, u32); 12] {
    [("JAN", 1), ("FEB", 2), ("MAR", 3), ("APR", 4), ("MAY", 5), ("JUN", 6), ("JUL", 7), ("AUG", 8), ("SEP", 9), ("OCT", 10), ("NOV", 11), ("DEC", 12)]
}

fn dow_names() -> [(&'static str, u32); 7] {
    [("SUN", 0), ("MON", 1), ("TUE", 2), ("WED", 3), ("THU", 4), ("FRI", 5), ("SAT", 6)]
}

fn validate_name(name: &str) -> Result<(), String> {
    if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err("invalid routine name".to_string())
    }
}

fn validate_run_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err("invalid run id".to_string())
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}
