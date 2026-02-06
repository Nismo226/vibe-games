#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
    shell: false,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Cloudflare Pages sets CF_PAGES=1 in the build environment.
const isPages = process.env.CF_PAGES === "1";

if (isPages) {
  // Build portal + game under /ultimate-snake/
  run("pnpm", ["run", "build:pages"]);
} else {
  // Normal local/tauri build
  run("pnpm", ["run", "build:local"]);
}
