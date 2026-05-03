use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;
use regex::Regex;
use once_cell::sync::Lazy;

static WIKILINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]").unwrap());

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OrgDocument {
    pub path: String,
    pub filename: String,
    pub title: String,
    pub content: String,
    pub frontmatter: serde_json::Value,
    #[serde(rename = "type")]
    pub doc_type: String,
    pub status: Option<String>,
    pub tags: Vec<String>,
    pub created: Option<String>,
    pub updated: Option<String>,
    pub links: Vec<String>,
    // --- Beads-style task graph fields (all optional / additive). See
    // projects/org-viewer-linear-rewrite/README.md for the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
    #[serde(default, rename = "blockedBy", skip_serializing_if = "Vec::is_empty")]
    pub blocked_by: Vec<String>,
    #[serde(default, rename = "relatesTo", skip_serializing_if = "Vec::is_empty")]
    pub relates_to: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    #[serde(default, rename = "duplicateOf", skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub extension: String,
}

pub fn scan_org(root: &Path) -> Vec<OrgDocument> {
    let mut docs = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map_or(false, |ext| ext == "md"))
    {
        let path = entry.path();
        // Skip hidden dirs and .git
        if path.components().any(|c| {
            let s = c.as_os_str().to_string_lossy();
            s.starts_with('.') || s == "node_modules" || s == "target" || s == "templates" || s == "archive"
        }) {
            continue;
        }
        if let Some(doc) = parse_doc(path) {
            docs.push(doc);
        }
    }
    docs
}

fn parse_doc(path: &Path) -> Option<OrgDocument> {
    let raw = std::fs::read_to_string(path).ok()?;
    let filename = path.file_name()?.to_string_lossy().to_string();

    let (frontmatter_val, content) = extract_frontmatter(&raw);

    let doc_type = frontmatter_val.get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("note")
        .to_string();

    let status = frontmatter_val.get("status")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let tags: Vec<String> = frontmatter_val.get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|t| t.as_str()).map(|s| s.to_string()).collect())
        .unwrap_or_default();

    let created = frontmatter_val.get("created")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let updated = frontmatter_val.get("updated")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let kind = fm_string(&frontmatter_val, "kind");
    let parent = fm_string(&frontmatter_val, "parent");
    let priority = fm_string(&frontmatter_val, "priority");
    let due = fm_string(&frontmatter_val, "due");
    let supersedes = fm_string(&frontmatter_val, "supersedes");
    let duplicate_of = fm_string(&frontmatter_val, "duplicate-of");
    let blocked_by = fm_string_array(&frontmatter_val, "blocked-by");
    let relates_to = fm_string_array(&frontmatter_val, "relates-to");
    let references = fm_string_array(&frontmatter_val, "references");

    // Title from first # heading or filename
    let title = content.lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l[2..].trim().to_string())
        .unwrap_or_else(|| filename.trim_end_matches(".md").replace('-', " ").to_string());

    // Extract wikilinks
    let links: Vec<String> = WIKILINK_RE.captures_iter(&raw)
        .map(|cap| cap[1].trim().to_string())
        .collect();

    Some(OrgDocument {
        path: path.to_string_lossy().to_string(),
        filename,
        title,
        content,
        frontmatter: frontmatter_val,
        doc_type,
        status,
        tags,
        created,
        updated,
        links,
        kind,
        parent,
        priority,
        due,
        blocked_by,
        relates_to,
        references,
        supersedes,
        duplicate_of,
    })
}

/// Read a string field from frontmatter, treating `null`/empty/whitespace as None.
fn fm_string(val: &serde_json::Value, key: &str) -> Option<String> {
    let s = val.get(key).and_then(|v| v.as_str())?.trim();
    if s.is_empty() || s == "null" || s == "~" { None } else { Some(s.to_string()) }
}

/// Read a string-array field from frontmatter. Accepts `[]`, `[a, b]`, or a single string
/// (treated as a one-element array).
fn fm_string_array(val: &serde_json::Value, key: &str) -> Vec<String> {
    let Some(v) = val.get(key) else { return Vec::new(); };
    if let Some(arr) = v.as_array() {
        return arr.iter()
            .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect();
    }
    if let Some(s) = v.as_str() {
        let t = s.trim();
        if t.is_empty() || t == "null" || t == "~" { return Vec::new(); }
        return vec![t.to_string()];
    }
    Vec::new()
}

fn extract_frontmatter(raw: &str) -> (serde_json::Value, String) {
    if !raw.starts_with("---") {
        return (serde_json::Value::Object(Default::default()), raw.to_string());
    }
    let rest = &raw[3..];
    if let Some(end) = rest.find("\n---") {
        let yaml_str = &rest[..end];
        let content = rest[end + 4..].trim_start_matches('\n').to_string();
        let parsed = serde_yaml_ok(yaml_str);
        return (parsed, content);
    }
    (serde_json::Value::Object(Default::default()), raw.to_string())
}

fn serde_yaml_ok(yaml: &str) -> serde_json::Value {
    // Simple YAML to JSON conversion for frontmatter
    let mut map = serde_json::Map::new();
    for line in yaml.lines() {
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_string();
            let val_raw = line[colon + 1..].trim();
            if key.is_empty() { continue; }
            let val = parse_yaml_value(val_raw);
            map.insert(key, val);
        }
    }
    serde_json::Value::Object(map)
}

fn parse_yaml_value(s: &str) -> serde_json::Value {
    if s == "null" || s == "~" || s.is_empty() {
        return serde_json::Value::Null;
    }
    if s == "true" { return serde_json::Value::Bool(true); }
    if s == "false" { return serde_json::Value::Bool(false); }
    if let Ok(n) = s.parse::<i64>() { return serde_json::Value::Number(n.into()); }
    // Array: [a, b, c]
    if s.starts_with('[') && s.ends_with(']') {
        let inner = &s[1..s.len() - 1];
        let items: Vec<serde_json::Value> = inner.split(',')
            .map(|item| {
                let trimmed = item.trim().trim_matches('"').trim_matches('\'');
                serde_json::Value::String(trimmed.to_string())
            })
            .filter(|v| !matches!(v, serde_json::Value::String(s) if s.is_empty()))
            .collect();
        return serde_json::Value::Array(items);
    }
    // Strip quotes
    let s = s.trim_matches('"').trim_matches('\'');
    serde_json::Value::String(s.to_string())
}

pub fn list_files(dir: &str) -> Vec<FileEntry> {
    let path = PathBuf::from(dir);
    let mut files = Vec::new();
    for entry in WalkDir::new(&path)
        .max_depth(4)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let p = entry.path();
        if p.components().any(|c| {
            let s = c.as_os_str().to_string_lossy();
            s.starts_with('.') || s == "node_modules" || s == "target" || s == "dist"
        }) {
            continue;
        }
        let ext = p.extension().map_or("", |e| e.to_str().unwrap_or("")).to_string();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        files.push(FileEntry {
            path: p.to_string_lossy().to_string(),
            name: p.file_name().unwrap_or_default().to_string_lossy().to_string(),
            size,
            extension: ext,
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}
