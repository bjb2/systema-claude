// Beads-style task-relation graph computed from the in-memory doc index.
// All edges are derived from frontmatter; reverse edges are never written to disk.
// Model: knowledge/tools/beads-issue-tracker-model.md in the org repo.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use serde::Serialize;

use crate::documents::OrgDocument;

/// Compact summary of a doc, returned in relation payloads.
#[derive(Serialize, Clone, Debug)]
pub struct DocSummary {
    pub path: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(rename = "type")]
    pub doc_type: String,
}

impl From<&OrgDocument> for DocSummary {
    fn from(d: &OrgDocument) -> Self {
        DocSummary {
            path: d.path.clone(),
            title: d.title.clone(),
            status: d.status.clone(),
            kind: d.kind.clone(),
            priority: d.priority.clone(),
            doc_type: d.doc_type.clone(),
        }
    }
}

/// Full relations payload for one document.
#[derive(Serialize, Debug)]
pub struct Relations {
    pub parent: Option<DocSummary>,
    pub children: Vec<DocSummary>,
    #[serde(rename = "blockedBy")]
    pub blocked_by: Vec<DocSummary>,
    pub blocks: Vec<DocSummary>,
    #[serde(rename = "relatesTo")]
    pub relates_to: Vec<DocSummary>,
    pub references: Vec<DocSummary>,
    #[serde(rename = "referencedBy")]
    pub referenced_by: Vec<DocSummary>,
    #[serde(rename = "mentionedBy")]
    pub mentioned_by: Vec<DocSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<DocSummary>,
    #[serde(rename = "supersededBy", skip_serializing_if = "Vec::is_empty")]
    pub superseded_by: Vec<DocSummary>,
    #[serde(rename = "duplicateOf", skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<DocSummary>,
    #[serde(rename = "duplicates", skip_serializing_if = "Vec::is_empty")]
    pub duplicates: Vec<DocSummary>,
    /// Computed: every blocked_by target has status == "complete".
    pub ready: bool,
}

/// Index over a scanned doc set with multiple lookup keys: full path, basename
/// (with .md), slug (basename without .md). All path-shaped frontmatter values
/// resolve through this.
pub struct DocIndex<'a> {
    docs: &'a [OrgDocument],
    by_path: HashMap<String, usize>,
    by_basename: HashMap<String, usize>,
    by_slug: HashMap<String, usize>,
}

impl<'a> DocIndex<'a> {
    pub fn new(docs: &'a [OrgDocument]) -> Self {
        let mut by_path = HashMap::new();
        let mut by_basename = HashMap::new();
        let mut by_slug = HashMap::new();
        for (i, d) in docs.iter().enumerate() {
            by_path.insert(normalize_path(&d.path), i);
            by_basename.insert(d.filename.clone(), i);
            let slug = d.filename.trim_end_matches(".md").to_string();
            by_slug.insert(slug, i);
        }
        DocIndex { docs, by_path, by_basename, by_slug }
    }

    /// Resolve a frontmatter reference (path / basename / slug, possibly with
    /// org-relative prefix) to an OrgDocument. Returns None if unresolved.
    pub fn resolve(&self, reference: &str, org_root: &Path, from_dir: Option<&Path>) -> Option<&OrgDocument> {
        let trimmed = reference.trim().trim_start_matches("./");
        if trimmed.is_empty() { return None; }

        // 1. Exact path match (normalized).
        let normalized = normalize_path(trimmed);
        if let Some(&i) = self.by_path.get(&normalized) { return Some(&self.docs[i]); }

        // 2. Try resolving as org-root-relative.
        let abs_from_root = org_root.join(trimmed);
        if let Some(&i) = self.by_path.get(&normalize_path(&abs_from_root.to_string_lossy())) {
            return Some(&self.docs[i]);
        }

        // 3. Try resolving as doc-dir-relative (only if we have a from_dir).
        if let Some(dir) = from_dir {
            let abs = dir.join(trimmed);
            if let Some(&i) = self.by_path.get(&normalize_path(&abs.to_string_lossy())) {
                return Some(&self.docs[i]);
            }
        }

        // 4. Basename match (with .md).
        let basename = Path::new(trimmed).file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| trimmed.to_string());
        let basename_md = if basename.ends_with(".md") { basename.clone() } else { format!("{}.md", basename) };
        if let Some(&i) = self.by_basename.get(&basename_md) { return Some(&self.docs[i]); }

        // 5. Slug match (basename without .md).
        let slug = basename.trim_end_matches(".md").to_string();
        if let Some(&i) = self.by_slug.get(&slug) { return Some(&self.docs[i]); }

        None
    }

    pub fn get(&self, normalized_path: &str) -> Option<&OrgDocument> {
        self.by_path.get(normalized_path).map(|&i| &self.docs[i])
    }
}

