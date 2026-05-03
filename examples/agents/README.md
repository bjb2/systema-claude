# Example agent configs

These are example fragments that show the shape of an agent entry in `org.config.json`. systema-claude ships **two** validated examples:

- `claude.json` — default. Requires the `claude` CLI (Claude Code) on your `PATH`.
- `codex.json` — alternative. Requires the `codex` CLI on your `PATH`.

To activate one, copy the JSON object into the `agents` block of your workspace's `org.config.json`. Set `defaultAgent` at the top level to its key.

## Bring your own

`org.config.json` accepts arbitrary `launchCmd` and `printArgs`. Other agents (Gemini, aider, opencode, cursor-agent, ollama-via-shell) work fine — we just don't ship configs we haven't personally validated. Two known-good examples beats six guesses.

If you write a config for another agent and it works for you, the existing BYO mechanism is the right place; no change to systema-claude is needed. If you find it useful enough to share, open a PR adding it here with a note describing what you tested.
