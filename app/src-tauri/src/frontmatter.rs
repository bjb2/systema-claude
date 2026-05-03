// Surgical frontmatter editing + asset persistence + cycle detection.
// Used by the linear-rewrite properties rail (T1.5/T1.6) and paste/drop
// handlers (T1.4).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose};
use serde_json::Value as JsonValue;
use serde_yaml::Value as YamlValue;
use sha2::{Digest, Sha256};

use crate::AppState;
use serde::Deserialize;

/// Slim mirror of orgd's OrgDocument carrying only the fields cycle
/// detection inspects. Deserialized from GET /v1/documents.
#[derive(Deserialize, Clone)]
pub struct OrgDocument {
    pub path: String,
    pub filename: String,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub blocked_by: Vec<String>,
}

// ---------- T1.4: save_pasted_asset ----------

/// Read a PNG image directly from the OS clipboard and persist it as an asset
/// next to `near_path`. Used as a fallback when the WebView's `paste` event
/// does not expose `clipboardData.items` for raw bitmaps (Win+Shift+S
/// screenshots on WebView2 hit this path).
#[tauri::command]
pub fn save_clipboard_image(
    near_path: String,
    _state: tauri::State<Arc<AppState>>,
) -> Result<String, String> {
    use std::io::Cursor;

    let mut clip = arboard::Clipboard::new()
        .map_err(|e| format!("clipboard open failed: {}", e))?;
    let img = clip
        .get_image()
        .map_err(|e| format!("no image in clipboard: {}", e))?;

    // arboard returns RGBA8 bytes. Encode to PNG.
    let raw = img.bytes.into_owned();
    let buffer: image::RgbaImage = image::ImageBuffer::from_raw(
        img.width as u32,
        img.height as u32,
        raw,
    )
    .ok_or_else(|| "clipboard image had unexpected byte count".to_string())?;
    let mut png_bytes: Vec<u8> = Vec::new();
    image::DynamicImage::ImageRgba8(buffer)
        .write_to(&mut Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("png encode failed: {}", e))?;

    persist_asset_bytes(&near_path, "png", &png_bytes)
}

#[tauri::command]
pub fn save_pasted_asset(
    near_path: String,
    ext: String,
    bytes_b64: String,
    _state: tauri::State<Arc<AppState>>,
) -> Result<String, String> {
    let ext_clean = sanitize_ext(&ext)?;
    let bytes = general_purpose::STANDARD
        .decode(&bytes_b64)
        .map_err(|e| format!("base64 decode failed: {}", e))?;
    persist_asset_bytes(&near_path, &ext_clean, &bytes)
}

fn persist_asset_bytes(near_path: &str, ext: &str, bytes: &[u8]) -> Result<String, String> {
    let ext_clean = sanitize_ext(ext)?;

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let sha8: String = digest.iter().take(4).map(|b| format!("{:02x}", b)).collect();

    let near = PathBuf::from(near_path);
    let doc_dir = near
        .parent()
        .ok_or_else(|| format!("near_path has no parent: {}", near_path))?;
    let assets_dir = doc_dir.join("assets");
    if !assets_dir.exists() {
        std::fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    }

    let filename = format!("{}.{}", sha8, ext_clean);
    let target = assets_dir.join(&filename);
    if !target.exists() {
        std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    }

    // Always forward slashes — this string is inserted into markdown.
    Ok(format!("assets/{}", filename))
}

fn sanitize_ext(ext: &str) -> Result<String, String> {
    let trimmed = ext.trim().trim_start_matches('.').to_lowercase();
    if trimmed.is_empty() || trimmed.len() > 6 {
        return Err(format!("invalid ext (length): {}", ext));
    }
    if !trimmed.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
        return Err(format!("invalid ext (chars): {}", ext));
    }
    Ok(trimmed)
}

// ---------- T1.5: update_frontmatter ----------

