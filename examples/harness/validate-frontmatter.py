#!/usr/bin/env python3
"""Frontmatter shape validator for systema-claude workspaces.

Walks the directory passed as the first argument (default: cwd) and checks every
.md file under tasks/, knowledge/, inbox/, projects/, context/, routines/ for
required frontmatter fields.

Exit code 0 if all files pass; 1 if any violation found. Output is machine-
parseable: one violation per line, "<path> | <message>".

This is the harness referenced in tasks/welcome.md Phase 5. It is also the
reference implementation any user-written validator should match for shape.

Dependencies: PyYAML.
  pip install pyyaml
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.stderr.write(
        "ERROR: PyYAML is required. Install with: pip install pyyaml\n"
    )
    sys.exit(2)


REQUIRED_FIELDS: dict[str, list[str]] = {
    "task":      ["type", "status", "created", "tags"],
    "knowledge": ["type", "created", "updated", "tags"],
    "inbox":     ["type", "created"],
    "project":   ["type", "status", "created", "tags"],
    "context":   ["type", "created", "updated", "tags"],
    "reminder":  ["type", "status", "created", "remind-at"],
    "reference": ["type", "created", "updated", "tags"],
    "report":    ["type", "created", "tags"],
    "routine":   ["type", "cron", "steps"],
}

DIR_DEFAULT_TYPE: dict[str, str] = {
    "tasks":     "task",
    "knowledge": "knowledge",
    "inbox":     "inbox",
    "projects":  "project",
    "context":   "context",
    "reminders": "reminder",
    "routines":  "routine",
}


def parse_frontmatter(path: Path) -> tuple[dict | None, str | None]:
    """Return (frontmatter_dict, error_string). Empty dict if no frontmatter."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return None, f"read error: {e}"

    if not text.startswith("---"):
        return {}, None

    end = text.find("\n---", 3)
    if end == -1:
        return {}, "no closing --- delimiter"

    try:
        fm = yaml.safe_load(text[3:end]) or {}
        if not isinstance(fm, dict):
            return {}, f"frontmatter is not a mapping (got {type(fm).__name__})"
        return fm, None
    except yaml.YAMLError as e:
        return {}, f"yaml parse error: {e}"


def check_directory(root: Path) -> list[tuple[Path, str]]:
    violations: list[tuple[Path, str]] = []

    for top_name, default_type in DIR_DEFAULT_TYPE.items():
        top = root / top_name
        if not top.is_dir():
            continue

        for path in top.rglob("*.md"):
            fm, err = parse_frontmatter(path)
            rel = path.relative_to(root)

            if err:
                violations.append((rel, err))
                continue

            if fm is None:
                continue

            ftype = fm.get("type", default_type)
            required = REQUIRED_FIELDS.get(ftype) or REQUIRED_FIELDS.get(default_type, [])
            missing = [f for f in required if f not in fm]
            if missing:
                violations.append((rel, f"missing fields: {', '.join(missing)}"))

    return violations


def main() -> int:
    root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
    if not root.is_dir():
        sys.stderr.write(f"ERROR: not a directory: {root}\n")
        return 2

    violations = check_directory(root)
    for rel, msg in sorted(violations):
        print(f"{rel} | {msg}")

    if violations:
        print(f"\nFAIL: {len(violations)} violation(s)", file=sys.stderr)
        return 1

    print("PASS: all frontmatter valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
