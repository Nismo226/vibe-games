import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Build modes:
// - default: Tauri dev/build (fixed port 1420)
// - pages: Cloudflare Pages deploy, served under /<pagesBase>/
const isPages = process.env.VITE_DEPLOY_TARGET === "pages";
const pagesBase = process.env.VITE_PAGES_BASE || "ultimate-snake";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,

  base: isPages ? `/${pagesBase}/` : "/",

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
