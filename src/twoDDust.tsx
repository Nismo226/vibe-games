import { useEffect, useRef, useState } from "react";

type Cell = 0 | 1 | 2; // 0 air, 1 dirt, 2 stone

type Player = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  onGround: boolean;
};

const CELL = 12;
const GRID_W = 120;
const GRID_H = 56;
const GRAVITY = 1300;
const MOVE_SPEED = 240;
const JUMP_VEL = -460;
const MAX_DIRT = 50;

function idx(x: number, y: number) {
  return y * GRID_W + x;
}

function inBounds(x: number, y: number) {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

function solid(c: Cell) {
  return c === 1 || c === 2;
}

function hash2(x: number, y: number) {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function generateWorld(): Uint8Array {
  const g = new Uint8Array(GRID_W * GRID_H);

  const base = Math.floor(GRID_H * 0.62);
  for (let x = 0; x < GRID_W; x++) {
    const noise = Math.floor(Math.sin(x * 0.14) * 2 + Math.sin(x * 0.037) * 3);
    const groundY = base + noise;

    for (let y = groundY; y < GRID_H; y++) {
      g[idx(x, y)] = y > groundY + 6 ? 2 : 1; // stone deeper
    }
  }

  // A few floating islands of dirt
  for (let i = 0; i < 7; i++) {
    const cx = 12 + i * 14;
    const cy = 14 + (i % 3) * 3;
    for (let x = cx - 3; x <= cx + 3; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        if (inBounds(x, y) && Math.random() > 0.25) g[idx(x, y)] = 1;
      }
    }
  }

  // Make sure spawn area is open
  for (let x = 6; x < 18; x++) {
    for (let y = 8; y < 24; y++) g[idx(x, y)] = 0;
  }

  return g;
}

export const Dust = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const worldRef = useRef<Uint8Array>(generateWorld());
  const playerRef = useRef<Player>({
    x: 10 * CELL,
    y: 8 * CELL,
    vx: 0,
    vy: 0,
    w: 10,
    h: 18,
    onGround: false,
  });

  const keysRef = useRef<Record<string, boolean>>({});
  const mouseRef = useRef({ x: 0, y: 0, left: false, right: false });
  const mobileRef = useRef({
    moveId: -1,
    moveStartX: 0,
    moveStartY: 0,
    moveAxisX: 0,
    jumpQueued: false,
    toolId: -1,
    toolMode: "none" as "none" | "suck" | "drop",
    lastToolTapMs: 0,
  });
  const lastRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const toolRef = useRef({
    mineCooldown: 0,
    placeCooldown: 0,
    blobSize: 0,
    carrySize: 0,
    blobPulse: 0,
    blobX: 0,
    blobY: 0,
    particles: [] as Array<{ x: number; y: number; vx: number; vy: number; life: number; size: number }>,
    falling: [] as Array<{ x: number; y: number; vy: number }>,
  });

  const [dirt, setDirt] = useState(0);
  const dirtRef = useRef(0);
  const audioRef = useRef<{ ctx: AudioContext | null; enabled: boolean; lastMineAt: number; lastPlaceAt: number }>({
    ctx: null,
    enabled: false,
    lastMineAt: 0,
    lastPlaceAt: 0,
  });

  useEffect(() => {
    dirtRef.current = dirt;
  }, [dirt]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const canvasEl: HTMLCanvasElement = canvas;
    const world = worldRef.current;
    const player = playerRef.current;

    function ensureAudio() {
      if (audioRef.current.ctx) return audioRef.current.ctx;
      const Ctx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();
      audioRef.current.ctx = ctx;
      return ctx;
    }

    function playSuckSound(intensity = 0.5) {
      const nowMs = performance.now();
      if (nowMs - audioRef.current.lastMineAt < 26) return;
      audioRef.current.lastMineAt = nowMs;
      const ctx = ensureAudio();
      if (!ctx) return;

      const t0 = ctx.currentTime;
      const dur = 0.08;
      const src = ctx.createBufferSource();
      const length = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        const p = i / length;
        const noise = (Math.random() * 2 - 1) * (1 - p);
        data[i] = noise * (0.25 + intensity * 0.35);
      }
      src.buffer = buffer;

      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.setValueAtTime(420 + intensity * 520, t0);
      band.Q.setValueAtTime(1.1, t0);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.085 + intensity * 0.08, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      src.connect(band);
      band.connect(gain);
      gain.connect(ctx.destination);
      src.start(t0);
      src.stop(t0 + dur + 0.02);
    }

    function playDropSound(intensity = 0.5) {
      const nowMs = performance.now();
      if (nowMs - audioRef.current.lastPlaceAt < 34) return;
      audioRef.current.lastPlaceAt = nowMs;
      const ctx = ensureAudio();
      if (!ctx) return;

      const t0 = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(220 + intensity * 120, t0);
      osc.frequency.exponentialRampToValueAtTime(90, t0 + 0.07);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.055 + intensity * 0.06, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);

      const low = ctx.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.setValueAtTime(880, t0);

      osc.connect(low);
      low.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.1);
    }

    function resize() {
      canvasEl.width = window.innerWidth;
      canvasEl.height = window.innerHeight;
    }

    function onKeyDown(e: KeyboardEvent) {
      keysRef.current[e.key.toLowerCase()] = true;
      if (e.key === " " || e.key.startsWith("Arrow")) e.preventDefault();
    }
    function onKeyUp(e: KeyboardEvent) {
      keysRef.current[e.key.toLowerCase()] = false;
    }

    function onPointerMove(e: PointerEvent) {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;

      if (e.pointerType === "mouse") {
        mouseRef.current.left = (e.buttons & 1) !== 0;
        mouseRef.current.right = (e.buttons & 2) !== 0;
        return;
      }

      e.preventDefault();
      const mobile = mobileRef.current;
      if (e.pointerId === mobile.moveId) {
        const dx = e.clientX - mobile.moveStartX;
        mobile.moveAxisX = Math.max(-1, Math.min(1, dx / 42));
        if (mobile.moveStartY - e.clientY > 34) {
          mobile.jumpQueued = true;
        }
      }
    }

    function onPointerDown(e: PointerEvent) {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;

      const ctx = ensureAudio();
      if (ctx && ctx.state === "suspended") ctx.resume();

      if (e.pointerType === "mouse") {
        if (e.button === 0) mouseRef.current.left = true;
        if (e.button === 2) mouseRef.current.right = true;
        return;
      }

      e.preventDefault();
      const mobile = mobileRef.current;
      const leftZone = e.clientX < canvasEl.width * 0.46;

      if (leftZone && mobile.moveId === -1) {
        mobile.moveId = e.pointerId;
        mobile.moveStartX = e.clientX;
        mobile.moveStartY = e.clientY;
        mobile.moveAxisX = 0;
        return;
      }

      if (mobile.toolId === -1) {
        const now = performance.now();
        const doubleTap = now - mobile.lastToolTapMs < 290;
        mobile.toolId = e.pointerId;
        mobile.toolMode = doubleTap ? "drop" : "suck";
        mouseRef.current.left = mobile.toolMode === "suck";
        mouseRef.current.right = mobile.toolMode === "drop";
      }
    }

    function onPointerUp(e: PointerEvent) {
      if (e.pointerType === "mouse") {
        if (e.button === 0) mouseRef.current.left = false;
        if (e.button === 2) mouseRef.current.right = false;
        return;
      }

      e.preventDefault();
      const mobile = mobileRef.current;
      if (e.pointerId === mobile.moveId) {
        mobile.moveId = -1;
        mobile.moveAxisX = 0;
      }

      if (e.pointerId === mobile.toolId) {
        mobile.toolId = -1;
        mobile.toolMode = "none";
        mobile.lastToolTapMs = performance.now();
        mouseRef.current.left = false;
        mouseRef.current.right = false;
      }
    }

    function worldToCell(px: number, py: number) {
      return { x: Math.floor(px / CELL), y: Math.floor(py / CELL) };
    }

    function getCell(x: number, y: number): Cell {
      if (!inBounds(x, y)) return 2;
      return world[idx(x, y)] as Cell;
    }

    function setCell(x: number, y: number, v: Cell) {
      if (!inBounds(x, y)) return;
      world[idx(x, y)] = v;
    }

    function collidesRect(x: number, y: number, w: number, h: number) {
      const x0 = Math.floor(x / CELL);
      const y0 = Math.floor(y / CELL);
      const x1 = Math.floor((x + w - 1) / CELL);
      const y1 = Math.floor((y + h - 1) / CELL);

      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          if (solid(getCell(cx, cy))) return true;
        }
      }
      return false;
    }

    function isEdgeDirt(x: number, y: number) {
      if (getCell(x, y) !== 1) return false;
      return getCell(x + 1, y) === 0 || getCell(x - 1, y) === 0 || getCell(x, y + 1) === 0 || getCell(x, y - 1) === 0;
    }

    function findNearestDirt(targetX: number, targetY: number, reachPx: number) {
      const center = worldToCell(targetX, targetY);
      const maxR = Math.max(1, Math.ceil(reachPx / CELL));
      let best: { x: number; y: number; score: number } | null = null;

      for (let oy = -maxR; oy <= maxR; oy++) {
        for (let ox = -maxR; ox <= maxR; ox++) {
          const tx = center.x + ox;
          const ty = center.y + oy;
          if (!inBounds(tx, ty)) continue;
          if (getCell(tx, ty) !== 1) continue;

          const px = tx * CELL + CELL * 0.5;
          const py = ty * CELL + CELL * 0.5;
          const dpx = px - targetX;
          const dpy = py - targetY;
          const distPx = Math.hypot(dpx, dpy);
          if (distPx > reachPx) continue;

          const score = distPx + (isEdgeDirt(tx, ty) ? -4 : 0);
          if (!best || score < best.score) best = { x: tx, y: ty, score };
        }
      }

      return best;
    }

    function applyTools(camX: number, camY: number, dt: number) {
      const mx = mouseRef.current.x + camX;
      const my = mouseRef.current.y + camY;
      const tc = worldToCell(mx, my);
      const tool = toolRef.current;

      tool.mineCooldown = Math.max(0, tool.mineCooldown - dt);
      tool.placeCooldown = Math.max(0, tool.placeCooldown - dt);
      tool.blobPulse = Math.max(0, tool.blobPulse - dt * 2.4);
      tool.blobX = mx;
      tool.blobY = my;

      const carryTarget = dirtRef.current > 0 ? Math.min(26, 5 + Math.sqrt(dirtRef.current) * 1.25) : 0;
      tool.carrySize += (carryTarget - tool.carrySize) * Math.min(1, dt * 10);

      for (let i = tool.particles.length - 1; i >= 0; i--) {
        const p = tool.particles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.95;
        p.vy *= 0.95;
        p.life -= dt;
        if (p.life <= 0) tool.particles.splice(i, 1);
      }

      const pCenterX = player.x + player.w * 0.5;
      const pCenterY = player.y + player.h * 0.5;
      const dx = tc.x * CELL + CELL * 0.5 - pCenterX;
      const dy = tc.y * CELL + CELL * 0.5 - pCenterY;
      const dist = Math.hypot(dx, dy);
      const reach = 140 + tool.carrySize * 2.4;

      if (mouseRef.current.left) {
        tool.blobSize = Math.min(22, tool.blobSize + dt * 30);

        if (dist <= reach && tool.mineCooldown <= 0) {
          const suctionReach = reach + Math.max(0, tool.blobSize) * 1.4;
          const pick = findNearestDirt(mx, my, suctionReach);

          if (pick && dirtRef.current < MAX_DIRT) {
            const minedX = pick.x;
            const minedY = pick.y;
            setCell(minedX, minedY, 0);
            setDirt((v) => Math.min(MAX_DIRT, v + 1));

            const speedBoost = (tool.blobSize + tool.carrySize) / 40;
            tool.mineCooldown = Math.max(0.014, 0.042 - speedBoost * 0.02);
            tool.blobPulse = 1;
            playSuckSound(Math.min(1, 0.35 + speedBoost));

            const spawnCount = 1 + Math.floor((tool.blobSize + tool.carrySize) / 10);
            const srcX = minedX * CELL + CELL * 0.5;
            const srcY = minedY * CELL + CELL * 0.5;
            for (let i = 0; i < spawnCount; i++) {
              const t = 0.14 + Math.random() * 0.14;
              const toBlobX = mx - srcX;
              const toBlobY = my - srcY;
              tool.particles.push({
                x: srcX + (Math.random() - 0.5) * 4,
                y: srcY + (Math.random() - 0.5) * 4,
                vx: toBlobX / t + (Math.random() - 0.5) * 24,
                vy: toBlobY / t + (Math.random() - 0.5) * 24,
                life: 0.2 + Math.random() * 0.14,
                size: 1.2 + Math.random() * 2.1,
              });
            }
            if (tool.particles.length > 180) tool.particles.splice(0, tool.particles.length - 180);
          }
        }
      } else {
        tool.blobSize = Math.max(0, tool.blobSize - dt * 24);
      }

      if (mouseRef.current.right && tool.placeCooldown <= 0 && dist <= reach) {
        if (dirtRef.current > 0) {
          let spawnX = tc.x;
          let spawnY = tc.y;

          // if pointing into solid, spawn slightly above nearest open space
          if (inBounds(spawnX, spawnY) && getCell(spawnX, spawnY) !== 0) {
            for (let up = 1; up <= 6; up++) {
              if (inBounds(spawnX, spawnY - up) && getCell(spawnX, spawnY - up) === 0) {
                spawnY = spawnY - up;
                break;
              }
            }
          }

          if (inBounds(spawnX, spawnY)) {
            tool.falling.push({ x: spawnX * CELL + CELL * 0.5, y: spawnY * CELL + CELL * 0.5, vy: 0 });
            if (tool.falling.length > 220) tool.falling.splice(0, tool.falling.length - 220);
            setDirt((v) => Math.max(0, v - 1));
            tool.placeCooldown = 0.05;
            tool.blobPulse = Math.max(tool.blobPulse, 0.45);
            playDropSound(Math.min(1, 0.3 + tool.carrySize / 30));
          }
        }
      }
    }

    function update(dt: number) {
      const keys = keysRef.current;

      // horizontal input (keyboard + mobile left-zone drag)
      const mobile = mobileRef.current;
      const left = keys["a"] || keys["arrowleft"] || mobile.moveAxisX < -0.18;
      const right = keys["d"] || keys["arrowright"] || mobile.moveAxisX > 0.18;
      player.vx = 0;
      if (left) player.vx = -MOVE_SPEED * Math.max(0.6, Math.abs(mobile.moveAxisX) || 1);
      if (right) player.vx = MOVE_SPEED * Math.max(0.6, Math.abs(mobile.moveAxisX) || 1);

      // jump (keyboard + upward flick on left zone)
      const jump = keys["w"] || keys["arrowup"] || keys[" "] || mobile.jumpQueued;
      if (jump && player.onGround) {
        player.vy = JUMP_VEL;
        player.onGround = false;
      }
      mobile.jumpQueued = false;

      // gravity
      player.vy += GRAVITY * dt;
      if (player.vy > 900) player.vy = 900;

      // move X
      let nextX = player.x + player.vx * dt;
      if (collidesRect(nextX, player.y, player.w, player.h)) {
        const step = Math.sign(player.vx);
        while (!collidesRect(player.x + step, player.y, player.w, player.h)) {
          player.x += step;
        }
        player.vx = 0;
      } else {
        player.x = nextX;
      }

      // move Y
      let nextY = player.y + player.vy * dt;
      player.onGround = false;
      if (collidesRect(player.x, nextY, player.w, player.h)) {
        const step = Math.sign(player.vy);
        while (!collidesRect(player.x, player.y + step, player.w, player.h)) {
          player.y += step;
        }
        if (player.vy > 0) player.onGround = true;
        player.vy = 0;
      } else {
        player.y = nextY;
      }

      // clamp in world
      player.x = Math.max(0, Math.min(player.x, GRID_W * CELL - player.w));
      player.y = Math.max(0, Math.min(player.y, GRID_H * CELL - player.h));

      const tool = toolRef.current;
      for (let i = tool.falling.length - 1; i >= 0; i--) {
        const f = tool.falling[i];
        f.vy += GRAVITY * dt * 1.15;
        if (f.vy > 980) f.vy = 980;
        f.y += f.vy * dt;

        const cx = Math.floor(f.x / CELL);
        const cy = Math.floor(f.y / CELL);

        if (!inBounds(cx, cy)) {
          if (cy >= GRID_H) tool.falling.splice(i, 1);
          continue;
        }

        const belowY = cy + 1;
        const blockedBelow = belowY >= GRID_H || getCell(cx, belowY) !== 0;
        if (blockedBelow) {
          if (getCell(cx, cy) === 0) {
            setCell(cx, cy, 1);
          } else {
            // try to stack to side if occupied
            const leftOpen = inBounds(cx - 1, cy) && getCell(cx - 1, cy) === 0;
            const rightOpen = inBounds(cx + 1, cy) && getCell(cx + 1, cy) === 0;
            if (leftOpen || rightOpen) {
              const tx = leftOpen && rightOpen ? (Math.random() < 0.5 ? cx - 1 : cx + 1) : leftOpen ? cx - 1 : cx + 1;
              setCell(tx, cy, 1);
            }
          }
          tool.falling.splice(i, 1);
        }
      }
    }

    function draw(dt: number) {
      const ctx = canvasEl.getContext("2d");
      if (!ctx) return;

      const camX = Math.max(0, Math.min(player.x - canvasEl.width * 0.5, GRID_W * CELL - canvasEl.width));
      const camY = Math.max(0, Math.min(player.y - canvasEl.height * 0.55, GRID_H * CELL - canvasEl.height));

      // background
      const bg = ctx.createLinearGradient(0, 0, 0, canvasEl.height);
      bg.addColorStop(0, "#09122a");
      bg.addColorStop(1, "#0c1d12");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // world
      const startX = Math.floor(camX / CELL);
      const startY = Math.floor(camY / CELL);
      const endX = Math.min(GRID_W - 1, startX + Math.ceil(canvasEl.width / CELL) + 1);
      const endY = Math.min(GRID_H - 1, startY + Math.ceil(canvasEl.height / CELL) + 1);

      for (let y = startY; y <= endY; y++) {
        for (let x = startX; x <= endX; x++) {
          const c = world[idx(x, y)] as Cell;
          if (c === 0) continue;

          const sx = x * CELL - camX;
          const sy = y * CELL - camY;

          if (c === 1) {
            const n = hash2(x, y);
            const base = 88 + Math.floor(n * 26);
            ctx.fillStyle = `rgb(${base + 28}, ${base + 10}, ${base - 20})`;
            ctx.fillRect(sx, sy, CELL, CELL);

            // subtle internal color variation for grainy look
            const grad = ctx.createLinearGradient(sx, sy, sx + CELL, sy + CELL);
            grad.addColorStop(0, "rgba(238, 199, 132, 0.12)");
            grad.addColorStop(1, "rgba(90, 62, 30, 0.14)");
            ctx.fillStyle = grad;
            ctx.fillRect(sx, sy, CELL, CELL);

            // grain/sand speckle
            ctx.fillStyle = "rgba(234, 196, 134, 0.24)";
            if (hash2(x + 11, y + 7) > 0.35) ctx.fillRect(sx + 2, sy + 2, 2, 2);
            if (hash2(x + 17, y + 3) > 0.45) ctx.fillRect(sx + 7, sy + 3, 2, 2);
            if (hash2(x + 5, y + 19) > 0.4) ctx.fillRect(sx + 4, sy + 8, 2, 2);
            if (hash2(x + 13, y + 31) > 0.52) ctx.fillRect(sx + 9, sy + 5, 1, 1);

            ctx.fillStyle = "rgba(58, 40, 22, 0.24)";
            if (hash2(x + 23, y + 29) > 0.5) ctx.fillRect(sx + 9, sy + 7, 2, 2);
            if (hash2(x + 2, y + 37) > 0.58) ctx.fillRect(sx + 5, sy + 10, 1, 1);

            // fake soft contouring based on neighboring air
            if (getCell(x, y - 1) === 0) {
              ctx.fillStyle = "rgba(245, 213, 150, 0.28)";
              ctx.fillRect(sx, sy, CELL, 2);
            }
            if (getCell(x, y + 1) === 0) {
              ctx.fillStyle = "rgba(45, 29, 16, 0.3)";
              ctx.fillRect(sx, sy + CELL - 2, CELL, 2);
            }
            if (getCell(x - 1, y) === 0) {
              ctx.fillStyle = "rgba(230, 192, 130, 0.16)";
              ctx.fillRect(sx, sy, 2, CELL);
            }
            if (getCell(x + 1, y) === 0) {
              ctx.fillStyle = "rgba(40, 26, 14, 0.18)";
              ctx.fillRect(sx + CELL - 2, sy, 2, CELL);
            }
          } else {
            ctx.fillStyle = "#5b5f68";
            ctx.fillRect(sx, sy, CELL, CELL);
          }
        }
      }

      // ambient dust haze + cinematic grading
      const haze = ctx.createRadialGradient(
        canvasEl.width * 0.5,
        canvasEl.height * 0.45,
        20,
        canvasEl.width * 0.5,
        canvasEl.height * 0.45,
        Math.max(canvasEl.width, canvasEl.height) * 0.75,
      );
      haze.addColorStop(0, "rgba(225, 185, 120, 0.055)");
      haze.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const vignette = ctx.createRadialGradient(
        canvasEl.width * 0.5,
        canvasEl.height * 0.45,
        Math.min(canvasEl.width, canvasEl.height) * 0.15,
        canvasEl.width * 0.5,
        canvasEl.height * 0.45,
        Math.max(canvasEl.width, canvasEl.height) * 0.72,
      );
      vignette.addColorStop(0, "rgba(0,0,0,0)");
      vignette.addColorStop(1, "rgba(0,0,0,0.22)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // falling placed dirt clumps
      const tool = toolRef.current;
      if (tool.falling.length) {
        for (const f of tool.falling) {
          ctx.fillStyle = "rgba(140, 106, 64, 0.95)";
          ctx.beginPath();
          ctx.arc(f.x - camX, f.y - camY, 3.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // suction particles
      if (tool.particles.length) {
        for (const p of tool.particles) {
          const alpha = Math.max(0, Math.min(1, p.life * 3.2));
          ctx.fillStyle = `rgba(191, 151, 98, ${0.2 + alpha * 0.45})`;
          ctx.beginPath();
          ctx.arc(p.x - camX, p.y - camY, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // persistent carried dirt blob (stays while inventory > 0)
      const visibleBlob = Math.max(tool.carrySize, tool.blobSize * 0.9);
      if (visibleBlob > 0.35) {
        const bx = tool.blobX - camX;
        const by = tool.blobY - camY;
        const pulse = tool.blobPulse;

        ctx.save();
        ctx.globalCompositeOperation = "lighter";

        ctx.fillStyle = `rgba(184, 145, 92, ${0.12 + pulse * 0.22})`;
        ctx.beginPath();
        ctx.arc(bx, by, visibleBlob + pulse * 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(130, 96, 58, ${0.26 + pulse * 0.2})`;
        ctx.beginPath();
        ctx.arc(bx - visibleBlob * 0.28, by + visibleBlob * 0.1, visibleBlob * 0.66, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(208, 171, 111, ${0.32 + pulse * 0.24})`;
        ctx.beginPath();
        ctx.arc(bx + visibleBlob * 0.32, by - visibleBlob * 0.16, visibleBlob * 0.48, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      }

      // mouse target
      const mx = mouseRef.current.x + camX;
      const my = mouseRef.current.y + camY;
      const tc = worldToCell(mx, my);
      if (inBounds(tc.x, tc.y)) {
        ctx.strokeStyle = "rgba(180,220,255,0.9)";
        ctx.lineWidth = 2;
        ctx.strokeRect(tc.x * CELL - camX, tc.y * CELL - camY, CELL, CELL);
      }

      // player
      ctx.fillStyle = "#cfe9ff";
      ctx.fillRect(player.x - camX, player.y - camY, player.w, player.h);

      // HUD
      ctx.fillStyle = "rgba(10,18,30,0.72)";
      ctx.fillRect(14, 14, 360, 78);
      ctx.strokeStyle = "rgba(170,210,255,0.45)";
      ctx.strokeRect(14, 14, 360, 78);

      ctx.fillStyle = "#d8eeff";
      ctx.font = "16px system-ui";
      ctx.fillText("2D Dust Prototype", 28, 38);
      ctx.font = "14px system-ui";
      ctx.fillText(`Dirt: ${dirtRef.current}/${MAX_DIRT}`, 28, 60);
      ctx.fillText("Mouse: L Suck / R Drop | Touch: Left drag=move/flick jump | Tap+hold suck | Double-tap+hold drop", 28, 82);

      // subtle film grain
      const t = performance.now() * 0.001;
      ctx.fillStyle = `rgba(255,255,255,${0.018 + Math.sin(t * 2.7) * 0.004})`;
      for (let i = 0; i < 130; i++) {
        const gx = ((i * 73.13 + t * 97) % canvasEl.width + canvasEl.width) % canvasEl.width;
        const gy = ((i * 51.77 + t * 61) % canvasEl.height + canvasEl.height) % canvasEl.height;
        ctx.fillRect(gx, gy, 1, 1);
      }

      applyTools(camX, camY, dt);
    }

    function frame(ts: number) {
      if (!lastRef.current) lastRef.current = ts;
      const dt = Math.min(0.033, (ts - lastRef.current) / 1000);
      lastRef.current = ts;

      update(dt);
      draw(dt);
      rafRef.current = requestAnimationFrame(frame);
    }

    resize();
    rafRef.current = requestAnimationFrame(frame);

    window.addEventListener("resize", resize);
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerdown", onPointerDown, { passive: false });
    window.addEventListener("pointerup", onPointerUp, { passive: false });
    window.addEventListener("pointercancel", onPointerUp, { passive: false });

    const preventMenu = (e: Event) => e.preventDefault();
    canvasEl.addEventListener("contextmenu", preventMenu);
    canvasEl.style.touchAction = "none";
    canvasEl.style.userSelect = "none";
    (canvasEl.style as CSSStyleDeclaration & { webkitTouchCallout?: string }).webkitTouchCallout = "none";
    document.body.style.overscrollBehavior = "none";

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      canvasEl.removeEventListener("contextmenu", preventMenu);
      document.body.style.overscrollBehavior = "";
      if (audioRef.current.ctx) {
        audioRef.current.ctx.close();
        audioRef.current.ctx = null;
      }
    };
  }, []);

  return <canvas ref={canvasRef} style={{ display: "block", width: "100vw", height: "100vh" }} />;
};