/// Normalize a path for comparison: lowercase drive letter on Windows,
/// forward-slash separators, no trailing slash.
fn normalize_path(p: &str) -> String {
    let s = p.replace('\\', "/");
    // Lowercase the drive letter if it looks like "C:/..."
    let chars: Vec<char> = s.chars().collect();
    if chars.len() >= 2 && chars[1] == ':' && chars[0].is_ascii_alphabetic() {
        let mut out = String::with_capacity(s.len());
        out.push(chars[0].to_ascii_lowercase());
        for &c in &chars[1..] { out.push(c); }
        return out;
    }
    s
}

/// Build a Relations payload for one document by resolving all of its
/// frontmatter edges plus computing reverse edges over the full index.
pub fn relations_for(target_path: &str, docs: &[OrgDocument], org_root: &Path) -> Option<Relations> {
    let idx = DocIndex::new(docs);
    let target_norm = normalize_path(target_path);
    let target = idx.get(&target_norm)?;
    let target_dir = PathBuf::from(target_path).parent().map(|p| p.to_path_buf());
    let target_dir_ref = target_dir.as_deref();

    // Forward edges, resolved.
    let parent = target.parent.as_deref()
        .and_then(|p| idx.resolve(p, org_root, target_dir_ref))
        .map(DocSummary::from);

    let blocked_by: Vec<DocSummary> = target.blocked_by.iter()
        .filter_map(|p| idx.resolve(p, org_root, target_dir_ref))
        .map(DocSummary::from)
        .collect();

    let relates_to: Vec<DocSummary> = target.relates_to.iter()
        .filter_map(|p| idx.resolve(p, org_root, target_dir_ref))
        .map(DocSummary::from)
        .collect();

    let references: Vec<DocSummary> = target.references.iter()
        .filter_map(|p| idx.resolve(p, org_root, target_dir_ref))
        .map(DocSummary::from)
        .collect();

    let supersedes = target.supersedes.as_deref()
        .and_then(|p| idx.resolve(p, org_root, target_dir_ref))
        .map(DocSummary::from);

    let duplicate_of = target.duplicate_of.as_deref()
        .and_then(|p| idx.resolve(p, org_root, target_dir_ref))
        .map(DocSummary::from);

    // Reverse edges: scan every doc for edges pointing back at target.
    let mut children = Vec::new();
    let mut blocks = Vec::new();
    let mut referenced_by = Vec::new();
    let mut mentioned_by = Vec::new();
    let mut superseded_by = Vec::new();
    let mut duplicates = Vec::new();

    let target_basename = target.filename.clone();

    // Disambiguation: if multiple docs share this basename (e.g. many
    // README.md across projects), bare wikilinks like `[[README]]` are
    // ambiguous and must not be attributed to a specific target.
    let basename_is_unique = docs.iter()
        .filter(|d| d.filename == target_basename)
        .count() <= 1;

    for d in docs {
        if d.path == target.path { continue; }
        let from_dir = PathBuf::from(&d.path).parent().map(|p| p.to_path_buf());
        let from_dir_ref = from_dir.as_deref();

        if let Some(p) = d.parent.as_deref() {
            if idx.resolve(p, org_root, from_dir_ref).map(|x| &x.path) == Some(&target.path) {
                children.push(DocSummary::from(d));
            }
        }
        for p in &d.blocked_by {
            if idx.resolve(p, org_root, from_dir_ref).map(|x| &x.path) == Some(&target.path) {
                blocks.push(DocSummary::from(d));
                break;
            }
        }
        for p in &d.references {
            if idx.resolve(p, org_root, from_dir_ref).map(|x| &x.path) == Some(&target.path) {
                referenced_by.push(DocSummary::from(d));
                break;
            }
        }
        // Wikilink mentions: resolve via the index, only count when the
        // resolved path matches this target. Bare slugs (no '/') are skipped
        // when the basename is shared across multiple docs — otherwise every
        // `[[README]]` in the org collapses onto a single arbitrary README.
        for link in &d.links {
            let l = link.trim();
            let is_path_shaped = l.contains('/') || l.contains('\\');
            if !is_path_shaped && !basename_is_unique { continue; }
            if let Some(r) = idx.resolve(l, org_root, from_dir_ref) {
                if r.path == target.path {
                    mentioned_by.push(DocSummary::from(d));
                    break;
                }
            }
        }
        if let Some(p) = d.supersedes.as_deref() {
            if idx.resolve(p, org_root, from_dir_ref).map(|x| &x.path) == Some(&target.path) {
                superseded_by.push(DocSummary::from(d));
            }
        }
        if let Some(p) = d.duplicate_of.as_deref() {
            if idx.resolve(p, org_root, from_dir_ref).map(|x| &x.path) == Some(&target.path) {
                duplicates.push(DocSummary::from(d));
            }
        }
    }

    // Ready = no open blockers (every blocked_by target has status == "complete").
    let ready = target.blocked_by.iter()
        .filter_map(|p| idx.resolve(p, org_root, target_dir_ref))
        .all(|d| d.status.as_deref() == Some("complete"));

    Some(Relations {
        parent,
        children,
        blocked_by,
        blocks,
        relates_to,
        references,
        referenced_by,
        mentioned_by,
        supersedes,
        superseded_by,
        duplicate_of,
        duplicates,
        ready,
    })
}

