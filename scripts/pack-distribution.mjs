#!/usr/bin/env node
// Assemble the systema-claude release distribution from the Tauri build output.
//
// Inputs:
//   app/src-tauri/target/release/systema-claude-app.exe   (renamed -> systema-claude.exe)
//   app/src-tauri/target/release/orgd.exe                  (sidecar, kept as-is)
//   seed/                                                  (flattened to dist root)
//   scripts/install-hooks.py
//   examples/{agents,harness,hooks}/
//
// Outputs (under dist/):
//   systema-claude-v<version>/                             (the unpacked tree)
//   systema-claude-v<version>.zip                          (the release artifact)
//   systema-claude.exe                                     (loose binary, for users
//                                                           who already have a workspace
//                                                           and just want the exe update)
//
// Layout in the zip — note `seed/` flattens to root so the exe sits next to
// CLAUDE.md and find_org_root() resolves on the first hop. The "seed" concept
// is dev-time only; the distributed thing is just a workspace.
//
//   systema-claude-v0.1.x/
//   ├── systema-claude.exe
//   ├── orgd.exe
//   ├── CLAUDE.md
//   ├── QUICKSTART.md
//   ├── org.config.json
//   ├── context/
//   ├── tasks/
//   ├── inbox/captures/.gitkeep
//   ├── knowledge/.gitkeep
//   ├── routines/format-contract-example.md
//   ├── scripts/install-hooks.py
//   └── examples/{agents,harness,hooks}/

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const appRoot = join(repoRoot, "app");
const releaseDir = join(appRoot, "src-tauri", "target", "release");
const seedDir = join(repoRoot, "seed");
const distRoot = join(repoRoot, "dist");

// Read version from app/src-tauri/tauri.conf.json
const tauriConf = JSON.parse(
  readFileSync(join(appRoot, "src-tauri", "tauri.conf.json"), "utf8"),
);
const version = tauriConf.version;
if (!version) throw new Error("could not determine version from tauri.conf.json");

const distName = `systema-claude-v${version}`;
const stageDir = join(distRoot, distName);
const zipPath = join(distRoot, `${distName}.zip`);
const looseExePath = join(distRoot, "systema-claude.exe");

const builtExe = join(releaseDir, "systema-claude-app.exe");
const builtSidecar = join(releaseDir, "orgd.exe");

if (!existsSync(builtExe)) {
  console.error(`[pack] ERROR: ${builtExe} not found. Run \`npx tauri build\` first.`);
  process.exit(1);
}
if (!existsSync(builtSidecar)) {
  console.error(`[pack] ERROR: ${builtSidecar} not found. Sidecar wasn't staged by the Tauri build.`);
  process.exit(1);
}

console.log(`[pack] version: ${version}`);
console.log(`[pack] cleaning ${distRoot}...`);
if (existsSync(distRoot)) rmSync(distRoot, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// 1. The two binaries.
console.log("[pack] copying binaries...");
copyFileSync(builtExe, join(stageDir, "systema-claude.exe"));
copyFileSync(builtSidecar, join(stageDir, "orgd.exe"));

// 2. Seed contents flattened. Skip the .exe we may have staged there for local testing.
console.log("[pack] flattening seed/...");
cpSync(seedDir, stageDir, {
  recursive: true,
  filter: (src) => {
    const base = src.split(/[/\\]/).pop();
    if (base === "systema-claude.exe") return false; // local test artifact
    return true;
  },
});

// 3. scripts/install-hooks.py
console.log("[pack] copying scripts/install-hooks.py...");
mkdirSync(join(stageDir, "scripts"), { recursive: true });
copyFileSync(
  join(repoRoot, "scripts", "install-hooks.py"),
  join(stageDir, "scripts", "install-hooks.py"),
);

// 4. examples/ tree
console.log("[pack] copying examples/...");
cpSync(join(repoRoot, "examples"), join(stageDir, "examples"), { recursive: true });

// 5. QUICKSTART.md (auto-generated; short, distribution-specific)
console.log("[pack] writing QUICKSTART.md...");
writeFileSync(
  join(stageDir, "QUICKSTART.md"),
  quickstartContent(version),
);

// 6. The loose .exe artifact (for users who already have a workspace)
copyFileSync(builtExe, looseExePath);

// 7. Zip it. Use PowerShell's Compress-Archive on Windows, zip elsewhere.
console.log(`[pack] zipping -> ${zipPath}...`);
if (process.platform === "win32") {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${stageDir}' -DestinationPath '${zipPath}' -Force"`,
    { stdio: "inherit" },
  );
} else {
  execSync(`cd "${distRoot}" && zip -r "${distName}.zip" "${distName}"`, { stdio: "inherit" });
}

const zipBytes = statSync(zipPath).size;
const exeBytes = statSync(looseExePath).size;
console.log("");
console.log("[pack] done.");
console.log(`  ${zipPath}  (${(zipBytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  ${looseExePath}  (${(exeBytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  ${stageDir}/  (unpacked)`);

function quickstartContent(version) {
  return `# systema-claude — Quickstart

You just unpacked v${version} of systema-claude. The folder you extracted to **is your workspace** — these files are yours to edit, rename, and grow.

## Run it

Double-click \`systema-claude.exe\` (or run it from a terminal). The app opens against this folder.

> **First-launch heads-up:** the binary is unsigned, so Windows Defender will prompt you to allow it. If it appears to "disappear" after launch, check Windows Security → Protection History → allow, and add a folder exclusion for this directory.

## What you should see

A desktop window opens to a Dashboard view: 1 active task, 0 blocked, 0 knowledge entries, 0 inbox items. The left rail has Dashboard / Tasks / Knowledge / Inbox / Graph / Code / Swarm / Routines / Settings. The active task is **welcome.md** under \`tasks/\`.

## Open \`tasks/welcome.md\`

Press \`2\` (Tasks view), select **welcome**, hit \`e\` to edit, or just open the file in any editor — it's plain markdown.

The welcome task is your agent's onboarding script. It's meant to be opened *with* the agent of your choice attached (Claude or Codex). The agent reads the task, runs a short interview against you (~45 minutes, pause anywhere), and writes your voice, your projects, and the principles you live by into \`context/voice.md\` / \`context/projects.md\` / \`context/current-state.md\`.

## Agents

The bundled \`org.config.json\` configures two:

- **claude** (default) — requires the \`claude\` CLI from Anthropic to be on your PATH.
- **codex** — requires the \`codex\` CLI on your PATH.

If neither is installed, the app shows a warning banner at the top. Install whichever you'll use, then restart the app. Other CLI agents (Gemini, aider, opencode, ollama) work too — see \`examples/agents/README.md\` for the BYO mechanism.

## Maintenance hooks (optional but recommended)

systema-claude ships two Claude Code hooks (\`Stop\` + \`SessionStart\`) that close the loop on capture and orientation. To install them:

\`\`\`
python scripts/install-hooks.py
\`\`\`

The installer copies the scripts to \`~/.claude/hooks/\` and prints the snippet to merge into your Claude Code \`settings.json\`. Source for both hooks is in \`examples/hooks/\`.

## What else is here

- \`examples/harness/validate-frontmatter.py\` — a self-testing reference validator for the frontmatter schema this workspace uses. Run it any time: \`python examples/harness/validate-frontmatter.py .\`
- \`routines/format-contract-example.md\` — a worked teaching artifact for the routines runner; ships disabled, exists to be read.
- \`org.config.json\` — agent registry. Edit to add your own agents.

## Where to learn more

The full README and charter for the project live at https://github.com/bjb2/systema-claude.

You're operating the system the moment you open the app. There's no separate "setup mode."
`;
}
