import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

function getBuildId() {
  const env = process.env.VITE_BUILD_ID;
  if (env) return env;
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

// Build modes:
// - default: Tauri dev/build (fixed port 1420)
// - pages: Cloudflare Pages deploy, served under /<pagesBase>/
const isPages = process.env.VITE_DEPLOY_TARGET === "pages";
const pagesBase = process.env.VITE_PAGES_BASE || "ultimate-snake";
const buildId = getBuildId();

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,

  base: isPages ? `/${pagesBase}/` : "/",

  define: {
    "import.meta.env.VITE_BUILD_ID": JSON.stringify(buildId),
  },

  build: {
    outDir: isPages ? `dist/${pagesBase}` : "dist",
    emptyOutDir: true,
  },

  server: {
    port: 1420,
    strictPort: !isPages,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