#[tauri::command]
pub async fn update_frontmatter(
    path: String,
    patch: JsonValue,
    client: tauri::State<'_, crate::orgd_client::OrgdClient>,
) -> Result<(), String> {
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read failed: {}", e))?;

    // Locate frontmatter block: leading "---\n" ... "\n---\n" (or "\n---" at EOF).
    if !(raw.starts_with("---\n") || raw.starts_with("---\r\n")) {
        return Err("file has no leading frontmatter block".into());
    }
    let after_open = raw.find('\n').map(|i| i + 1).unwrap_or(0);
    let body_search = &raw[after_open..];
    // Find a line that is exactly "---" (terminating).
    let close_rel = find_closing_fence(body_search)
        .ok_or_else(|| "frontmatter has no closing --- fence".to_string())?;
    let close_abs_start = after_open + close_rel.start;
    let close_abs_end = after_open + close_rel.end;
    let yaml_str = &raw[after_open..close_abs_start];

    // Parse YAML preserving order.
    let mut yaml: YamlValue = if yaml_str.trim().is_empty() {
        YamlValue::Mapping(serde_yaml::Mapping::new())
    } else {
        serde_yaml::from_str(yaml_str).map_err(|e| format!("yaml parse failed: {}", e))?
    };
    let map = match &mut yaml {
        YamlValue::Mapping(m) => m,
        _ => return Err("frontmatter is not a mapping".into()),
    };

    let patch_map = patch
        .as_object()
        .ok_or_else(|| "patch must be a JSON object".to_string())?;

    // Cycle detection (T1.6) — only if relevant fields are touched.
    let touches_parent = patch_map.contains_key("parent");
    let touches_blocked_by = patch_map.contains_key("blocked-by");
    if touches_parent || touches_blocked_by {
        let docs: Vec<OrgDocument> = client.get("/v1/documents").await
            .map_err(|e| format!("orgd /v1/documents failed: {}", e))?;
        if touches_parent {
            if let Some(v) = patch_map.get("parent") {
                let targets = json_to_string_vec(v);
                if let Some(cycle) = would_create_cycle(&docs, &path, "parent", &targets) {
                    return Err(format!("would create parent cycle: {}", cycle));
                }
            }
        }
        if touches_blocked_by {
            if let Some(v) = patch_map.get("blocked-by") {
                let targets = json_to_string_vec(v);
                if let Some(cycle) = would_create_cycle(&docs, &path, "blocked-by", &targets) {
                    return Err(format!("would create blocked-by cycle: {}", cycle));
                }
            }
        }
    }

    // Apply patch entries.
    for (k, v) in patch_map {
        let key = YamlValue::String(k.clone());
        let yaml_v = json_to_yaml(v, k);
        map.insert(key, yaml_v);
    }

    // Re-serialize. serde_yaml emits a trailing newline.
    let new_yaml = serde_yaml::to_string(&yaml).map_err(|e| format!("yaml emit failed: {}", e))?;
    let new_yaml = new_yaml.trim_end_matches('\n');

    // Reconstruct the file: keep original opening "---\n", new yaml + "\n",
    // then original closing fence and body.
    let mut out = String::with_capacity(raw.len() + new_yaml.len());
    out.push_str(&raw[..after_open]); // "---\n" or "---\r\n"
    out.push_str(new_yaml);
    out.push('\n');
    out.push_str(&raw[close_abs_start..close_abs_end]); // "---" line
    out.push_str(&raw[close_abs_end..]); // remainder (newline + body)

    std::fs::write(&path, out.as_bytes()).map_err(|e| format!("write failed: {}", e))?;
    Ok(())
}

struct Fence { start: usize, end: usize }

/// Find the first line that is exactly `---` (optionally with trailing CR).
/// Returns byte range covering the fence chars (not the trailing newline).
fn find_closing_fence(s: &str) -> Option<Fence> {
    let mut idx = 0usize;
    for line in s.split_inclusive('\n') {
        let line_stripped = line.trim_end_matches('\n').trim_end_matches('\r');
        if line_stripped == "---" {
            let start = idx;
            let end = idx + line_stripped.len();
            return Some(Fence { start, end });
        }
        idx += line.len();
    }
    None
}

