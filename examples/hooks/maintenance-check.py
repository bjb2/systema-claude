#!/usr/bin/env python3
"""Maintenance check hook for systema-claude workspaces.

Runs as Claude Code's Stop hook (~/.claude/settings.json → hooks.Stop).
Blocks the session-end and prompts the agent to evaluate the session for
captures (new knowledge, project status changes, ideas worth preserving,
decisions, bugs to investigate, etc.) before stopping.

The "harness as central feature" anchor in docs/charter.md applies here:
the hook is structural enforcement, not a request that maintenance happen.
Without it, capture relies on remembering — which means it doesn't.

Install via: python scripts/install-hooks.py
"""

import json
import sys
import os
import re
from datetime import datetime, timezone

TRIVIAL_SESSION_THRESHOLD = 15  # transcript lines below this — skip the prompt


def _decode_project_path(encoded: str) -> str | None:
    """Reverse Claude Code's project path encoding back to a filesystem path.

    Windows: ``C--Users-alice-my-workspace``  ->  ``C:\\Users\\alice\\my-workspace``
    Unix:    ``Users-alice-my-workspace``     ->  ``/Users/alice/my-workspace``
    """
    win = re.match(r'^([A-Za-z])--(.+)$', encoded)
    if win:
        drive, rest = win.groups()
        return drive + ':\\' + rest.replace('-', '\\')
    return '/' + encoded.replace('-', '/')


def find_workspace(data: dict) -> str | None:
    """Detect the workspace root directory.

    Priority:
      1. ORG_DIR / SYSTEMA_CLAUDE_DIR env var (explicit override).
      2. Decoded from Claude's transcript path.
      3. Current working directory (if it has a CLAUDE.md).
      4. Walk up from CWD looking for CLAUDE.md.
    """
    env_dir = (
        os.environ.get("SYSTEMA_CLAUDE_DIR")
        or os.environ.get("ORG_DIR")
        or os.environ.get("CLAUDE_ORG_DIR")
    )
    if env_dir:
        expanded = os.path.expandvars(os.path.expanduser(env_dir))
        if os.path.isdir(expanded):
            return expanded

    transcript = data.get("transcript_path", "")
    if transcript:
        m = re.search(r'[/\\]projects[/\\]([^/\\]+)[/\\]', transcript)
        if m:
            candidate = _decode_project_path(m.group(1))
            if candidate and os.path.isfile(os.path.join(candidate, "CLAUDE.md")):
                return candidate

    cwd = os.getcwd()
    if os.path.isfile(os.path.join(cwd, "CLAUDE.md")):
        return cwd

    path = cwd
    for _ in range(6):
        parent = os.path.dirname(path)
        if parent == path:
            break
        path = parent
        if os.path.isfile(os.path.join(path, "CLAUDE.md")):
            return path

    return None


def allow_stop():
    print(json.dumps({"continue": True}))
    sys.exit(0)


def get_recent_changes(workspace: str, minutes: int = 120) -> list[str]:
    """Return workspace markdown files modified in the last N minutes."""
    changed: list[str] = []
    cutoff = datetime.now(timezone.utc).timestamp() - (minutes * 60)
    for root, dirs, files in os.walk(workspace):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('node_modules', 'target', 'dist', '__pycache__')]
        for fname in files:
            if not fname.endswith('.md'):
                continue
            path = os.path.join(root, fname)
            try:
                if os.path.getmtime(path) > cutoff:
                    rel = os.path.relpath(path, workspace).replace('\\', '/')
                    changed.append(rel)
            except OSError:
                pass
    return sorted(changed)


def get_workspace_stats(workspace: str) -> dict:
    """Quick scan of workspace state by frontmatter type."""
    stats = {"active_tasks": 0, "inbox": 0, "knowledge": 0}
    for root, dirs, files in os.walk(workspace):
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('node_modules', 'target', 'dist')]
        for fname in files:
            if not fname.endswith('.md'):
                continue
            path = os.path.join(root, fname)
            try:
                with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read(500)
                if 'type: task' in content and 'status: active' in content:
                    stats["active_tasks"] += 1
                elif 'type: inbox' in content:
                    stats["inbox"] += 1
                elif 'type: knowledge' in content:
                    stats["knowledge"] += 1
            except OSError:
                pass
    return stats


def already_answered(content: str) -> bool:
    """Detect if the agent already replied 'No maintenance needed.' as a standalone line."""
    recent = content[-1000:] if len(content) > 1000 else content
    lines = recent.strip().splitlines()
    for line in reversed(lines):
        stripped = line.strip()
        if stripped == "No maintenance needed.":
            return True
        if stripped and len(stripped) > 5:
            break
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, Exception):
        allow_stop()

    if data.get("stop_hook_active"):
        allow_stop()

    transcript_path = data.get("transcript_path")
    if not transcript_path or not os.path.exists(transcript_path):
        allow_stop()

    try:
        with open(transcript_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except Exception:
        allow_stop()

    if content.count('\n') < TRIVIAL_SESSION_THRESHOLD:
        allow_stop()

    if already_answered(content):
        allow_stop()

    workspace = find_workspace(data)
    if not workspace:
        allow_stop()

    changed_files = get_recent_changes(workspace)
    stats = get_workspace_stats(workspace)

    context_lines = []
    if changed_files:
        listed = ', '.join(changed_files[:6])
        more = '...' if len(changed_files) > 6 else ''
        context_lines.append(f"  • Files modified this session: {listed}{more}")
    context_lines.append(
        f"  • Workspace state: {stats['active_tasks']} active tasks | "
        f"{stats['inbox']} inbox | {stats['knowledge']} knowledge articles"
    )

    context_block = "\n".join(context_lines)

    reason = (
        "Maintenance check before stopping. Evaluate the session for any "
        "captures worth preserving. If nothing applies, reply exactly "
        '"No maintenance needed." and stop.'
    )

    additional_context = f"""Signal -> Action:
- New reusable insight or pattern -> knowledge/<topic>.md (+ link from a related file so it isn't an orphan)
- Project status changed -> update context/current-state.md
- New task identified -> tasks/<name>.md
- Question worth preserving -> queries/<question>.md
- Feature idea / future project -> inbox/ideas/<item>.md
- Decision needed -> inbox/decisions/<item>.md
- Bug to investigate -> inbox/investigations/<item>.md
- Quick unsorted capture -> inbox/captures/<item>.md
- Repeated manual action you'd rather automate -> inbox/decisions/<automation-proposal>.md

Session context:
{context_block}

If any of these signals applies, do the capture now — short captures
beat lost ones. If none apply, reply exactly "No maintenance needed."
and stop.

Capture aggressively. Lost insights are unrecoverable."""

    print(json.dumps({
        "decision": "block",
        "reason": f"{reason}\n\n{additional_context}",
    }))
    sys.exit(0)


if __name__ == "__main__":
    main()
