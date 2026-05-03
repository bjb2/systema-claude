# systema-claude

A portable, file-based, agent-native workspace. Single binary, single window, your files, your agent.

## What systema-claude is *not*

Read this first. The space of "tools that put an LLM next to some files" is crowded, and most of those tools are not this.

- **Not a chat interface.** There is no thread. The substrate is files; the agent reads and writes them. Conversation is incidental.
- **Not a coding IDE.** Code editing is included because some files are code; that is not the point. The point is the workspace.
- **Not a note-taking app with AI bolted on.** The agent is a tenant, not a feature button. Architecture assumes the agent will operate on the workspace whether you are watching or not.
- **Not a workflow platform.** Routines exist, but they are standing instructions to a tenant — not orchestrated nodes in a DAG product.
- **Not a memory feature.** Continuity lives in the files, not in a vendor's recall system. If your tools disappeared tomorrow, the workspace would still read linearly.
- **Not a federation client.** Single machine. Architectural hooks are present so a future you can build outward; v1 does not.
- **Not a graduation path to something more articulated.** This is its own school. See `docs/charter.md`.

If any of those negations made you think "but I want exactly that thing," you want a different tool. Pick one of those; they are good.

## What it is

A Tauri desktop binary that runs a local Rust daemon (`orgd`) over `127.0.0.1` and presents a TUI-style document browser. The agent of your choice (Claude by default; Codex example included) operates on the workspace through the same file substrate you operate on. Routines run on a cron loop. The frontmatter on every file is the single source of truth — graph, dashboards, search, and agent context all derive from it.

The verification harness is the central feature: every contract the workspace ships (frontmatter schema, routine-step output shape, agent invocation envelope) has a tiny test runner next to it. Not crypto-grade — just enough to make a divergence visible to one user before it travels.

## Status

**Pre-v0.1.0 — scaffold only.** The repo is being spun off from a parent workspace. Source code (orgd daemon, Tauri shell, seed org, verification harness) is being forked in over the next several phases. See `docs/roadmap.md` (TODO).

Until v0.1.0:
- The `orgd/` and `app/` directories are empty placeholders.
- The seed org under `seed/` is empty.
- No installer is published.

## Install + first run (planned shape, not yet shipped)

Download the binary for your platform from Releases. Run it. There is no `cargo install`, no `npm install`, no dev server to keep running.

The first launch opens the bundled seed workspace. **Your first task is `tasks/welcome.md`** — open it. The agent of your choice (Claude by default) will read it and run a short interview to extract your voice, your projects, and the principles you actually live by, populating `context/voice.md` / `context/projects.md` / `context/current-state.md` as the artifact. Allow ~45 minutes; you can pause anywhere.

The welcome task is itself a worked example of how systema-claude expects you to operate: a file in the workspace, read by the agent, edited collaboratively, validated by a harness, then archived when complete. You will have used every primitive the workspace ships with before you finish onboarding.

If you want to hack on systema-claude itself rather than use it as a workspace, see `docs/hacking.md` (TODO).

## Agents

Two example configs ship in `examples/agents/`:

- `claude.json` — default. Uses the `claude` CLI.
- `codex.json` — alternative. Uses the `codex` CLI.

Bring your own: `org.config.json` accepts arbitrary `launchCmd` / `printArgs`. Other agents (Gemini, aider, opencode, cursor-agent) are not pre-configured — the BYO mechanism is general; we just have not validated configs we do not personally use.

## Philosophy

The naming is load-bearing. systema-claude takes its name from the martial art (Systema), whose discipline is *principles over prescriptions, effectiveness-checking over technique-collecting*. What that commits the project to:

- **No katas.** No prescribed routine templates, no prescribed knowledge taxonomies, no prescribed agent configurations.
- **Seed-as-blank-room, not seed-as-template.** Equipment present and labeled (frontmatter validator, harness runner, empty `routines/`, empty `knowledge/`). You develop your own practice on top.
- **The verification harness is the partner.** Tests substitute for the counterparty a single-user workspace lacks by definition.

Full charter at `docs/charter.md`.

## License

MIT. See `LICENSE`.

## Lineage

Forked from a private parent workspace (`my-org-new`) authored by Bryan Bartley with Claude Opus 4.7. The parent contains personal content (knowledge, projects, voice work) that does not migrate. systema-claude is the public, opinionated, no-personal-content slice — what the parent learned, restated for an audience of one (you).

The architecture has cousins: `vincitamore/amore-network` (Alex + Opus 4.7) is a peer pair's federation-aware project that traveled further on identity, transport, and governance. We learned from it; we did not adopt its alchemical naming or its 13-principle lattice. Two valid schools meeting at protocol surfaces.
