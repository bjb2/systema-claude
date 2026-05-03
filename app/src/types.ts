export interface OrgDocument {
  path: string;
  filename: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  type: string;
  status?: string;
  tags: string[];
  created?: string;
  updated?: string;
  links: string[]; // wikilinks extracted from content
  // Beads-style task graph fields (optional, additive). Backend renames
  // hyphenated YAML keys to camelCase. See documents.rs.
  kind?: string;
  parent?: string;
  priority?: string;
  due?: string;
  blockedBy?: string[];
  relatesTo?: string[];
  references?: string[];
  supersedes?: string;
  duplicateOf?: string;
}

export interface OrgIndex {
  documents: OrgDocument[];
  lastUpdated: number;
}

/** Compact summary of a doc, returned inside Relations payloads. */
export interface DocSummary {
  path: string;
  title: string;
  status?: string;
  kind?: string;
  priority?: string;
  type: string;
}

/** Full relation payload returned by the `get_relations` Tauri command. */
export interface Relations {
  parent: DocSummary | null;
  children: DocSummary[];
  blockedBy: DocSummary[];
  blocks: DocSummary[];
  relatesTo: DocSummary[];
  references: DocSummary[];
  referencedBy: DocSummary[];
  mentionedBy: DocSummary[];
  supersedes?: DocSummary;
  supersededBy?: DocSummary[];
  duplicateOf?: DocSummary;
  duplicates?: DocSummary[];
  /** Computed: every blockedBy target has status == "complete". */
  ready: boolean;
}
