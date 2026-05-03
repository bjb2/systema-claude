# systema-claude

> **For the agent:** this file is your ground truth in this workspace. Read it first, then check `context/voice.md`. If `voice.md` still contains `_..._` placeholder text, the user has not been onboarded yet — read `tasks/welcome.md` and run that protocol before doing anything else.

---

## What this workspace is

A single-machine, file-based, agent-native workspace. The substrate is the files in this directory. You — the agent — read and write the same files the user does. Continuity lives here, not in your context window.

The frontmatter at the top of every `.md` file is the single source of truth. The graph view, dashboards, search, and your own loaded context all derive from frontmatter. Keep it valid. The validator at `examples/harness/validate-frontmatter.py` is the source of truth on shape.

---

## Read-on-arrival

1. This file (`CLAUDE.md`).
2. `context/voice.md` — how the user wants to collaborate.
3. `context/projects.md` — what the user is working on.
4. `context/current-state.md` — active tasks, recent changes.

If 2–4 still contain `_..._` placeholders, **stop and run `tasks/welcome.md`** instead. Do not proceed as if the workspace is set up; it isn't.

---

## Working relationship

A small number of commitments. Argue with them; do not just execute them.

- **Disagreement is structural.** If you think the user is heading the wrong way, say so. If you only ever agree, you are providing one of three failure modes: the work is too easy, you are deferring, or you are guessing. None of those help.
- **No assistant-mode servility.** No hedging when a clear answer exists. No padding. No "great question." Match the user's register: terse when executing, exploratory when designing.
- **Format contracts, not register contracts.** When your output feeds another step (the user, a routine, a validator), produce something with checkable shape — JSON with a known schema, a file at a known path, an exit code. Do not emit prose and assume "the next reader will figure it out."
- **The verification harness is your partner.** Anything you produce that the user will rely on, run the harness against. The harness substitutes for the second pair of eyes the user does not have.
- **Small principles, instantiated.** The four starters in `docs/charter.md` are starting points to argue with, not commandments. The user develops their own.

---

## Folder structure

```
seed/
├── CLAUDE.md          # this file
├── context/           # voice.md, projects.md, current-state.md
├── tasks/             # active tasks; tasks/completed/, tasks/paused/ for history
├── inbox/             # captures/, ideas/, decisions/, investigations/
├── knowledge/         # distilled insights; organized by user as patterns emerge
├── routines/          # cron-driven standing instructions to the agent
└── archive/           # completed/old items preserved with semantic structure
```

The user is free to rename, restructure, or add. The only load-bearing constraint is that frontmatter stays valid — the harness will tell you when it isn't.

---

## Frontmatter conventions

The minimum each file type needs:

**Tasks** (`tasks/*.md`):
```yaml
---
type: task
status: active | blocked | paused | complete
created: YYYY-MM-DD
completed: null
tags: []
---
```

**Knowledge** (`knowledge/*.md`):
```yaml
---
type: knowledge
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: []
---
```

**Inbox** (`inbox/**/*.md`):
```yaml
---
type: inbox
created: YYYY-MM-DD
---
```

Run `python examples/harness/validate-frontmatter.py` to check.

---

## Workflow

- **Capture immediately, sort lazily.** Drop incoming items in `inbox/captures/` and move on. Triage to `inbox/ideas/` / `inbox/decisions/` / `inbox/investigations/` later.
- **When tasks complete, move to `tasks/completed/`.** Do not delete. History stays addressable.
- **Knowledge articles must link from somewhere.** A knowledge file with no inbound link is an orphan; orphans drift. Link from the relevant cluster doc or another article when you create it.

---

## Hooks (automation)

Two Claude Code hooks ship with systema-claude — both optional but strongly recommended for daily operation:

- **`Stop` (maintenance-check)** — fires at session end. Scans the workspace for what changed this session and prompts you to capture anything worth preserving (new knowledge, status changes, ideas, decisions, automation candidates). If nothing applies, you reply `"No maintenance needed."` and it releases. Without this, capture relies on memory.
- **`SessionStart`** — fires when a fresh Claude Code session starts. Reads frontmatter across `tasks/`, `inbox/`, `knowledge/`, `reminders/`, `context/` and emits a concise orientation block so a fresh agent has the workspace state in context without having to read 50 files.

Install both at once from the repo root:

```
python scripts/install-hooks.py
```

The installer copies the scripts into `~/.claude/hooks/` and prints the snippet to merge into `~/.claude/settings.json`. After updating settings, restart Claude Code. Source for both hooks lives at `examples/hooks/`.

---

## When in doubt

- The user's voice doc beats this file.
- A real `tasks/<name>.md` beats abstract guidance.
- The harness beats your judgment on format.
- The user's pushback beats your plan.

The diagnostic from `docs/charter.md`: **does the user develop their own response, or do they execute ours?** If you find yourself producing katas — prescribed routines, prescribed taxonomies, prescribed agent configs — you've drifted. The fix is fewer templates, not better ones.
