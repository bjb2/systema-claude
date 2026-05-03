#!/usr/bin/env python3
"""Install systema-claude's Claude Code hooks.

Copies maintenance-check.py and session-start.py from examples/hooks/ to
~/.claude/hooks/, then prints the snippet to add to ~/.claude/settings.json.

Why we don't auto-edit settings.json: it usually has user-specific blocks
(model overrides, permissions, env vars) that we'd risk clobbering. The
two-step "copy + print snippet" pattern lets the user merge the hooks
block into their existing settings safely.

Usage:
    python scripts/install-hooks.py
"""

import json
import os
import shutil
import sys
from pathlib import Path


def claude_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("USERPROFILE", "")) / ".claude"
    return Path.home() / ".claude"


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    hooks_src = repo_root / "examples" / "hooks"

    if not hooks_src.is_dir():
        print(f"ERROR: examples/hooks/ not found at {hooks_src}", file=sys.stderr)
        print("Run this script from the systema-claude repo root.", file=sys.stderr)
        return 1

    target_root = claude_dir()
    hooks_dest = target_root / "hooks"
    hooks_dest.mkdir(parents=True, exist_ok=True)

    print("systema-claude hook installation")
    print("=" * 40)
    print()
    print(f"Source:      {hooks_src}")
    print(f"Destination: {hooks_dest}")
    print()

    copied: list[str] = []
    for hook in sorted(hooks_src.glob("*.py")):
        dest = hooks_dest / hook.name
        shutil.copy2(hook, dest)
        copied.append(hook.name)
        print(f"  copied: {hook.name}")

    if not copied:
        print("Nothing to copy. Are examples/hooks/*.py present?", file=sys.stderr)
        return 1

    print()
    print("Hooks copied. Next: merge the block below into your")
    print(f"Claude Code settings.json (typically: {target_root / 'settings.json'}).")
    print()

    if sys.platform == "win32":
        stop_path = str(hooks_dest / "maintenance-check.py").replace("\\", "/")
        start_path = str(hooks_dest / "session-start.py").replace("\\", "/")
    else:
        stop_path = str(hooks_dest / "maintenance-check.py")
        start_path = str(hooks_dest / "session-start.py")

    snippet = {
        "hooks": {
            "Stop": {
                "command": f'python "{stop_path}"',
                "timeout": 5000,
            },
            "SessionStart": {
                "command": f'python "{start_path}"',
                "timeout": 5000,
            },
        }
    }

    print(json.dumps(snippet, indent=2))
    print()
    print("After updating settings.json, restart Claude Code so the hooks load.")
    print()
    print("Verify:")
    print("  - SessionStart: open a fresh session in the workspace; you should see")
    print("    a <session-context> block in the first message.")
    print("  - Stop: finish a non-trivial session; you should be prompted with the")
    print("    maintenance-check signal table before the session releases.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
