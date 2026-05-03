#!/usr/bin/env node
// Builds the orgd sidecar daemon and stages it where Tauri's
// externalBin resolver expects it. Tauri requires the triple suffix
// on the file name; bundling then ships it next to systema-claude.exe.
//
// Layout: app/ and orgd/ are siblings under the systema-claude repo root.
//   <repo>/app/                 ← this app
//   <repo>/orgd/                ← Rust daemon crate
//   <repo>/orgd/target/release/ ← cargo build --release output

import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");                  // <repo>/app
const repoRoot = resolve(appRoot, "..");              // <repo>
const orgdCrate = join(repoRoot, "orgd");             // <repo>/orgd
const tauriDir = join(appRoot, "src-tauri");
const binDir = join(tauriDir, "binaries");

if (!existsSync(join(orgdCrate, "Cargo.toml"))) {
  console.error(`[build-orgd] FATAL: orgd crate missing at ${orgdCrate}`);
  process.exit(1);
}

const triple = (() => {
  // rustc -vV is authoritative — Tauri uses the same triple to resolve externalBin.
  const out = execSync("rustc -vV", { encoding: "utf8" });
  const m = out.match(/^host:\s*(.+)$/m);
  if (!m) throw new Error("could not determine rustc host triple");
  return m[1].trim();
})();

const ext = process.platform === "win32" ? ".exe" : "";
const stagedName = `orgd-${triple}${ext}`;
const stagedPath = join(binDir, stagedName);

console.log(`[build-orgd] target triple: ${triple}`);
console.log(`[build-orgd] building orgd (release)...`);
execSync("cargo build --release", { cwd: orgdCrate, stdio: "inherit" });

// orgd's target/ lives inside the orgd crate (no workspace Cargo.toml here).
const builtPath = join(orgdCrate, "target", "release", `orgd${ext}`);
if (!existsSync(builtPath)) {
  throw new Error(`orgd not found at ${builtPath} after build`);
}

mkdirSync(binDir, { recursive: true });
copyFileSync(builtPath, stagedPath);
console.log(`[build-orgd] staged → ${stagedPath}`);
