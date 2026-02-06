#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# VM-safe settings for WebKitGTK + VirtualBox (avoid white-screen WebKit internal errors)
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export LIBGL_ALWAYS_SOFTWARE=1
export GALLIUM_DRIVER=llvmpipe

# make logs chatty if needed
export TAURI_LOG=${TAURI_LOG:-info}

# Free the frontend port if a previous run left it open
fuser -k 1420/tcp 2>/dev/null || true

pnpm tauri dev