fn json_to_string_vec(v: &JsonValue) -> Vec<String> {
    match v {
        JsonValue::Array(arr) => arr
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect(),
        JsonValue::String(s) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// Convert JSON patch value to YAML, with field-aware formatting.
fn json_to_yaml(v: &JsonValue, key: &str) -> YamlValue {
    match v {
        JsonValue::Null => YamlValue::Null,
        JsonValue::Bool(b) => YamlValue::Bool(*b),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() { YamlValue::Number(i.into()) }
            else if let Some(f) = n.as_f64() { YamlValue::Number(f.into()) }
            else { YamlValue::String(n.to_string()) }
        }
        JsonValue::String(s) => YamlValue::String(s.clone()),
        JsonValue::Array(arr) => {
            let _path_like = matches!(key, "blocked-by" | "relates-to" | "references");
            // serde_yaml block-style serialization is fine; its emitter chooses
            // flow style for empty/short sequences. We can't directly request
            // flow mode on a per-node basis without a custom emitter, but for
            // patch updates the YAML round-trip is what matters; cosmetic flow
            // style is best-effort.
            YamlValue::Sequence(
                arr.iter().map(|x| json_to_yaml(x, key)).collect(),
            )
        }
        JsonValue::Object(o) => {
            let mut m = serde_yaml::Mapping::new();
            for (k, val) in o {
                m.insert(YamlValue::String(k.clone()), json_to_yaml(val, k));
            }
            YamlValue::Mapping(m)
        }
    }
}

// ---------- T1.6: cycle detection ----------

/// Returns Some(human-readable cycle path) if applying `new_targets` to
/// `path`'s `field` would create a cycle.
pub fn would_create_cycle(
    scan: &[OrgDocument],
    path: &str,
    field: &str,
    new_targets: &[String],
) -> Option<String> {
    let target_norm = norm(path);

    // Build path index for resolving frontmatter strings to canonical paths.
    let mut by_norm: std::collections::HashMap<String, &OrgDocument> = std::collections::HashMap::new();
    let mut by_basename: std::collections::HashMap<String, &OrgDocument> = std::collections::HashMap::new();
    let mut by_slug: std::collections::HashMap<String, &OrgDocument> = std::collections::HashMap::new();
    for d in scan {
        by_norm.insert(norm(&d.path), d);
        by_basename.insert(d.filename.clone(), d);
        by_slug.insert(d.filename.trim_end_matches(".md").to_string(), d);
    }
    let resolve = |reference: &str| -> Option<&OrgDocument> {
        let r = reference.trim().trim_start_matches("./");
        if r.is_empty() { return None; }
        if let Some(d) = by_norm.get(&norm(r)) { return Some(*d); }
        let basename = Path::new(r).file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| r.to_string());
        let basename_md = if basename.ends_with(".md") { basename.clone() } else { format!("{}.md", basename) };
        if let Some(d) = by_basename.get(&basename_md) { return Some(*d); }
        let slug = basename.trim_end_matches(".md").to_string();
        if let Some(d) = by_slug.get(&slug) { return Some(*d); }
        None
    };

    match field {
        "parent" => {
            // For parent, new_targets has 0 or 1 entry. Walk parents from each.
            for t in new_targets {
                let mut cur = resolve(t);
                let mut chain = vec![target_norm.clone()];
                let mut seen = HashSet::new();
                while let Some(d) = cur {
                    let n = norm(&d.path);
                    if n == target_norm {
                        chain.push(n);
                        return Some(chain.join(" -> "));
                    }
                    if !seen.insert(n.clone()) { break; } // independent existing cycle
                    chain.push(n);
                    cur = d.parent.as_deref().and_then(|p| resolve(p));
                }
            }
            None
        }
        "blocked-by" => {
            // BFS from each new_target through blocked_by edges.
            for t in new_targets {
                let start = match resolve(t) { Some(d) => d, None => continue };
                let mut frontier: Vec<&OrgDocument> = vec![start];
                let mut seen: HashSet<String> = HashSet::new();
                seen.insert(norm(&start.path));
                while let Some(d) = frontier.pop() {
                    if norm(&d.path) == target_norm {
                        return Some(format!("{} -> ... -> {}", target_norm, t));
                    }
                    for next_ref in &d.blocked_by {
                        if let Some(nd) = resolve(next_ref) {
                            let nn = norm(&nd.path);
                            if nn == target_norm {
                                return Some(format!("{} -> {} -> {}", target_norm, t, nn));
                            }
                            if seen.insert(nn) { frontier.push(nd); }
                        }
                    }
                }
            }
            None
        }
        _ => None,
    }
}

fn norm(p: &str) -> String {
    let s = p.replace('\\', "/");
    let chars: Vec<char> = s.chars().collect();
    if chars.len() >= 2 && chars[1] == ':' && chars[0].is_ascii_alphabetic() {
        let mut out = String::with_capacity(s.len());
        out.push(chars[0].to_ascii_lowercase());
        for &c in &chars[1..] { out.push(c); }
        return out;
    }
    s
}
