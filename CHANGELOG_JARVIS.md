# Ultimate Snake — Jarvis Changelog

This file is the "persistent memory" for work done in this repo. If chat memory gets wiped again, read this first.

## How to run

### Dev (browser)
```bash
cd /home/crywolf/clawd/projects/lyric-door
pnpm dev --host 0.0.0.0 --port 5173
# open: http://localhost:5173/  (or http://10.0.2.15:5173/ from another device on the VM network)
```

### Build (web)
```bash
pnpm build
pnpm preview --host 0.0.0.0 --port 5173
```

### Tauri (desktop)
```bash
pnpm tauri dev
```

## Changes

### 2026-02-06
- AAA visual upgrades:
  - Added screen shake (decays smoothly)
  - Added particles/bursts on events: food, boost food, poison, shield save, dash, death
  - Added cheap bloom pass (blur + screen composite)
  - Added vignette + subtle grain
  - Slight canvas color polish via CSS (saturate/contrast)
- Git commit: `dee6925` ("AAA visuals: particles, shake, bloom/vignette, polish")

- Run-start perk draft + SFX:
  - New start-of-run overlay: choose 1 of 3 starting perks before Round 1 begins
  - SFX using WebAudio (buffer-based, louder + compressor): eat/boost/poison/dash/shield/death + UI
  - Mute/Unmute SFX button in the top bar
  - Keyboard navigation for perk/upgrade cards: ←/→ or 1/2/3, Enter to confirm
  - Added always-visible SFX controls (Mute + volume slider) and extra audio-unlock attempts on key/pointer
  - Big length HUD at top of arena (no progress bars)
  - Fixed rival win condition at length 50
  - Fixed overlay key navigation double-step (was skipping middle option)
  - Added RPS result pause: outcome shows + Enter to continue
  - Added Test SFX diagnostic button + capped DPR (performance when maximized)
  - Toast is now fixed + visible above overlays
  - Added Pause menu (Esc to pause, Enter to resume)
  - Tauri dev uses port 1420 and kills any existing process using it before starting
  - Added cyber-cinematic WAV SFX and switched playback to HTMLAudio (more reliable in Tauri)
  - Added persistent debug logging to a file in Tauri app-data (SFX play attempts + errors)
  - Added Rust-native BGM loop + UI controls (Music On/Off + slider)
  - Bundled your Suno track (trimmed to 2:00) as `assets/music/bgm.ogg`
  - Added enemy pickup SFX variants (cut from your ElevenLabs MP3) and plays when rival eats
  - Boosted enemy pickup loudness + small UI declutter (removed debug pills, topbar wraps)
  - Removed all in-arena HUD text (moved key stats to top bar) to prevent overlap
- Git commits:
  - `7839675` ("Add starting perk draft + basic SFX + mute")
  - `ca6f44a` ("Improve SFX loudness/quality + keyboard nav for perk/upgrade menus")
  - `a167d38` ("Fix rival win at 50, add big length HUD, add visible volume/mute + audio unlock")
  - `48d4345` ("Fix menu key double-step, add RPS result confirm, declutter HUD bars")

Notes:
- Vite dev server typically runs at `http://localhost:5173/`.
- If keyboard input is flaky in Tauri/VM, there are on-screen arrow buttons while playing.
