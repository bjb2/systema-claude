# Hooks

Two Claude Code hooks ship here. Both are optional but **strongly recommended** — they're what makes the workspace self-maintaining instead of dependent on you remembering to capture and orient.

## What's here

- **`maintenance-check.py`** — runs as Claude Code's `Stop` hook. At session-end, it scans the workspace for files modified during the session, computes basic state (active task / inbox / knowledge counts), and prompts the agent to evaluate the session for captures (new knowledge, status changes, ideas, decisions, bugs, automation candidates). If the agent has nothing to capture, it replies `"No maintenance needed."` and the hook releases. Without this, capture relies on memory — which means it doesn't happen.
- **`session-start.py`** — runs as Claude Code's `SessionStart` hook. It reads frontmatter across `tasks/`, `inbox/`, `knowledge/`, `reminders/`, and `context/` and emits a concise orientation block so a fresh agent has the workspace state in context without having to read 50 files. Skips on session resume.

Both scripts have **zero Python dependencies** — only the standard library (regex YAML parser, no PyYAML).

## Install

From the workspace root:

```
python scripts/install-hooks.py
```

The installer copies both `.py` files into `~/.claude/hooks/`, then prints the snippet to add to your Claude Code `~/.claude/settings.json`. After updating `settings.json`, restart Claude Code.

To verify:
- `SessionStart` — start a fresh Claude Code session in the workspace; you should see a `<session-context>` block in the agent's first context.
- `Stop` — finish a non-trivial session; you should be prompted with the maintenance-check signal table before the session releases.

## Workspace detection

Both hooks find the workspace via this precedence:
1. `SYSTEMA_CLAUDE_DIR` (or legacy `ORG_DIR` / `CLAUDE_ORG_DIR`) env var.
2. The transcript-path encoding (Stop hook only) or the `cwd` field in the SessionStart payload.
3. The CWD if it contains a `CLAUDE.md`.
4. Walk up from CWD looking for a `CLAUDE.md` (Stop hook only).

If none of these resolve to a `CLAUDE.md`, the hook releases without doing anything.

## Why these are optional, sort of

You can run systema-claude without the hooks. The substrate works (files are still files, the daemon still indexes, the agent still reads and writes). But the *discipline* the project tries to teach — capture immediately, orient before acting — depends on structural enforcement, not on you remembering. Skipping the hooks is fine for one-off use; for daily operation, install them.
