import { useEffect, useRef, useState } from "react";

type Cell = 0 | 1 | 2 | 3; // 0 air, 1 dirt, 2 stone, 3 water

type Player = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  onGround: boolean;
  coyoteTimer: number;
  jumpBufferTimer: number;
  prevWaterSubmerge: number;
};

type QuestState = "explore" | "dialog" | "countdown" | "wave" | "success" | "fail";

const CELL = 12;
const GRID_W = 120;
const GRID_H = 56;
const GRAVITY = 1300;
const MOVE_SPEED = 240;
const JUMP_VEL = -460;
const COYOTE_TIME = 0.11;
const JUMP_BUFFER_TIME = 0.12;
const MAX_DIRT = 50;
const GAME_VERSION = "v0.1.9";
const BARRIER_GOAL = 16;
const STEP_HEIGHT = 10;

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

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function generateWorld(): Uint8Array {
  const g = new Uint8Array(GRID_W * GRID_H);

  const base = Math.floor(GRID_H * 0.62);
  for (let x = 0; x < GRID_W; x++) {
    const noise = Math.floor(Math.sin(x * 0.14) * 2 + Math.sin(x * 0.037) * 3);
    const groundY = base + noise;

    const stoneStart = GRID_H - 5; // keep only bottom 5 rows as bedrock
    for (let y = groundY; y < GRID_H; y++) {
      g[idx(x, y)] = y >= stoneStart ? 2 : 1;
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
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    prevWaterSubmerge: 0,
  });
  const tribeRef = useRef({ x: (GRID_W - 14) * CELL, y: 30 * CELL, w: 12, h: 18 });
  const questRef = useRef<{
    state: QuestState;
    timer: number;
    dialogElapsed: number;
    tsunamiX: number;
    tsunamiSpeed: number;
    waveTime: number;
    resultText: string;
    resultHold: number;
  }>({
    state: "explore",
    timer: 90,
    dialogElapsed: 0,
    tsunamiX: -220,
    tsunamiSpeed: 94,
    waveTime: 0,
    resultText: "",
    resultHold: 0,
  });

  const keysRef = useRef<Record<string, boolean>>({});
  const mouseRef = useRef({ x: 0, y: 0, left: false, right: false });
  const mobileRef = useRef({
    moveId: -1,
    moveStartX: 0,
    moveStartY: 0,
    moveAxisX: 0,
    stickX: 0,
    stickY: 0,
    jumpQueued: false,
    toolId: -1,
    toolMode: "none" as "none" | "suck" | "drop",
    toolToggle: "suck" as "suck" | "drop",
  });
  const lastRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const cameraRef = useRef({ x: 0, y: 0 });
  const toolRef = useRef({
    mineCooldown: 0,
    placeCooldown: 0,
    blobSize: 0,
    carrySize: 0,
    blobPulse: 0,
    blobX: 0,
    blobY: 0,
    particles: [] as Array<{ x: number; y: number; vx: number; vy: number; life: number; size: number }>,
    waterFx: [] as Array<{ x: number; y: number; vx: number; vy: number; life: number; size: number }>,
    falling: [] as Array<{ x: number; y: number; vy: number }>,
  });

  const [dirt, setDirt] = useState(0);
  const dirtRef = useRef(0);
  const audioRef = useRef<{
    ctx: AudioContext | null;
    enabled: boolean;
    lastMineAt: number;
    lastPlaceAt: number;
    lastAlertAt: number;
    storm: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null;
    stormLevel: number;
  }>({
    ctx: null,
    enabled: false,
    lastMineAt: 0,
    lastPlaceAt: 0,
    lastAlertAt: 0,
    storm: null,
    stormLevel: 0,
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

    function resetLevel() {
      world.set(generateWorld());
      player.x = 10 * CELL;
      player.y = 8 * CELL;
      player.vx = 0;
      player.vy = 0;
      player.onGround = false;
      player.prevWaterSubmerge = 0;
      cameraRef.current.x = 0;
      cameraRef.current.y = 0;

      const quest = questRef.current;
      quest.state = "explore";
      quest.timer = 90;
      quest.dialogElapsed = 0;
      quest.tsunamiX = -220;
      quest.waveTime = 0;
      quest.resultText = "";
      quest.resultHold = 0;

      const tool = toolRef.current;
      tool.falling.length = 0;
      tool.particles.length = 0;
      tool.waterFx.length = 0;
      tool.blobSize = 0;
      tool.carrySize = 0;

      setDirt(0);
    }

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

    function playAlertPing(threat: number) {
      const nowMs = performance.now();
      const clamped = Math.max(0, Math.min(1, threat));
      const intervalMs = 980 - clamped * 700;
      if (nowMs - audioRef.current.lastAlertAt < intervalMs) return;
      audioRef.current.lastAlertAt = nowMs;

      const ctx = ensureAudio();
      if (!ctx) return;
      const t0 = ctx.currentTime;

      const osc = ctx.createOscillator();
      osc.type = "sine";
      const baseFreq = 460 + clamped * 300;
      osc.frequency.setValueAtTime(baseFreq, t0);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * (1.18 + clamped * 0.16), t0 + 0.07);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.022 + clamped * 0.035, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);

      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(240, t0);

      osc.connect(hp);
      hp.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.14);
    }

    function ensureStormAudio() {
      const ctx = ensureAudio();
      if (!ctx) return null;
      if (audioRef.current.storm) return audioRef.current.storm;

      const dur = 1.8;
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        const prev = i > 0 ? data[i - 1] : 0;
        data[i] = prev * 0.92 + white * 0.08;
      }

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(260, ctx.currentTime);
      filter.Q.setValueAtTime(0.7, ctx.currentTime);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);

      src.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      src.start();

      audioRef.current.storm = { src, filter, gain };
      return audioRef.current.storm;
    }

    function updateStormAudio(level: number, dt: number) {
      const target = Math.max(0, Math.min(1, level));
      const current = audioRef.current.stormLevel;
      audioRef.current.stormLevel = current + (target - current) * Math.min(1, dt * 2.8);

      if (audioRef.current.stormLevel < 0.01 && !audioRef.current.storm) return;

      const storm = ensureStormAudio();
      const ctx = audioRef.current.ctx;
      if (!storm || !ctx) return;

      const t = ctx.currentTime;
      const strength = audioRef.current.stormLevel;
      const targetGain = 0.0001 + strength * 0.075;
      const targetFreq = 180 + strength * 430;
      storm.gain.gain.cancelScheduledValues(t);
      storm.gain.gain.setTargetAtTime(targetGain, t, 0.08);
      storm.filter.frequency.cancelScheduledValues(t);
      storm.filter.frequency.setTargetAtTime(targetFreq, t, 0.08);
    }

    function resize() {
      canvasEl.width = window.innerWidth;
      canvasEl.height = window.innerHeight;
    }

    function onKeyDown(e: KeyboardEvent) {
      keysRef.current[e.key.toLowerCase()] = true;
      if (e.key.toLowerCase() === "r") {
        resetLevel();
        e.preventDefault();
      }
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
        const joyRadius = 60;
        const dx = e.clientX - mobile.moveStartX;
        const dy = e.clientY - mobile.moveStartY;
        const mag = Math.hypot(dx, dy);
        const scale = mag > joyRadius ? joyRadius / mag : 1;
        mobile.stickX = dx * scale;
        mobile.stickY = dy * scale;
        mobile.moveAxisX = Math.max(-1, Math.min(1, mobile.stickX / joyRadius));
        if (-mobile.stickY > 30) {
          mobile.jumpQueued = true;
        }
      }
    }

    function onPointerDown(e: PointerEvent) {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;

      const ctx = ensureAudio();
      if (ctx && ctx.state === "suspended") ctx.resume();

      const restartW = 104;
      const restartH = 34;
      const restartX = canvasEl.width - restartW - 16;
      const restartY = 18;
      const onRestart = e.clientX >= restartX && e.clientX <= restartX + restartW && e.clientY >= restartY && e.clientY <= restartY + restartH;
      if (onRestart) {
        resetLevel();
        if (e.pointerType !== "mouse") e.preventDefault();
        return;
      }

      const toggleW = 132;
      const toggleH = 44;
      const toggleX = canvasEl.width - toggleW - 16;
      const toggleY = canvasEl.height - toggleH - 52;
      const onToggle = e.clientX >= toggleX && e.clientX <= toggleX + toggleW && e.clientY >= toggleY && e.clientY <= toggleY + toggleH;

      if (onToggle) {
        const mobile = mobileRef.current;
        mobile.toolToggle = mobile.toolToggle === "suck" ? "drop" : "suck";
        mobile.toolId = -1;
        mobile.toolMode = "none";
        mobile.moveId = -1;
        mobile.moveAxisX = 0;
        mobile.stickX = 0;
        mobile.stickY = 0;
        mouseRef.current.left = false;
        mouseRef.current.right = false;
        if (e.pointerType !== "mouse") e.preventDefault();
        return;
      }

      if (e.pointerType === "mouse") {
        if (e.button === 0) mouseRef.current.left = true;
        if (e.button === 2) mouseRef.current.right = true;
        return;
      }

      e.preventDefault();
      const mobile = mobileRef.current;
      const joyCenterX = 96;
      const joyCenterY = canvasEl.height - 108;
      const joyActivateR = 74;
      const inJoy = Math.hypot(e.clientX - joyCenterX, e.clientY - joyCenterY) <= joyActivateR;

      if (inJoy && mobile.moveId === -1) {
        mobile.moveId = e.pointerId;
        mobile.moveStartX = joyCenterX;
        mobile.moveStartY = joyCenterY;
        mobile.moveAxisX = 0;
        mobile.stickX = 0;
        mobile.stickY = 0;
        return;
      }

      if (mobile.toolId === -1) {
        mobile.toolId = e.pointerId;
        mobile.toolMode = mobile.toolToggle;
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
        mobile.stickX = 0;
        mobile.stickY = 0;
      }

      if (e.pointerId === mobile.toolId) {
        mobile.toolId = -1;
        mobile.toolMode = "none";
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

    function clearWater() {
      for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
          if (getCell(x, y) === 3) setCell(x, y, 0);
        }
      }
    }

    function getBarrierPlan() {
      const tribe = tribeRef.current;
      const tcx = Math.floor((tribe.x + tribe.w * 0.5) / CELL);
      const tcy = Math.floor((tribe.y + tribe.h * 0.5) / CELL);
      return {
        x0: tcx - 5,
        x1: tcx - 1,
        y0: tcy - 5,
        y1: tcy + 2,
      };
    }

    function tribeBarrierStrength() {
      const plan = getBarrierPlan();
      let score = 0;

      // count dirt blocks in front-right of tribe as "barrier"
      for (let x = plan.x0; x <= plan.x1; x++) {
        for (let y = plan.y0; y <= plan.y1; y++) {
          if (inBounds(x, y) && getCell(x, y) === 1) score++;
        }
      }
      return score;
    }
    function tribeAirPocketScore() {
      const tribe = tribeRef.current;
      const tcx = Math.floor((tribe.x + tribe.w * 0.5) / CELL);
      const tcy = Math.floor((tribe.y + tribe.h * 0.5) / CELL);
      let air = 0;
      for (let x = tcx - 1; x <= tcx + 2; x++) {
        for (let y = tcy - 2; y <= tcy + 1; y++) {
          if (!inBounds(x, y)) continue;
          if (getCell(x, y) === 0) air++;
        }
      }
      return air;
    }

    function tribeEntombed() {
      return tribeAirPocketScore() < 6;
    }

    function inTribeNoBuildZone(x: number, y: number) {
      const tribe = tribeRef.current;
      const tcx = Math.floor((tribe.x + tribe.w * 0.5) / CELL);
      const tcy = Math.floor((tribe.y + tribe.h * 0.5) / CELL);
      return x >= tcx - 1 && x <= tcx + 2 && y >= tcy - 2 && y <= tcy + 1;
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

    function playerWaterSubmergeRatio(x: number, y: number, w: number, h: number) {
      const x0 = Math.floor(x / CELL);
      const y0 = Math.floor(y / CELL);
      const x1 = Math.floor((x + w - 1) / CELL);
      const y1 = Math.floor((y + h - 1) / CELL);
      let total = 0;
      let water = 0;

      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          total++;
          if (getCell(cx, cy) === 3) water++;
        }
      }

      return total > 0 ? water / total : 0;
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

    function spawnWaterSplash(x: number, y: number, intensity: number) {
      const tool = toolRef.current;
      const count = Math.max(4, Math.min(22, Math.floor(5 + intensity * 14)));
      for (let i = 0; i < count; i++) {
        const a = -Math.PI * (0.1 + Math.random() * 0.8);
        const speed = 36 + intensity * 120 + Math.random() * 80;
        tool.waterFx.push({
          x: x + (Math.random() - 0.5) * 10,
          y: y + (Math.random() - 0.5) * 4,
          vx: Math.cos(a) * speed * (Math.random() < 0.5 ? -1 : 1) * 0.5,
          vy: Math.sin(a) * speed,
          life: 0.24 + Math.random() * 0.32,
          size: 1.2 + Math.random() * 2.2,
        });
      }
      if (tool.waterFx.length > 220) tool.waterFx.splice(0, tool.waterFx.length - 220);
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

      for (let i = tool.waterFx.length - 1; i >= 0; i--) {
        const p = tool.waterFx[i];
        p.vy += 620 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.94;
        p.vy *= 0.96;
        p.life -= dt;
        if (p.life <= 0) tool.waterFx.splice(i, 1);
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

          const questNow = questRef.current;
          const blockedNearTribe = (questNow.state === "countdown" || questNow.state === "wave") && inTribeNoBuildZone(spawnX, spawnY);
          if (inBounds(spawnX, spawnY) && getCell(spawnX, spawnY) === 0 && !blockedNearTribe) {
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

    function getStormWind(quest: { state: QuestState; timer: number; waveTime: number }) {
      const countdown = quest.state === "countdown" ? Math.max(0, Math.min(1, 1 - quest.timer / 90)) : 0;
      const wave = quest.state === "wave" ? Math.max(0, Math.min(1, 0.35 + quest.waveTime * 0.2)) : 0;
      const storm = Math.max(countdown, wave);
      if (storm <= 0) return { gust: 0, storm: 0 };

      const t = performance.now() * 0.001;
      const sway = Math.sin(t * 0.85) * 0.6 + Math.sin(t * 1.9 + 1.7) * 0.4;
      const pulse = Math.max(0, Math.sin(t * 0.55 + 0.8));
      const gust = sway * (26 + storm * 58) + pulse * storm * 34;
      return { gust, storm };
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

      // jump buffering + coyote time (for less frustrating platforming)
      const jumpPressed = keys["w"] || keys["arrowup"] || keys[" "] || mobile.jumpQueued;
      if (jumpPressed) player.jumpBufferTimer = JUMP_BUFFER_TIME;
      else player.jumpBufferTimer = Math.max(0, player.jumpBufferTimer - dt);
      mobile.jumpQueued = false;

      const waterSubmerge = playerWaterSubmergeRatio(player.x, player.y, player.w, player.h);
      const inWater = waterSubmerge > 0;
      const crossedIntoWater = player.prevWaterSubmerge <= 0.06 && waterSubmerge > 0.18;
      const crossedOutWater = player.prevWaterSubmerge > 0.18 && waterSubmerge <= 0.06;

      if ((crossedIntoWater || crossedOutWater) && Math.abs(player.vy) > 120) {
        const impact = Math.min(1, Math.abs(player.vy) / 520 + waterSubmerge * 0.6);
        spawnWaterSplash(player.x + player.w * 0.5, player.y + player.h * (crossedIntoWater ? 0.9 : 0.25), impact);
      }

      // gravity + water buoyancy/drag polish
      player.vy += GRAVITY * dt;
      if (inWater) {
        const buoyancy = Math.min(0.82, 0.28 + waterSubmerge * 0.58);
        player.vy -= GRAVITY * dt * buoyancy;

        // swim control: holding jump gives a gentle upward kick while submerged
        if (jumpPressed) {
          player.vy -= (520 + 360 * waterSubmerge) * dt;
        }

        const waterDrag = 0.84 - waterSubmerge * 0.12;
        player.vx *= Math.max(0.65, waterDrag);
        player.vy *= Math.max(0.76, waterDrag + 0.05);
      }

      const wind = getStormWind(questRef.current);
      if (wind.storm > 0) {
        const controlDampen = Math.max(0.28, 1 - Math.abs(player.vx) / (MOVE_SPEED + 40));
        const waterBoost = inWater ? 1.35 : 1;
        player.vx += wind.gust * dt * (0.9 + wind.storm * 0.8) * controlDampen * waterBoost;
      }

      if (player.vy > 900) player.vy = 900;
      if (inWater && player.vy < -260) player.vy = -260;

      // move X (with low step-up assist so movement feels less snaggy on 1-tile lips)
      let nextX = player.x + player.vx * dt;
      if (collidesRect(nextX, player.y, player.w, player.h)) {
        const stepDir = Math.sign(player.vx);
        let stepped = false;

        // only step when moving horizontally with intent and not deeply submerged
        if (stepDir !== 0 && (player.onGround || player.coyoteTimer > 0.02) && waterSubmerge < 0.2) {
          for (let up = 2; up <= STEP_HEIGHT; up += 2) {
            if (!collidesRect(player.x, player.y - up, player.w, player.h) && !collidesRect(nextX, player.y - up, player.w, player.h)) {
              player.y -= up;
              player.x = nextX;
              stepped = true;
              break;
            }
          }
        }

        if (!stepped) {
          while (!collidesRect(player.x + stepDir, player.y, player.w, player.h)) {
            player.x += stepDir;
          }
          player.vx = 0;
        }
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

      if (player.onGround) player.coyoteTimer = COYOTE_TIME;
      else player.coyoteTimer = Math.max(0, player.coyoteTimer - dt);

      if (!inWater && player.jumpBufferTimer > 0 && player.coyoteTimer > 0) {
        player.vy = JUMP_VEL;
        player.onGround = false;
        player.coyoteTimer = 0;
        player.jumpBufferTimer = 0;
      }

      const quest = questRef.current;
      const tribe = tribeRef.current;
      const playerCenterX = player.x + player.w * 0.5;
      const playerCenterY = player.y + player.h * 0.5;
      const tribeCenterX = tribe.x + tribe.w * 0.5;
      const tribeCenterY = tribe.y + tribe.h * 0.5;
      const nearTribe = Math.hypot(playerCenterX - tribeCenterX, playerCenterY - tribeCenterY) < 70;

      if (quest.state === "explore" && nearTribe) {
        quest.state = "dialog";
        quest.dialogElapsed = 0;
      }

      if (quest.state === "dialog") {
        quest.dialogElapsed += dt;
        if (quest.dialogElapsed >= 2.2) {
          quest.state = "countdown";
          quest.timer = 90;
          quest.tsunamiX = -220;
          quest.waveTime = 0;
          quest.resultHold = 0;
          clearWater();
        }
      } else if (quest.state === "countdown") {
        quest.timer = Math.max(0, quest.timer - dt);
        if (quest.timer <= 0) {
          quest.state = "wave";
          quest.waveTime = 0;
          quest.tsunamiX = -220;
        }
      } else if (quest.state === "wave") {
        quest.waveTime += dt;
        quest.tsunamiX += quest.tsunamiSpeed * dt;

        // Physical source only at far LEFT (prevents water teleporting through sealed walls)
        const sourceCols = 3;
        const waveY0 = Math.floor(GRID_H * 0.3);
        const waveY1 = Math.floor(GRID_H * 0.82);
        for (let x = 0; x < sourceCols; x++) {
          for (let y = waveY0; y < waveY1; y++) {
            if (getCell(x, y) === 0) setCell(x, y, 3);
          }
        }

        // Advancing tsunami front: only extend into cells that have water directly to the left.
        // This keeps the big wave visible while still respecting sealed barriers.
        const frontCell = Math.min(GRID_W - 1, Math.floor(quest.tsunamiX / CELL));
        for (let x = 1; x <= frontCell; x++) {
          for (let y = waveY0; y < waveY1; y++) {
            if (getCell(x, y) !== 0) continue;
            if (getCell(x - 1, y) === 3) setCell(x, y, 3);
          }
        }

        // Block-water fluid step with stronger pressure and anti-tunnel behavior
        const steps = 4;
        for (let step = 0; step < steps; step++) {
          for (let y = GRID_H - 2; y >= 1; y--) {
            for (let x = 1; x < GRID_W - 1; x++) {
              if (getCell(x, y) !== 3) continue;

              // gravity
              if (getCell(x, y + 1) === 0) {
                setCell(x, y + 1, 3);
                setCell(x, y, 0);
                continue;
              }

              const dir = Math.random() < 0.5 ? -1 : 1;
              // diagonal spill
              if (getCell(x + dir, y + 1) === 0) {
                setCell(x + dir, y + 1, 3);
                setCell(x, y, 0);
                continue;
              }
              if (getCell(x - dir, y + 1) === 0) {
                setCell(x - dir, y + 1, 3);
                setCell(x, y, 0);
                continue;
              }

              // side pressure
              if (getCell(x + dir, y) === 0) {
                setCell(x + dir, y, 3);
                setCell(x, y, 0);
                continue;
              }
              if (getCell(x - dir, y) === 0) {
                setCell(x - dir, y, 3);
                setCell(x, y, 0);
                continue;
              }

              // upward pressure only when compressed from left side (wave pushing right)
              const compressed = getCell(x - 1, y) === 3 && getCell(x, y + 1) !== 0;
              if (compressed && getCell(x, y - 1) === 0) {
                setCell(x, y - 1, 3);
                setCell(x, y, 0);
              }
            }
          }
        }

        const tx0 = Math.floor(tribe.x / CELL);
        const ty0 = Math.floor(tribe.y / CELL);
        const tx1 = Math.floor((tribe.x + tribe.w - 1) / CELL);
        const ty1 = Math.floor((tribe.y + tribe.h - 1) / CELL);
        let tribeWet = false;
        for (let y = ty0; y <= ty1 && !tribeWet; y++) {
          for (let x = tx0; x <= tx1 && !tribeWet; x++) {
            if (inBounds(x, y) && getCell(x, y) === 3) tribeWet = true;
          }
        }

        const buried = tribeEntombed();
        const wavePassed = frontCell >= GRID_W - 2 && quest.waveTime > 5;
        if (buried) {
          quest.state = "fail";
          quest.resultText = "The tribe was buried. Keep an open safety pocket around them.";
        } else if (tribeWet) {
          quest.state = "fail";
          quest.resultText = "The wave hit the tribe.";
        } else if (wavePassed) {
          quest.state = "success";
          quest.resultText = "Barrier held! The tribe is safe.";
        }
      }

      if (quest.state === "success" || quest.state === "fail") {
        quest.resultHold += dt;
        if (quest.resultHold > 3.2) resetLevel();
      }

      const stormCountdown = quest.state === "countdown" ? Math.max(0, Math.min(1, 1 - quest.timer / 90)) : 0;
      const stormWave = quest.state === "wave" ? Math.max(0, Math.min(1, 0.45 + quest.waveTime * 0.2)) : 0;
      updateStormAudio(0.16 + Math.max(stormCountdown, stormWave) * 0.84, dt);

      if (quest.state === "countdown" || quest.state === "wave") {
        const tribeCellX = Math.floor((tribe.x + tribe.w * 0.5) / CELL);
        const frontCell = Math.max(0, Math.floor(quest.tsunamiX / CELL));
        const distToTribe = Math.max(0, tribeCellX - frontCell);
        const proximityThreat = 1 - Math.min(1, distToTribe / 42);
        const barrierThreat = Math.max(0, 1 - tribeBarrierStrength() / BARRIER_GOAL);
        const timerThreat = quest.state === "countdown" ? Math.max(0, Math.min(1, 1 - quest.timer / 42)) : 0.4;
        const threat = Math.max(proximityThreat * 0.8 + timerThreat * 0.2, barrierThreat * 0.55);
        if (threat > 0.12) playAlertPing(threat);
      }

      // clamp in world
      player.x = Math.max(0, Math.min(player.x, GRID_W * CELL - player.w));
      player.y = Math.max(0, Math.min(player.y, GRID_H * CELL - player.h));
      player.prevWaterSubmerge = waterSubmerge;

      const tool = toolRef.current;
      const stormWind = getStormWind(questRef.current);
      for (let i = tool.falling.length - 1; i >= 0; i--) {
        const f = tool.falling[i];
        f.vy += GRAVITY * dt * 1.15;
        if (f.vy > 980) f.vy = 980;
        if (stormWind.storm > 0.02) f.x += stormWind.gust * dt * (0.35 + stormWind.storm * 0.22);
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
          const landedCell = getCell(cx, cy);
          if (landedCell === 0 || landedCell === 3) {
            if (landedCell === 3) {
              spawnWaterSplash(f.x, f.y, Math.min(1, 0.35 + Math.abs(f.vy) / 780));
            }
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

      const q = questRef.current;
      const now = performance.now();
      const waveVisualIntensity =
        q.state === "wave" ? Math.min(1, 0.45 + q.waveTime * 0.25) : q.state === "countdown" ? Math.max(0, 1 - q.timer / 90) * 0.55 : 0;
      const stormMood = q.state === "countdown" ? Math.max(0, 1 - q.timer / 90) * 0.7 : q.state === "wave" ? Math.min(1, 0.4 + q.waveTime * 0.24) : 0;
      const humidity = Math.min(1, 0.16 + stormMood * 0.62 + waveVisualIntensity * 0.36);
      const gradeLift = 1 - stormMood * 0.18;
      const cinematicExposure = lerp(1.06, 0.9, stormMood * 0.8 + waveVisualIntensity * 0.2);
      const highlightBloom = lerp(0.12, 0.2, clamp01((1 - stormMood) * 0.7 + waveVisualIntensity * 0.5));
      const shake = q.state === "wave" ? Math.min(4, 1.2 + q.waveTime * 0.45) : 0;
      const shakeX = shake > 0 ? Math.sin(now * 0.04) * shake : 0;
      const shakeY = shake > 0 ? Math.cos(now * 0.05) * (shake * 0.6) : 0;

      const lookAheadX = Math.max(-120, Math.min(120, player.vx * 0.28));
      const aimLift = Math.max(0, (canvasEl.height * 0.38 - mouseRef.current.y) * 0.85);
      const cameraTilt = Math.max(-10, Math.min(10, player.vx * 0.016));
      const lensBreath = 1 + Math.sin(now * 0.00045) * 0.002 + stormMood * 0.001;
      const targetCamX = Math.max(0, Math.min(player.x - canvasEl.width * 0.5 + lookAheadX + shakeX, GRID_W * CELL - canvasEl.width));
      const targetCamY = Math.max(0, Math.min(player.y - canvasEl.height * 0.55 - aimLift + shakeY, GRID_H * CELL - canvasEl.height));

      const cam = cameraRef.current;
      const followSpeed = player.onGround ? 11 : 7.5;
      const smooth = 1 - Math.exp(-dt * followSpeed);
      cam.x += (targetCamX - cam.x) * smooth;
      cam.y += (targetCamY - cam.y) * smooth;

      const camX = cam.x;
      const camY = cam.y;

      const topSolidScreenYAt = (screenX: number) => {
        const wx = screenX + camX;
        const cx = Math.max(0, Math.min(GRID_W - 1, Math.floor(wx / CELL)));
        for (let y = 0; y < GRID_H; y++) {
          const c = getCell(cx, y);
          if (c === 1 || c === 2) return y * CELL - camY;
        }
        return canvasEl.height + 30;
      };

      const cameraSwayX = Math.sin(now * 0.0013 + player.vx * 0.004) * (0.7 + waveVisualIntensity * 1.8);
      const cameraSwayY = Math.cos(now * 0.0011 + player.vy * 0.002) * (0.5 + waveVisualIntensity * 1.25);
      const presentationZoom =
        1 +
        Math.sin(now * 0.00062) * 0.0025 +
        Math.min(0.02, Math.abs(player.vx) / 5000) +
        waveVisualIntensity * 0.014 -
        humidity * 0.004;
      const sunsetWarmth = 0.32 + Math.sin(now * 0.00006) * 0.18 + (1 - stormMood) * 0.12;
      const atmosphereDensity = Math.min(1, 0.24 + humidity * 0.52 + waveVisualIntensity * 0.28);
      const microContrast = 0.92 + (1 - humidity) * 0.18;
      const uiCalm = Math.max(0, 1 - waveVisualIntensity * 0.8 - stormMood * 0.55);
      const velocityEnergy = Math.min(1, Math.hypot(player.vx, player.vy) / 460);
      const cinematicFocus = clamp01(0.3 + velocityEnergy * 0.55 + waveVisualIntensity * 0.4);
      const colorBleach = clamp01(0.08 + humidity * 0.16 + waveVisualIntensity * 0.2);
      const filmGrainAmount = 0.012 + humidity * 0.01 + waveVisualIntensity * 0.006;
      const uiGlassAlpha = 0.2 + uiCalm * 0.16;
      const horizonGlow = 0.05 + (1 - stormMood) * 0.08;
      const wetLens = clamp01(humidity * 0.7 + waveVisualIntensity * 0.45);
      const airGlow = clamp01((1 - stormMood) * 0.75 + sunsetWarmth * 0.2);
      const uiHighlight = 0.2 + uiCalm * 0.3;
      const cinematicToe = 0.04 + humidity * 0.045 + waveVisualIntensity * 0.03;
      const chromaPulse = 0.01 + (Math.sin(now * 0.0018) * 0.5 + 0.5) * 0.01;
      const skylineScatter = clamp01(0.14 + (1 - stormMood) * 0.24 + sunsetWarmth * 0.16);
      const sandAlbedoBoost = lerp(0.88, 1.06, clamp01((1 - stormMood) * 0.72 + sunsetWarmth * 0.22));
      const waterLuminanceLift = lerp(0.84, 1.1, clamp01((1 - stormMood) * 0.58 + waveVisualIntensity * 0.35));
      const uiNoiseFade = clamp01(0.82 - waveVisualIntensity * 0.28 - stormMood * 0.22);
      const seaSpray = clamp01(waveVisualIntensity * 0.7 + humidity * 0.35);
      const thermalHazeStrength = clamp01((1 - stormMood) * 0.65 + waveVisualIntensity * 0.25);
      const cinematicGradeStrength = clamp01(0.26 + humidity * 0.3 + waveVisualIntensity * 0.22);
      const volumetricDust = clamp01(0.16 + (1 - stormMood) * 0.42 + velocityEnergy * 0.18);
      const waterClarity = clamp01(0.46 + (1 - humidity) * 0.28 - stormMood * 0.18 + waveVisualIntensity * 0.14);
      const uiSubtlety = clamp01(0.84 + uiCalm * 0.14 - waveVisualIntensity * 0.1);
      const atmosphereTint = {
        r: Math.floor(134 + (1 - stormMood) * 36 + sunsetWarmth * 24),
        g: Math.floor(170 + (1 - stormMood) * 22 + sunsetWarmth * 14),
        b: Math.floor(206 + (1 - stormMood) * 16),
      };

      ctx.save();
      ctx.translate(canvasEl.width * 0.5, canvasEl.height * 0.5);
      ctx.scale(presentationZoom, presentationZoom);
      const cinematicRoll = cameraTilt * 0.0016 + Math.sin(now * 0.0007) * (0.0015 + waveVisualIntensity * 0.002);
      ctx.rotate(cinematicRoll);
      ctx.translate(-canvasEl.width * 0.5 + cameraSwayX, -canvasEl.height * 0.5 + cameraSwayY);

      // cinematic lighting basis (visual only)
      const sunArc = now * 0.00012;
      const lightDirX = Math.cos(sunArc * 2.3 + 0.45);
      const lightDirY = Math.sin(sunArc * 1.9 + 0.92);
      const ambientLift = 0.72 - stormMood * 0.2;

      // background
      const dayToStorm = Math.min(1, stormMood * 0.9 + waveVisualIntensity * 0.5);
      const heatHueShift = Math.sin(now * 0.00017) * 0.5 + 0.5;
      const skyTop = `rgba(${8 + Math.floor(dayToStorm * 15)}, ${20 + Math.floor(dayToStorm * 13)}, ${50 + Math.floor(dayToStorm * 22)}, 1)`;
      const skyMid = `rgba(${34 + Math.floor(dayToStorm * 12 + sunsetWarmth * 13)}, ${76 + Math.floor(dayToStorm * 9 + sunsetWarmth * 11)}, ${122 + Math.floor(dayToStorm * 14)}, 1)`;
      const skyBottom = `rgba(${66 + Math.floor(dayToStorm * 10 + heatHueShift * 10 + sunsetWarmth * 19)}, ${110 + Math.floor(dayToStorm * 7 + heatHueShift * 8)}, ${124 + Math.floor(dayToStorm * 8)}, 1)`;
      const bg = ctx.createLinearGradient(0, 0, 0, canvasEl.height);
      bg.addColorStop(0, skyTop);
      bg.addColorStop(0.52, skyMid);
      bg.addColorStop(1, skyBottom);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const upperScatter = ctx.createLinearGradient(0, 0, 0, canvasEl.height * 0.45);
      upperScatter.addColorStop(0, `rgba(162, 208, 255, ${0.03 + skylineScatter * 0.08})`);
      upperScatter.addColorStop(1, "rgba(162, 208, 255, 0)");
      ctx.fillStyle = upperScatter;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height * 0.5);

      const exposureWash = ctx.createLinearGradient(0, 0, 0, canvasEl.height);
      exposureWash.addColorStop(0, `rgba(255, 238, 204, ${0.05 * cinematicExposure})`);
      exposureWash.addColorStop(0.6, "rgba(255, 238, 204, 0)");
      exposureWash.addColorStop(1, `rgba(10, 16, 28, ${0.04 + (1 - cinematicExposure) * 0.08})`);
      ctx.fillStyle = exposureWash;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const horizonBand = ctx.createLinearGradient(0, canvasEl.height * 0.28, 0, canvasEl.height * 0.82);
      horizonBand.addColorStop(0, "rgba(255, 224, 172, 0)");
      horizonBand.addColorStop(0.52, `rgba(255, 210, 150, ${horizonGlow})`);
      horizonBand.addColorStop(1, "rgba(255, 198, 132, 0)");
      ctx.fillStyle = horizonBand;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // solar disc + upper-atmosphere cloud wisps
      const sunDiscX = canvasEl.width * 0.2 + Math.sin(now * 0.00018) * 22;
      const sunDiscY = canvasEl.height * 0.14 - stormMood * 10;
      const sunDisc = ctx.createRadialGradient(sunDiscX, sunDiscY, 4, sunDiscX, sunDiscY, 64 + humidity * 34);
      sunDisc.addColorStop(0, `rgba(255, 236, 188, ${0.24 * gradeLift})`);
      sunDisc.addColorStop(0.45, `rgba(255, 206, 144, ${0.12 * gradeLift})`);
      sunDisc.addColorStop(1, "rgba(255, 190, 122, 0)");
      ctx.fillStyle = sunDisc;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height * 0.5);

      const cloudBand = ctx.createLinearGradient(0, 0, 0, canvasEl.height * 0.36);
      cloudBand.addColorStop(0, `rgba(176, 210, 236, ${0.06 - stormMood * 0.025})`);
      cloudBand.addColorStop(1, "rgba(176, 210, 236, 0)");
      ctx.fillStyle = cloudBand;
      for (let i = 0; i < 7; i++) {
        const cx = ((i * 240 + now * (0.03 + i * 0.01) - camX * 0.08) % (canvasEl.width + 380)) - 190;
        const cy = 38 + (i % 3) * 26 + Math.sin(now * 0.0008 + i * 1.6) * 8;
        ctx.beginPath();
        ctx.ellipse(cx, cy, 120 + (i % 2) * 36, 30 + (i % 3) * 8, 0.1, 0, Math.PI * 2);
        ctx.fill();
      }

      // parallax atmosphere (painted dune layers)
      const tSky = now * 0.00008;
      const ridgeA = canvasEl.height * 0.45;
      const ridgeB = canvasEl.height * 0.58;

      ctx.fillStyle = "rgba(56, 102, 142, 0.3)";
      ctx.beginPath();
      ctx.moveTo(-40, canvasEl.height + 20);
      for (let x = -40; x <= canvasEl.width + 40; x += 70) {
        const y = ridgeA + Math.sin((x + camX * 0.14 + tSky * 900) * 0.012) * 14 + Math.cos((x + tSky * 500) * 0.022) * 10;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(canvasEl.width + 40, canvasEl.height + 20);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = "rgba(26, 66, 98, 0.42)";
      ctx.beginPath();
      ctx.moveTo(-40, canvasEl.height + 20);
      for (let x = -40; x <= canvasEl.width + 40; x += 64) {
        const y = ridgeB + Math.sin((x + camX * 0.22 + tSky * 820) * 0.011) * 20 + Math.cos((x + tSky * 620) * 0.017) * 12;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(canvasEl.width + 40, canvasEl.height + 20);
      ctx.closePath();
      ctx.fill();

      // layered atmospheric perspective haze (non-gameplay)
      const lowMist = ctx.createLinearGradient(0, canvasEl.height * 0.3, 0, canvasEl.height);
      lowMist.addColorStop(0, `rgba(158, 198, 218, ${0.02 + humidity * 0.03})`);
      lowMist.addColorStop(0.55, `rgba(108, 152, 184, ${0.05 + humidity * 0.05 + waveVisualIntensity * 0.03})`);
      lowMist.addColorStop(1, `rgba(34, 56, 84, ${0.1 + humidity * 0.08 + stormMood * 0.05})`);
      ctx.fillStyle = lowMist;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const volumetricVeil = ctx.createRadialGradient(
        canvasEl.width * 0.56,
        canvasEl.height * 0.48,
        Math.min(canvasEl.width, canvasEl.height) * 0.12,
        canvasEl.width * 0.56,
        canvasEl.height * 0.48,
        Math.max(canvasEl.width, canvasEl.height) * 0.92,
      );
      volumetricVeil.addColorStop(0, `rgba(${atmosphereTint.r}, ${atmosphereTint.g}, ${atmosphereTint.b}, ${0.028 + volumetricDust * 0.045})`);
      volumetricVeil.addColorStop(0.55, `rgba(${atmosphereTint.r - 22}, ${atmosphereTint.g - 18}, ${atmosphereTint.b - 12}, ${0.012 + volumetricDust * 0.025})`);
      volumetricVeil.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = volumetricVeil;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      ctx.fillStyle = `rgba(236, 206, 154, ${0.012 + (1 - stormMood) * 0.02})`;
      for (let y = canvasEl.height * 0.22; y < canvasEl.height * 0.75; y += 18) {
        const drift = Math.sin(now * 0.0011 + y * 0.09) * (1.5 + humidity * 2.3);
        ctx.fillRect(drift, y, canvasEl.width, 1);
      }

      // dry-heat shimmer ribbons near horizon + near-ground mirage band
      ctx.fillStyle = `rgba(255, 222, 174, ${0.008 + thermalHazeStrength * 0.024})`;
      for (let y = canvasEl.height * 0.42; y < canvasEl.height * 0.94; y += 22) {
        const warp = Math.sin(now * 0.0013 + y * 0.065) * (1.3 + thermalHazeStrength * 3.4);
        ctx.fillRect(warp, y, canvasEl.width, 1);
      }
      const mirageBand = ctx.createLinearGradient(0, canvasEl.height * 0.62, 0, canvasEl.height);
      mirageBand.addColorStop(0, "rgba(255, 234, 194, 0)");
      mirageBand.addColorStop(0.5, `rgba(255, 216, 158, ${0.018 + thermalHazeStrength * 0.03})`);
      mirageBand.addColorStop(1, "rgba(255, 208, 148, 0)");
      ctx.fillStyle = mirageBand;
      ctx.fillRect(0, canvasEl.height * 0.55, canvasEl.width, canvasEl.height * 0.45);

      // camera lens drift (visual only)
      const lensDriftX = Math.sin(now * 0.0006) * 1.2 + cameraTilt * 0.18;
      const lensDriftY = Math.cos(now * 0.0005) * 0.8;

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
          const depthFromHorizon = Math.max(0, Math.min(1, (sy / Math.max(1, canvasEl.height)) * 0.9 + 0.1));

          if (c === 1) {
            const n = hash2(x, y);
            const topAir = getCell(x, y - 1) === 0;
            const leftAir = getCell(x - 1, y) === 0;
            const rightAir = getCell(x + 1, y) === 0;
            const bottomAir = getCell(x, y + 1) === 0;

            const base = 90 + Math.floor(n * 24);
            const duneWave = Math.sin((x + y * 0.35) * 0.65 + now * 0.0014) * 0.5 + 0.5;
            const duneBand = Math.sin(y * 0.9 + x * 0.18 + now * 0.0008) * 0.5 + 0.5;
            const coolShadow = Math.floor(8 + (1 - duneBand) * 10);
            const warmSand = Math.floor(18 + sunsetWarmth * 22);
            const mineralTint = Math.floor((hash2(x * 7 + 5, y * 7 + 13) - 0.5) * 10);
            ctx.fillStyle = `rgb(${Math.floor((base + 30 + Math.floor(duneWave * 6) + warmSand + mineralTint) * microContrast * sandAlbedoBoost)}, ${Math.floor((base + 12 + Math.floor(duneWave * 4) + warmSand * 0.55 + mineralTint * 0.5) * microContrast * sandAlbedoBoost)}, ${Math.floor((base - 20 - coolShadow + mineralTint * 0.3) * microContrast * (0.94 + (sandAlbedoBoost - 1) * 0.5))})`;
            ctx.fillRect(sx, sy, CELL, CELL);

            const windSheen = Math.sin(now * 0.0018 + x * 0.92 - y * 0.34) * 0.5 + 0.5;
            const microSlope = Math.sin((x * 1.8 + y * 0.7) * 0.26 + now * 0.0013) * 0.5 + 0.5;
            const roughness = hash2(x * 5 + 3, y * 5 + 11);
            const slopeMask = clamp01(0.3 + (topAir ? 0.36 : 0) + (leftAir ? 0.14 : 0) + (rightAir ? 0.08 : 0));
            ctx.fillStyle = `rgba(255, 228, 170, ${0.035 + windSheen * 0.045 + microSlope * 0.025})`;
            ctx.fillRect(sx + 1, sy + 1, CELL - 2, 1);
            if (roughness > 0.45) {
              ctx.fillStyle = `rgba(72, 48, 28, ${0.035 + (roughness - 0.45) * 0.11})`;
              ctx.fillRect(sx + 1, sy + CELL - 3, CELL - 2, 1);
            }

            const grainHi = hash2(x * 2 + Math.floor(now * 0.0009), y * 2 + 17);
            if (grainHi > 0.57) {
              ctx.fillStyle = `rgba(255, 232, 174, ${0.08 + (grainHi - 0.57) * 0.2})`;
              ctx.fillRect(sx + 1, sy + 1, CELL - 2, 1);
            }

            const warmLight = ctx.createLinearGradient(sx, sy, sx + CELL, sy + CELL);
            warmLight.addColorStop(0, `rgba(248, 220, 164, ${0.12 + sunsetWarmth * 0.11})`);
            warmLight.addColorStop(0.6, "rgba(190, 138, 74, 0.08)");
            warmLight.addColorStop(1, "rgba(60, 40, 22, 0.2)");
            ctx.fillStyle = warmLight;
            ctx.fillRect(sx, sy, CELL, CELL);

            const crestSpec = Math.sin(now * 0.0015 + x * 1.2 - y * 0.45) * 0.5 + 0.5;
            if (slopeMask > 0.32 && crestSpec > 0.42) {
              ctx.fillStyle = `rgba(255, 236, 186, ${0.03 + crestSpec * 0.08 + airGlow * 0.04})`;
              ctx.fillRect(sx + 1, sy + 1, CELL - 2, 2);
            }

            const duneShadow = ctx.createLinearGradient(sx, sy, sx, sy + CELL);
            duneShadow.addColorStop(0, "rgba(255, 230, 172, 0)");
            duneShadow.addColorStop(1, `rgba(46, 30, 16, ${0.14 + atmosphereDensity * 0.07})`);
            ctx.fillStyle = duneShadow;
            ctx.fillRect(sx, sy, CELL, CELL);

            const anisotropic = Math.sin(now * 0.0016 + x * 1.4 + y * 0.22) * 0.5 + 0.5;
            if (anisotropic > 0.46) {
              ctx.fillStyle = `rgba(255, 228, 176, ${0.03 + anisotropic * 0.06 + airGlow * 0.04})`;
              ctx.fillRect(sx + 2, sy + 2 + ((x + y) % 2), CELL - 4, 1);
            }

            // subsurface-ish warm scatter near lit top edges
            if (topAir) {
              const sss = ctx.createLinearGradient(sx, sy, sx, sy + CELL);
              sss.addColorStop(0, "rgba(255, 226, 162, 0.18)");
              sss.addColorStop(0.45, "rgba(255, 202, 132, 0.07)");
              sss.addColorStop(1, "rgba(0,0,0,0)");
              ctx.fillStyle = sss;
              ctx.fillRect(sx, sy, CELL, CELL);
            }

            const ao = (topAir ? 0 : 0.55) + (leftAir ? 0 : 0.35) + (rightAir ? 0 : 0.25) + (bottomAir ? 0 : 0.4);
            if (ao > 0.2) {
              ctx.fillStyle = `rgba(34, 22, 10, ${Math.min(0.22, ao * 0.08)})`;
              ctx.fillRect(sx, sy, CELL, CELL);
            }

            const nx = (leftAir ? -1 : 0) + (rightAir ? 1 : 0);
            const ny = (topAir ? -1 : 0) + (bottomAir ? 1 : 0);
            const nLen = Math.max(0.001, Math.hypot(nx, ny));
            const lambert = ((nx / nLen) * lightDirX + (ny / nLen) * lightDirY) * 0.5 + 0.5;
            const lightAmt = lambert * 0.15 + ambientLift * 0.07;
            if (lightAmt > 0.02) {
              ctx.fillStyle = `rgba(255, 226, 162, ${Math.min(0.2, lightAmt)})`;
              ctx.fillRect(sx, sy, CELL, CELL);
            }

            ctx.fillStyle = "rgba(234, 196, 134, 0.24)";
            if (hash2(x + 11, y + 7) > 0.35) ctx.fillRect(sx + 2, sy + 2, 2, 2);
            if (hash2(x + 17, y + 3) > 0.45) ctx.fillRect(sx + 7, sy + 3, 2, 2);
            if (hash2(x + 5, y + 19) > 0.4) ctx.fillRect(sx + 4, sy + 8, 2, 2);
            if (hash2(x + 13, y + 31) > 0.52) ctx.fillRect(sx + 9, sy + 5, 1, 1);

            ctx.fillStyle = "rgba(58, 40, 22, 0.24)";
            if (hash2(x + 23, y + 29) > 0.5) ctx.fillRect(sx + 9, sy + 7, 2, 2);
            if (hash2(x + 2, y + 37) > 0.58) ctx.fillRect(sx + 5, sy + 10, 1, 1);

            // fine dune ripples
            const rippleShift = Math.sin(now * 0.0021 + x * 0.7) * 0.8;
            ctx.fillStyle = "rgba(250, 226, 170, 0.09)";
            ctx.fillRect(sx + 1, sy + 3 + rippleShift, CELL - 2, 1);
            ctx.fillStyle = "rgba(82, 54, 30, 0.12)";
            ctx.fillRect(sx + 2, sy + 7 + rippleShift * 0.6, CELL - 4, 1);

            const sparkle = hash2(x * 11 + Math.floor(now * 0.0017), y * 13 + 9);
            if (topAir && sparkle > 0.82 - (1 - stormMood) * 0.14) {
              ctx.fillStyle = `rgba(255, 244, 210, ${0.08 + (sparkle - 0.82) * 0.45 + airGlow * 0.06})`;
              const glintX = sx + 1 + ((sparkle * 10.5) % (CELL - 2));
              const glintY = sy + 1 + ((sparkle * 6.3) % 2);
              ctx.fillRect(glintX, glintY, 1, 1);
              if (sparkle > 0.93) ctx.fillRect(glintX + 1, glintY, 1, 1);
            }

            if (topAir) {
              ctx.fillStyle = "rgba(248, 224, 168, 0.32)";
              ctx.fillRect(sx, sy, CELL, 2);
            }
            if (bottomAir) {
              ctx.fillStyle = "rgba(44, 28, 16, 0.34)";
              ctx.fillRect(sx, sy + CELL - 2, CELL, 2);
            }
            if (leftAir) {
              ctx.fillStyle = "rgba(235, 198, 136, 0.18)";
              ctx.fillRect(sx, sy, 2, CELL);
            }
            if (rightAir) {
              ctx.fillStyle = "rgba(40, 26, 14, 0.2)";
              ctx.fillRect(sx + CELL - 2, sy, 2, CELL);
            }

            const contourLight = Math.max(0, lightDirX * (leftAir ? -1 : 0) + lightDirY * (topAir ? -1 : 0));
            if (contourLight > 0.05) {
              ctx.fillStyle = `rgba(255, 232, 178, ${0.05 + contourLight * 0.14})`;
              ctx.fillRect(sx + 1, sy + 1, CELL - 2, 1);
            }

            const cavityShadow = smoothstep(0, 1, (topAir ? 0 : 0.5) + (leftAir ? 0 : 0.35) + (rightAir ? 0 : 0.35));
            if (cavityShadow > 0.15) {
              ctx.fillStyle = `rgba(26, 16, 9, ${0.05 + cavityShadow * 0.1})`;
              ctx.fillRect(sx + 1, sy + 1, CELL - 2, CELL - 2);
            }

            const nearWater = getCell(x + 1, y) === 3 || getCell(x - 1, y) === 3 || getCell(x, y + 1) === 3 || getCell(x, y - 1) === 3;
            if (nearWater) {
              const damp = ctx.createLinearGradient(sx, sy, sx, sy + CELL);
              damp.addColorStop(0, "rgba(88, 112, 128, 0.08)");
              damp.addColorStop(1, "rgba(34, 48, 60, 0.18)");
              ctx.fillStyle = damp;
              ctx.fillRect(sx, sy, CELL, CELL);

              const wetSheen = ctx.createLinearGradient(sx, sy, sx + CELL, sy + CELL);
              wetSheen.addColorStop(0, "rgba(192, 222, 244, 0.08)");
              wetSheen.addColorStop(1, "rgba(54, 86, 118, 0.12)");
              ctx.fillStyle = wetSheen;
              ctx.fillRect(sx + 1, sy + 1, CELL - 2, CELL - 2);

              if (topAir) {
                ctx.fillStyle = "rgba(214, 238, 248, 0.14)";
                ctx.fillRect(sx + 1, sy, CELL - 2, 1);
              }

              const capillary = ctx.createLinearGradient(sx, sy, sx + CELL, sy + CELL);
              capillary.addColorStop(0, "rgba(162, 210, 234, 0.06)");
              capillary.addColorStop(1, "rgba(38, 62, 84, 0.2)");
              ctx.fillStyle = capillary;
              ctx.fillRect(sx, sy + CELL - 3, CELL, 3);
            }
          } else if (c === 3) {
            const t = performance.now() * 0.003;
            const wn = hash2(x + Math.floor(t * 11), y + Math.floor(t * 7));
            const topAir = getCell(x, y - 1) === 0;
            const leftAir = getCell(x - 1, y) === 0;
            const rightAir = getCell(x + 1, y) === 0;
            const belowWater = getCell(x, y + 1) === 3;
            const depthBoost = belowWater ? 0.14 : 0;

            let localDepth = 0;
            for (let d = 1; d <= 6; d++) {
              if (getCell(x, y + d) === 3) localDepth++;
              else break;
            }

            const deep = 122 + Math.floor(wn * 24);
            const wavelet = Math.sin(now * 0.003 + x * 0.7 - y * 0.28) * 0.5 + 0.5;
            const depthTint = localDepth * 5;
            const cyanLift = Math.floor((1 - stormMood) * 12 + sunsetWarmth * 6);
            const coastalGreen = Math.floor(6 + (1 - stormMood) * 8 + Math.max(0, 2 - localDepth) * 2);
            ctx.fillStyle = `rgba(${22 + Math.floor(wn * 16)}, ${Math.floor((deep - Math.floor(depthBoost * 70) - depthTint + cyanLift + coastalGreen) * waterLuminanceLift)}, ${Math.floor((228 + Math.floor(wn * 26) - Math.floor(localDepth * 3)) * (0.94 + (waterLuminanceLift - 1) * 0.8))}, ${0.76 + wavelet * 0.09 + (waterLuminanceLift - 0.84) * 0.14 + waterClarity * 0.08})`;
            ctx.fillRect(sx, sy, CELL, CELL);

            const sedimentMix =
              (getCell(x + 1, y) === 1 ? 1 : 0) +
              (getCell(x - 1, y) === 1 ? 1 : 0) +
              (getCell(x, y + 1) === 1 ? 1 : 0) +
              (getCell(x, y - 1) === 1 ? 1 : 0);
            if (sedimentMix > 0) {
              const turbidity = Math.min(0.18, sedimentMix * 0.045);
              const sediment = ctx.createLinearGradient(sx, sy, sx, sy + CELL);
              sediment.addColorStop(0, `rgba(168, 198, 212, ${turbidity * 0.6})`);
              sediment.addColorStop(1, `rgba(122, 96, 70, ${turbidity})`);
              ctx.fillStyle = sediment;
              ctx.fillRect(sx, sy, CELL, CELL);
            }

            const refractionBand = ctx.createLinearGradient(sx, sy, sx + CELL, sy);
            refractionBand.addColorStop(0, "rgba(190, 238, 255, 0.06)");
            refractionBand.addColorStop(0.5, `rgba(150, 214, 255, ${0.04 + wavelet * 0.08})`);
            refractionBand.addColorStop(1, "rgba(28, 86, 158, 0.08)");
            ctx.fillStyle = refractionBand;
            ctx.fillRect(sx, sy, CELL, CELL);

            const shallow = Math.max(0, 3 - localDepth) / 3;
            if (shallow > 0.05) {
              const shoreTint = ctx.createLinearGradient(sx, sy, sx, sy + CELL);
              shoreTint.addColorStop(0, `rgba(196, 238, 255, ${0.04 + shallow * 0.08})`);
              shoreTint.addColorStop(1, `rgba(88, 166, 214, ${0.05 + shallow * 0.08})`);
              ctx.fillStyle = shoreTint;
              ctx.fillRect(sx, sy, CELL, CELL);
            }

            const inner = ctx.createLinearGradient(sx, sy, sx + CELL, sy + CELL);
            inner.addColorStop(0, "rgba(205,242,255,0.2)");
            inner.addColorStop(0.45, "rgba(64,152,225,0.1)");
            inner.addColorStop(1, "rgba(8,60,132,0.24)");
            ctx.fillStyle = inner;
            ctx.fillRect(sx, sy, CELL, CELL);

            const streak = Math.sin(t * 1.4 + x * 0.55 - y * 0.22) * 0.5 + 0.5;
            if (streak > 0.66) {
              ctx.fillStyle = `rgba(230, 248, 255, ${0.08 + streak * 0.1})`;
              ctx.fillRect(sx + 1, sy + 2 + (streak % 1), CELL - 3, 1);
            }

            const fresnel = (topAir ? 0.22 : 0.08) + (leftAir || rightAir ? 0.07 : 0);
            if (fresnel > 0.06) {
              const edgeSheen = ctx.createLinearGradient(sx, sy, sx, sy + CELL);
              edgeSheen.addColorStop(0, `rgba(244,252,255,${fresnel + waveVisualIntensity * 0.12})`);
              edgeSheen.addColorStop(1, "rgba(170,220,255,0)");
              ctx.fillStyle = edgeSheen;
              ctx.fillRect(sx, sy, CELL, CELL);
            }

            const depthShade = belowWater ? 0.18 : 0.08;
            const waterBody = ctx.createLinearGradient(sx, sy, sx, sy + CELL);
            waterBody.addColorStop(0, "rgba(148, 222, 255, 0.07)");
            waterBody.addColorStop(1, `rgba(8, 32, 86, ${depthShade + localDepth * 0.018})`);
            ctx.fillStyle = waterBody;
            ctx.fillRect(sx, sy, CELL, CELL);

            const subsurface = ctx.createLinearGradient(sx, sy, sx, sy + CELL);
            subsurface.addColorStop(0, `rgba(214, 248, 255, ${0.04 + (topAir ? 0.07 : 0.02)})`);
            subsurface.addColorStop(1, `rgba(26, 92, 170, ${0.04 + localDepth * 0.012})`);
            ctx.fillStyle = subsurface;
            ctx.fillRect(sx, sy, CELL, CELL);

            const lateralScatter = ctx.createLinearGradient(sx, sy, sx + CELL, sy + CELL);
            lateralScatter.addColorStop(0, `rgba(224, 248, 255, ${0.05 + wavelet * 0.06})`);
            lateralScatter.addColorStop(1, "rgba(28, 88, 152, 0)");
            ctx.fillStyle = lateralScatter;
            ctx.fillRect(sx, sy, CELL, CELL);

            const forwardScatter = ctx.createLinearGradient(sx, sy, sx, sy + CELL);
            forwardScatter.addColorStop(0, `rgba(210, 246, 255, ${0.03 + airGlow * 0.05 + (topAir ? 0.06 : 0.02)})`);
            forwardScatter.addColorStop(1, `rgba(20, 74, 132, ${0.05 + localDepth * 0.015})`);
            ctx.fillStyle = forwardScatter;
            ctx.fillRect(sx + 1, sy + 1, CELL - 2, CELL - 2);

            const screenReflect = Math.sin(now * 0.0025 + (sx + sy) * 0.03) * 0.5 + 0.5;
            if (screenReflect > 0.58) {
              ctx.fillStyle = `rgba(238, 250, 255, ${0.03 + screenReflect * (0.08 + waveVisualIntensity * 0.05)})`;
              ctx.fillRect(sx + 1, sy + 1 + ((x + y) % 2), CELL - 2, 1);
            }

            if (topAir) {
              const foamBase = 0.54 + waveVisualIntensity * 0.34;
              ctx.fillStyle = `rgba(236,252,255,${foamBase})`;
              ctx.fillRect(sx, sy, CELL, 2);
              ctx.fillStyle = `rgba(210,244,255,${0.2 + waveVisualIntensity * 0.14})`;
              ctx.fillRect(sx, sy + 2, CELL, 1);

              const tFoam = performance.now() * 0.008;
              const crest = Math.sin(tFoam + x * 0.75 + y * 0.18) * (0.7 + waveVisualIntensity * 0.6);
              const bubbleChance = hash2(x + Math.floor(tFoam * 3), y + 41);
              if (bubbleChance > 0.52 - waveVisualIntensity * 0.2) {
                const bubbleX = sx + 2 + ((bubbleChance * 7.5 + tFoam * 1.6) % (CELL - 4));
                const bubbleY = sy + 1 + crest * 0.35;
                ctx.fillStyle = `rgba(244,254,255,${0.22 + waveVisualIntensity * 0.28})`;
                ctx.fillRect(bubbleX, bubbleY, 2, 1);
              }

              if (waveVisualIntensity > 0.08) {
                const shimmer = 0.22 + waveVisualIntensity * 0.34;
                ctx.fillStyle = `rgba(250,255,255,${shimmer})`;
                const ridgeY = sy + 1 + crest * 0.25;
                ctx.fillRect(sx + 1, ridgeY, CELL - 2, 1);
              }

              const crestGlow = ctx.createLinearGradient(sx, sy - 2, sx, sy + CELL);
              crestGlow.addColorStop(0, `rgba(240, 252, 255, ${0.08 + waveVisualIntensity * 0.1})`);
              crestGlow.addColorStop(0.2, `rgba(164, 226, 255, ${0.05 + humidity * 0.04})`);
              crestGlow.addColorStop(1, "rgba(0,0,0,0)");
              ctx.fillStyle = crestGlow;
              ctx.fillRect(sx, sy - 1, CELL, CELL + 1);

              const skyReflect = ctx.createLinearGradient(sx, sy, sx, sy + CELL);
              skyReflect.addColorStop(0, `rgba(236, 246, 255, ${0.04 + (1 - stormMood) * 0.06})`);
              skyReflect.addColorStop(0.55, "rgba(130, 194, 245, 0.03)");
              skyReflect.addColorStop(1, "rgba(10, 42, 84, 0)");
              ctx.fillStyle = skyReflect;
              ctx.fillRect(sx, sy, CELL, CELL);
            }

            const caustic = hash2(x * 3 + Math.floor(t * 17), y * 5 + Math.floor(t * 12));
            if (caustic > 0.73) {
              ctx.fillStyle = "rgba(228, 250, 255, 0.18)";
              ctx.fillRect(sx + 1, sy + 4, CELL - 4, 1);
            }

            const refract = Math.sin(t * 1.7 + x * 0.9 + y * 0.3) * 0.5 + 0.5;
            if (refract > 0.62) {
              ctx.fillStyle = `rgba(236, 252, 255, ${0.08 + refract * 0.08})`;
              ctx.fillRect(sx + 1, sy + 6, CELL - 3, 1);
            }

            if (localDepth >= 2) {
              const depthCaustic = Math.sin(t * 2.2 + x * 0.44 + y * 0.72) * 0.5 + 0.5;
              if (depthCaustic > 0.7) {
                ctx.fillStyle = `rgba(176, 236, 255, ${0.06 + depthCaustic * 0.1})`;
                ctx.fillRect(sx + 1, sy + CELL - 3, CELL - 2, 1);
              }
            }

            if (leftAir) {
              ctx.fillStyle = "rgba(198,236,255,0.16)";
              ctx.fillRect(sx, sy, 1, CELL);
            }
            if (rightAir) {
              ctx.fillStyle = "rgba(14,74,146,0.2)";
              ctx.fillRect(sx + CELL - 1, sy, 1, CELL);
            }

            if (hash2(x + 19, y + Math.floor(t * 13)) > 0.62) {
              ctx.fillStyle = "rgba(240,252,255,0.34)";
              ctx.fillRect(sx + 2, sy + 3, 2, 1);
            }
          } else {
            const n = hash2(x, y);
            const topAir = getCell(x, y - 1) === 0;
            const leftAir = getCell(x - 1, y) === 0;
            const rightAir = getCell(x + 1, y) === 0;
            const rock = 84 + Math.floor(n * 24);
            ctx.fillStyle = `rgb(${rock}, ${rock + 4}, ${rock + 10})`;
            ctx.fillRect(sx, sy, CELL, CELL);

            const rockGrad = ctx.createLinearGradient(sx, sy, sx + CELL, sy + CELL);
            rockGrad.addColorStop(0, "rgba(176, 186, 205, 0.12)");
            rockGrad.addColorStop(1, "rgba(18, 22, 30, 0.22)");
            ctx.fillStyle = rockGrad;
            ctx.fillRect(sx, sy, CELL, CELL);

            const rockNx = (leftAir ? -1 : 0) + (rightAir ? 1 : 0);
            const rockNy = (topAir ? -1 : 0) + (getCell(x, y + 1) === 0 ? 1 : 0);
            const rockLen = Math.max(0.001, Math.hypot(rockNx, rockNy));
            const rockLambert = ((rockNx / rockLen) * lightDirX + (rockNy / rockLen) * lightDirY) * 0.5 + 0.5;
            if (rockLambert > 0.2) {
              ctx.fillStyle = `rgba(206, 214, 232, ${0.03 + rockLambert * 0.08})`;
              ctx.fillRect(sx, sy, CELL, CELL);
            }

            if (hash2(x + 7, y + 13) > 0.5) {
              ctx.fillStyle = "rgba(132, 142, 164, 0.25)";
              ctx.fillRect(sx + 2, sy + 2, 3, 1);
            }
            if (hash2(x + 29, y + 3) > 0.55) {
              ctx.fillStyle = "rgba(42, 46, 56, 0.32)";
              ctx.fillRect(sx + 6, sy + 8, 4, 1);
            }
            if (topAir) {
              ctx.fillStyle = "rgba(198, 212, 236, 0.22)";
              ctx.fillRect(sx, sy, CELL, 1);
            }
            if (leftAir) {
              ctx.fillStyle = "rgba(166, 182, 210, 0.16)";
              ctx.fillRect(sx, sy, 1, CELL);
            }
            if (rightAir) {
              ctx.fillStyle = "rgba(20, 24, 34, 0.26)";
              ctx.fillRect(sx + CELL - 1, sy, 1, CELL);
            }
          }

          const depthFog = depthFromHorizon * (0.03 + atmosphereDensity * 0.06);
          if (depthFog > 0.01) {
            ctx.fillStyle = `rgba(132, 170, 210, ${depthFog})`;
            ctx.fillRect(sx, sy, CELL, CELL);
          }
        }
      }

      // broad water reflection sweep (visual-only screen-space pass)
      const reflectionSweep = ctx.createLinearGradient(0, canvasEl.height * 0.24, 0, canvasEl.height * 0.9);
      reflectionSweep.addColorStop(0, `rgba(214, 238, 255, ${0.015 + waterClarity * 0.03})`);
      reflectionSweep.addColorStop(0.6, `rgba(132, 186, 230, ${0.012 + waterClarity * 0.02})`);
      reflectionSweep.addColorStop(1, "rgba(38, 74, 128, 0)");
      ctx.fillStyle = reflectionSweep;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // world-space depth fog + heat shimmer
      const horizonFog = ctx.createLinearGradient(0, canvasEl.height * 0.18, 0, canvasEl.height);
      horizonFog.addColorStop(0, `rgba(180, 204, 224, ${0.03 + stormMood * 0.04})`);
      horizonFog.addColorStop(1, "rgba(20, 24, 36, 0.14)");
      ctx.fillStyle = horizonFog;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const shimmerAlpha = (0.016 + Math.sin(now * 0.0017) * 0.006) * (1 - humidity * 0.3);
      ctx.fillStyle = `rgba(255, 210, 152, ${Math.max(0.007, shimmerAlpha)})`;
      for (let y = 0; y < canvasEl.height; y += 28) {
        const bandOffset = Math.sin(now * 0.001 + y * 0.08) * (1.8 + waveVisualIntensity * 1.4);
        ctx.fillRect(bandOffset, y, canvasEl.width, 1);
      }

      // directional sunlight + atmospheric shafts
      const sunX = canvasEl.width * 0.18 + Math.sin(now * 0.00012) * 40 * lensBreath + lensDriftX * 8;
      const sunY = canvasEl.height * 0.12 + lensDriftY * 6 - stormMood * 6;
      const sunGlow = ctx.createRadialGradient(sunX, sunY, 8, sunX, sunY, canvasEl.height * 0.62);
      sunGlow.addColorStop(0, "rgba(255, 227, 171, 0.24)");
      sunGlow.addColorStop(0.45, "rgba(255, 208, 138, 0.08)");
      sunGlow.addColorStop(1, "rgba(255, 200, 120, 0)");
      ctx.fillStyle = sunGlow;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const shaftAlpha = 0.03 + waveVisualIntensity * 0.05;
      for (let i = -1; i < 6; i++) {
        const bx = ((i * 220 - camX * 0.09) % (canvasEl.width + 260)) - 120;
        const shaftW = 220;
        for (let sx = 0; sx < shaftW; sx += 8) {
          const x = bx + sx;
          if (x < -8 || x > canvasEl.width + 8) continue;
          const topY = topSolidScreenYAt(x);
          const localA = shaftAlpha * (0.45 + Math.sin((sx / shaftW) * Math.PI) * 0.55);
          ctx.fillStyle = `rgba(255, 226, 170, ${localA})`;
          ctx.fillRect(x, -20, 8, Math.max(0, topY + 20));
        }
      }

      // dust motes floating through light shafts
      const moteCount = Math.floor(34 + (1 - stormMood) * 26);
      for (let i = 0; i < moteCount; i++) {
        const mx = ((i * 97.3 + now * (0.01 + (i % 7) * 0.002) - camX * 0.03) % (canvasEl.width + 40)) - 20;
        const my = ((i * 61.1 + now * (0.008 + (i % 5) * 0.0015)) % (canvasEl.height + 40)) - 20;
        const twinkle = 0.25 + (Math.sin(now * 0.004 + i * 1.17) * 0.5 + 0.5) * 0.75;
        ctx.fillStyle = `rgba(255, 234, 196, ${0.03 + twinkle * 0.06 * (1 - stormMood * 0.75)})`;
        ctx.beginPath();
        ctx.arc(mx, my, 0.8 + (i % 3) * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }

      // near-lens drifting dust streaks for foreground depth
      const foregroundDust = Math.floor(8 + cinematicFocus * 16);
      ctx.strokeStyle = `rgba(255, 226, 184, ${0.04 + (1 - stormMood) * 0.06})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      for (let i = 0; i < foregroundDust; i++) {
        const fx = ((i * 131.9 + now * (0.026 + (i % 4) * 0.01) - camX * 0.08) % (canvasEl.width + 120)) - 60;
        const fy = ((i * 83.1 + now * (0.015 + (i % 6) * 0.004)) % (canvasEl.height + 80)) - 40;
        const len = 5 + (i % 5) * 1.8 + velocityEnergy * 4;
        const lift = -2 + Math.sin(now * 0.002 + i) * 1.4;
        ctx.moveTo(fx, fy);
        ctx.lineTo(fx + len, fy + lift);
      }
      ctx.stroke();

      const tribe = tribeRef.current;
      const quest = questRef.current;

      // objective beacon + off-screen compass for tribe
      const tribeCenterWX = tribe.x + tribe.w * 0.5;
      const tribeCenterWY = tribe.y + tribe.h * 0.5;
      const tribeScreenX = tribeCenterWX - camX;
      const tribeScreenY = tribeCenterWY - camY;
      const edgePad = 26;
      const offscreen =
        tribeScreenX < edgePad ||
        tribeScreenX > canvasEl.width - edgePad ||
        tribeScreenY < edgePad ||
        tribeScreenY > canvasEl.height - edgePad;
      const distCells = Math.floor(Math.hypot(tribeCenterWX - (player.x + player.w * 0.5), tribeCenterWY - (player.y + player.h * 0.5)) / CELL);

      if (offscreen && (quest.state === "explore" || quest.state === "dialog" || quest.state === "countdown" || quest.state === "wave")) {
        const dxToTribe = tribeScreenX - canvasEl.width * 0.5;
        const dyToTribe = tribeScreenY - canvasEl.height * 0.5;
        const ang = Math.atan2(dyToTribe, dxToTribe);
        const maxRX = canvasEl.width * 0.5 - edgePad;
        const maxRY = canvasEl.height * 0.5 - edgePad;
        const tEdge = 1 / Math.max(Math.abs(Math.cos(ang)) / maxRX, Math.abs(Math.sin(ang)) / maxRY);
        const ix = canvasEl.width * 0.5 + Math.cos(ang) * tEdge;
        const iy = canvasEl.height * 0.5 + Math.sin(ang) * tEdge;

        ctx.save();
        ctx.translate(ix, iy);
        ctx.rotate(ang);
        ctx.fillStyle = "rgba(156, 221, 255, 0.92)";
        ctx.beginPath();
        ctx.moveTo(14, 0);
        ctx.lineTo(-12, -9);
        ctx.lineTo(-12, 9);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        ctx.fillStyle = `rgba(8, 18, 34, ${0.62 + uiCalm * 0.2})`;
        ctx.fillRect(ix - 44, iy + 12, 88, 20);
        ctx.strokeStyle = `rgba(170, 220, 255, ${0.42 + uiCalm * 0.23})`;
        ctx.strokeRect(ix - 44, iy + 12, 88, 20);
        ctx.fillStyle = "#d9f1ff";
        ctx.font = "12px system-ui";
        ctx.fillText(`${distCells}m → tribe`, ix - 36, iy + 26);
      }

      // tribe character (first rescue target)
      const tx = tribe.x - camX;
      const tribeBob = Math.sin(performance.now() * 0.005) * 1.5;
      const ty = tribe.y - camY + tribeBob;

      // soft contact shadows to anchor characters into the terrain
      const tribeShadow = ctx.createRadialGradient(tx + tribe.w * 0.5, ty + tribe.h + 2, 1, tx + tribe.w * 0.5, ty + tribe.h + 2, 14);
      tribeShadow.addColorStop(0, "rgba(6, 10, 18, 0.32)");
      tribeShadow.addColorStop(1, "rgba(6, 10, 18, 0)");
      ctx.fillStyle = tribeShadow;
      ctx.fillRect(tx - 8, ty + tribe.h - 3, tribe.w + 16, 14);

      const beaconPulse = 0.35 + Math.sin(performance.now() * 0.004) * 0.12;
      const beacon = ctx.createLinearGradient(tribeScreenX, 0, tribeScreenX, ty + 8);
      beacon.addColorStop(0, `rgba(154, 228, 255, ${0.16 + beaconPulse * 0.22})`);
      beacon.addColorStop(1, "rgba(154, 228, 255, 0)");
      ctx.fillStyle = beacon;
      ctx.fillRect(tribeScreenX - 14, 0, 28, Math.max(0, ty + 8));

      ctx.fillStyle = "#ffd08a";
      ctx.fillRect(tx + 3, ty, 6, 6);
      ctx.fillStyle = "#8f4f2a";
      ctx.fillRect(tx + 2, ty + 6, 8, 10);
      ctx.fillStyle = "#f4e4d2";
      ctx.fillRect(tx + 4, ty + 8, 4, 2);

      if (quest.state === "countdown" || quest.state === "wave") {
        const panic = quest.state === "wave" ? 1 : Math.min(1, 1 - quest.timer / 90);
        const bubbleW = 36;
        const bubbleH = 20;
        const bubbleX = tx - 12;
        const bubbleY = ty - 28 - panic * 4;
        ctx.fillStyle = `rgba(${Math.floor(180 + panic * 55)}, ${Math.floor(70 + panic * 40)}, ${Math.floor(62 + panic * 20)}, 0.9)`;
        ctx.fillRect(bubbleX, bubbleY, bubbleW, bubbleH);
        ctx.fillStyle = "rgba(250,240,235,0.95)";
        ctx.font = "bold 13px system-ui";
        ctx.fillText(quest.state === "wave" ? "!!" : "!", bubbleX + 13, bubbleY + 14);
      }

      if (quest.state === "explore") {
        ctx.fillStyle = "rgba(20,28,45,0.86)";
        ctx.fillRect(tx - 52, ty - 36, 140, 24);
        ctx.fillStyle = "#d7ecff";
        ctx.font = "13px system-ui";
        ctx.fillText("Tribe ahead → Find and talk", tx - 46, ty - 20);
      }

      if (quest.state === "dialog") {
        const toastW = 290;
        const toastX = Math.max(12, Math.min(tx - 120, canvasEl.width - toastW - 12));
        ctx.fillStyle = "rgba(20,28,45,0.9)";
        ctx.fillRect(toastX, ty - 56, toastW, 40);
        ctx.fillStyle = "#d7ecff";
        ctx.font = "13px system-ui";
        ctx.fillText("Elder: A tsunami is coming! Build us a sand wall!", toastX + 8, ty - 30);
      }

      // removed legacy white wave overlays; keep only block-water visuals

      if (quest.state === "wave") {
        const floodTint = Math.min(0.24, 0.08 + quest.waveTime * 0.012);
        ctx.fillStyle = `rgba(60,132,210,${floodTint})`;
        ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

        const lensDrops = Math.floor(8 + wetLens * 22);
        for (let i = 0; i < lensDrops; i++) {
          const lx = ((i * 149.3 + now * (0.012 + (i % 5) * 0.004)) % (canvasEl.width + 90)) - 45;
          const ly = ((i * 97.7 + now * (0.02 + (i % 4) * 0.007)) % (canvasEl.height + 120)) - 60;
          const r = 7 + (i % 4) * 2.6;
          const drop = ctx.createRadialGradient(lx, ly, 1, lx, ly, r);
          drop.addColorStop(0, `rgba(224, 246, 255, ${0.07 + wetLens * 0.15})`);
          drop.addColorStop(0.55, `rgba(120, 186, 236, ${0.05 + wetLens * 0.1})`);
          drop.addColorStop(1, "rgba(24, 56, 94, 0)");
          ctx.fillStyle = drop;
          ctx.beginPath();
          ctx.arc(lx, ly, r, 0, Math.PI * 2);
          ctx.fill();
        }

        // sea-spray streak layer (visual intensity only)
        const sprayCount = Math.floor(24 + seaSpray * 74);
        ctx.strokeStyle = `rgba(226, 246, 255, ${0.05 + seaSpray * 0.12})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < sprayCount; i++) {
          const sxSpray = ((i * 61.7 + now * (0.06 + seaSpray * 0.11)) % (canvasEl.width + 120)) - 60;
          const sySpray = ((i * 43.3 + now * (0.085 + seaSpray * 0.14)) % (canvasEl.height + 90)) - 45;
          const len = 4 + seaSpray * 8;
          const tilt = -2.5 - seaSpray * 5.5;
          ctx.moveTo(sxSpray, sySpray);
          ctx.lineTo(sxSpray + len, sySpray + tilt);
        }
        ctx.stroke();

        // lensy water refraction pass during impact
        const ripple = 0.6 + Math.sin(now * 0.004) * 0.4;
        ctx.strokeStyle = `rgba(196, 234, 255, ${0.05 + waveVisualIntensity * 0.08})`;
        ctx.lineWidth = 1;
        for (let y = 22; y < canvasEl.height; y += 26) {
          const wobble = Math.sin(y * 0.08 + now * 0.005) * (2 + waveVisualIntensity * 5) * ripple;
          ctx.beginPath();
          ctx.moveTo(wobble, y);
          ctx.lineTo(canvasEl.width + wobble, y);
          ctx.stroke();
        }

        const barH = Math.min(52, 12 + quest.waveTime * 4);
        ctx.fillStyle = "rgba(4, 8, 14, 0.62)";
        ctx.fillRect(0, 0, canvasEl.width, barH);
        ctx.fillRect(0, canvasEl.height - barH, canvasEl.width, barH);
      }

      // incoming-storm readability pass: wind + rain intensifies as tsunami nears/hits
      const stormWind = getStormWind(quest);
      const storm = stormWind.storm;
      if (storm > 0.02) {
        const tStorm = performance.now() * 0.001;
        const cloudAlpha = 0.08 + storm * 0.2;
        const cloud = ctx.createLinearGradient(0, 0, 0, canvasEl.height * 0.52);
        cloud.addColorStop(0, `rgba(12, 25, 44, ${cloudAlpha})`);
        cloud.addColorStop(1, "rgba(12, 25, 44, 0)");
        ctx.fillStyle = cloud;
        ctx.fillRect(0, 0, canvasEl.width, canvasEl.height * 0.56);

        const rainCount = Math.floor(45 + storm * 125);
        const slant = -7 - storm * 8 + stormWind.gust * 0.22;
        ctx.strokeStyle = `rgba(192, 228, 255, ${0.12 + storm * 0.24})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < rainCount; i++) {
          const rx = ((i * 37.17 + tStorm * (220 + storm * 260)) % (canvasEl.width + 90)) - 45;
          const ry = ((i * 61.93 + tStorm * (420 + storm * 520)) % (canvasEl.height + 120)) - 60;
          const len = 7 + storm * 10;
          const topY = topSolidScreenYAt(rx);
          if (ry >= topY - 1) continue;
          const endY = Math.min(ry + len, topY - 1);
          const endX = rx + slant * ((endY - ry) / Math.max(0.001, len));
          ctx.moveTo(rx, ry);
          ctx.lineTo(endX, endY);
        }
        ctx.stroke();

        // gust trails for better storm readability
        const gustAbs = Math.min(1, Math.abs(stormWind.gust) / 90);
        if (gustAbs > 0.12) {
          const gustCount = Math.floor(8 + gustAbs * 16);
          ctx.strokeStyle = `rgba(218, 238, 255, ${0.08 + gustAbs * 0.14})`;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          for (let i = 0; i < gustCount; i++) {
            const gx = ((i * 113.7 + tStorm * (160 + gustAbs * 200)) % (canvasEl.width + 120)) - 60;
            const gy = ((i * 47.3 + tStorm * 130) % (canvasEl.height + 60)) - 30;
            const len = 18 + gustAbs * 22;
            const skew = Math.sign(stormWind.gust || -1) * (12 + gustAbs * 14);
            ctx.moveTo(gx, gy);
            ctx.lineTo(gx + len, gy + skew);
          }
          ctx.stroke();
        }
      }

      // ambient dust haze + cinematic grading
      const bloomLike = ctx.createRadialGradient(
        canvasEl.width * 0.55,
        canvasEl.height * 0.34,
        10,
        canvasEl.width * 0.55,
        canvasEl.height * 0.34,
        Math.max(canvasEl.width, canvasEl.height) * 0.58,
      );
      bloomLike.addColorStop(0, `rgba(255, 224, 170, ${0.05 * gradeLift + waveVisualIntensity * 0.04})`);
      bloomLike.addColorStop(1, "rgba(255, 224, 170, 0)");
      ctx.fillStyle = bloomLike;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

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
      vignette.addColorStop(1, "rgba(0,0,0,0.24)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const focusFalloff = ctx.createRadialGradient(
        canvasEl.width * 0.5,
        canvasEl.height * 0.5,
        Math.min(canvasEl.width, canvasEl.height) * (0.18 + (1 - cinematicFocus) * 0.1),
        canvasEl.width * 0.5,
        canvasEl.height * 0.5,
        Math.max(canvasEl.width, canvasEl.height) * 0.74,
      );
      focusFalloff.addColorStop(0, "rgba(0,0,0,0)");
      focusFalloff.addColorStop(1, `rgba(18, 28, 42, ${0.05 + cinematicFocus * 0.12})`);
      ctx.fillStyle = focusFalloff;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // gentle lens chroma at frame edges
      const chromaEdge = ctx.createRadialGradient(
        canvasEl.width * 0.5,
        canvasEl.height * 0.5,
        Math.min(canvasEl.width, canvasEl.height) * 0.28,
        canvasEl.width * 0.5,
        canvasEl.height * 0.5,
        Math.max(canvasEl.width, canvasEl.height) * 0.7,
      );
      chromaEdge.addColorStop(0, "rgba(0,0,0,0)");
      chromaEdge.addColorStop(0.75, "rgba(96,160,255,0.02)");
      chromaEdge.addColorStop(1, "rgba(255,140,120,0.05)");
      ctx.fillStyle = chromaEdge;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // split-toning grade: warm highlights + cool shadows
      const coolShadow = ctx.createLinearGradient(0, 0, 0, canvasEl.height);
      coolShadow.addColorStop(0, `rgba(28, 50, 96, ${0.035 + humidity * 0.026 + atmosphereDensity * 0.015})`);
      coolShadow.addColorStop(1, `rgba(6, 18, 40, ${0.08 + humidity * 0.05 + atmosphereDensity * 0.045})`);
      ctx.fillStyle = coolShadow;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const warmLift = ctx.createRadialGradient(
        canvasEl.width * 0.36,
        canvasEl.height * 0.28,
        18,
        canvasEl.width * 0.36,
        canvasEl.height * 0.28,
        canvasEl.width * 0.8,
      );
      warmLift.addColorStop(0, "rgba(255, 206, 140, 0.08)");
      warmLift.addColorStop(1, "rgba(255, 188, 120, 0)");
      ctx.fillStyle = warmLift;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const toeCurve = ctx.createLinearGradient(0, 0, 0, canvasEl.height);
      toeCurve.addColorStop(0, `rgba(255, 230, 194, ${cinematicToe * 0.35})`);
      toeCurve.addColorStop(0.6, "rgba(0,0,0,0)");
      toeCurve.addColorStop(1, `rgba(2, 8, 18, ${cinematicToe})`);
      ctx.fillStyle = toeCurve;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // gentle contrast curve pass
      const gradeStrength = 0.05 + stormMood * 0.06;
      const grade = ctx.createLinearGradient(0, 0, 0, canvasEl.height);
      grade.addColorStop(0, `rgba(255, 220, 168, ${gradeStrength * 0.65})`);
      grade.addColorStop(0.55, "rgba(0,0,0,0)");
      grade.addColorStop(1, `rgba(16, 34, 74, ${gradeStrength})`);
      ctx.fillStyle = grade;
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

      // water splash particles (player entries/exits + dirt impacts)
      if (tool.waterFx.length) {
        for (const p of tool.waterFx) {
          const alpha = Math.max(0, Math.min(1, p.life * 3.6));
          ctx.fillStyle = `rgba(210, 241, 255, ${0.14 + alpha * 0.58})`;
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
        ctx.strokeStyle = "rgba(180,220,255,0.45)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(tc.x * CELL - camX, tc.y * CELL - camY, CELL, CELL);
      }

      // player
      const playerWater = playerWaterSubmergeRatio(player.x, player.y, player.w, player.h);
      if (playerWater > 0.02) {
        const px = player.x - camX;
        const py = player.y - camY;
        const wash = ctx.createLinearGradient(px, py, px, py + player.h + 10);
        wash.addColorStop(0, `rgba(150, 220, 255, ${0.08 + playerWater * 0.12})`);
        wash.addColorStop(1, "rgba(60, 150, 240, 0)");
        ctx.fillStyle = wash;
        ctx.fillRect(px - 7, py - 6, player.w + 14, player.h + 14);

        ctx.fillStyle = `rgba(218, 245, 255, ${0.25 + playerWater * 0.3})`;
        const bt = performance.now() * 0.003;
        for (let i = 0; i < 3; i++) {
          const bx = px + 2 + ((i * 3.9 + bt * (0.8 + i * 0.35)) % Math.max(2, player.w - 2));
          const by = py + player.h - ((bt * (10 + i * 4) + i * 5) % (player.h + 6));
          ctx.beginPath();
          ctx.arc(bx, by, 1.2 + i * 0.25, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const playerShadowX = player.x - camX + player.w * 0.5;
      const playerShadowY = player.y - camY + player.h + 1;
      const playerShadow = ctx.createRadialGradient(playerShadowX, playerShadowY, 1, playerShadowX, playerShadowY, 13);
      playerShadow.addColorStop(0, `rgba(6, 12, 20, ${0.26 + playerWater * 0.1})`);
      playerShadow.addColorStop(1, "rgba(6, 12, 20, 0)");
      ctx.fillStyle = playerShadow;
      ctx.fillRect(playerShadowX - 11, playerShadowY - 4, 22, 12);

      ctx.fillStyle = playerWater > 0.12 ? "#bfe4ff" : "#cfe9ff";
      ctx.fillRect(player.x - camX, player.y - camY, player.w, player.h);

      ctx.restore();

      // HUD (auto-compact while actively playing/building)
      const questHud = questRef.current;
      let objective = "Objective: Reach the far-right tribe.";
      if (questHud.state === "dialog") objective = "Objective: Listen to the elder...";
      if (questHud.state === "countdown") objective = `Objective: Build a sand barrier! Tsunami in: ${questHud.timer.toFixed(1)}s`;
      if (questHud.state === "wave") objective = "Objective: Hold the barrier! Tsunami is hitting from the LEFT.";
      if (questHud.state === "success") objective = `Success: ${questHud.resultText}`;
      if (questHud.state === "fail") objective = `Failed: ${questHud.resultText}`;

      const compactHud =
        mouseRef.current.left ||
        mouseRef.current.right ||
        mobileRef.current.moveId !== -1 ||
        questHud.state === "countdown" ||
        questHud.state === "wave";
      const barrierActive = questHud.state === "countdown" || questHud.state === "wave";

      const hudH = compactHud ? 58 : 98;
      const hudW = Math.min(690, canvasEl.width - 32);
      const hudGrad = ctx.createLinearGradient(14, 14, 14, 14 + hudH);
      hudGrad.addColorStop(0, `rgba(12, 24, 40, ${uiGlassAlpha + 0.12})`);
      hudGrad.addColorStop(0.45, `rgba(8, 18, 32, ${uiGlassAlpha + 0.06})`);
      hudGrad.addColorStop(1, `rgba(6, 14, 26, ${uiGlassAlpha + 0.02})`);
      const hudGlow = ctx.createRadialGradient(120, 22, 8, 120, 22, 260);
      hudGlow.addColorStop(0, `rgba(146, 210, 255, ${0.08 + uiHighlight * 0.12})`);
      hudGlow.addColorStop(1, "rgba(146, 210, 255, 0)");
      ctx.fillStyle = "rgba(0,0,0,0.14)";
      ctx.fillRect(18, 18, hudW, hudH);
      ctx.fillStyle = hudGrad;
      ctx.fillRect(14, 14, hudW, hudH);
      ctx.fillStyle = hudGlow;
      ctx.fillRect(14, 14, hudW, hudH);
      ctx.strokeStyle = `rgba(170,210,255,${0.18 + uiSubtlety * 0.1})`;
      ctx.strokeRect(14, 14, hudW, hudH);
      const hudSheen = ctx.createLinearGradient(14, 14, 14 + hudW, 14 + hudH);
      hudSheen.addColorStop(0, "rgba(214, 236, 255, 0.09)");
      hudSheen.addColorStop(0.4, "rgba(214, 236, 255, 0.02)");
      hudSheen.addColorStop(1, "rgba(16, 32, 52, 0.06)");
      ctx.fillStyle = hudSheen;
      ctx.fillRect(14, 14, hudW, hudH);
      ctx.fillStyle = "rgba(220,242,255,0.04)";
      ctx.fillRect(15, 15, hudW - 2, 1);

      // subtle corner brackets for cleaner HUD framing
      ctx.strokeStyle = `rgba(196, 230, 255, ${0.16 + uiSubtlety * 0.16})`;
      ctx.lineWidth = 1;
      const cLen = 10;
      ctx.beginPath();
      ctx.moveTo(16, 16 + cLen);
      ctx.lineTo(16, 16);
      ctx.lineTo(16 + cLen, 16);
      ctx.moveTo(14 + hudW - cLen - 2, 16);
      ctx.lineTo(14 + hudW - 2, 16);
      ctx.lineTo(14 + hudW - 2, 16 + cLen);
      ctx.moveTo(16, 14 + hudH - cLen - 2);
      ctx.lineTo(16, 14 + hudH - 2);
      ctx.lineTo(16 + cLen, 14 + hudH - 2);
      ctx.moveTo(14 + hudW - cLen - 2, 14 + hudH - 2);
      ctx.lineTo(14 + hudW - 2, 14 + hudH - 2);
      ctx.lineTo(14 + hudW - 2, 14 + hudH - cLen - 2);
      ctx.stroke();

      const hudInnerFog = ctx.createLinearGradient(14, 14, 14, 14 + hudH);
      hudInnerFog.addColorStop(0, `rgba(184, 220, 255, ${0.04 + uiCalm * 0.04})`);
      hudInnerFog.addColorStop(1, "rgba(42, 72, 108, 0)");
      ctx.fillStyle = hudInnerFog;
      ctx.fillRect(15, 15, hudW - 2, hudH - 2);

      const hudWind = getStormWind(questHud);
      const windLevel = Math.min(1, Math.abs(hudWind.gust) / 88);
      const windDir = hudWind.gust >= 0 ? "→" : "←";

      ctx.fillStyle = "rgba(0,0,0,0.24)";
      ctx.fillRect(28, 44, Math.min(hudW - 44, 360), 1);

      ctx.shadowColor = "rgba(6, 12, 24, 0.45)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1;
      ctx.fillStyle = "#d8eeff";
      ctx.font = "600 16px system-ui";
      ctx.fillText(`2D Dust ${GAME_VERSION} · Level 1`, 28, 38);
      ctx.font = "13px system-ui";
      ctx.fillStyle = `rgba(214, 234, 252, ${(0.82 + uiNoiseFade * 0.1) * uiSubtlety})`;
      ctx.fillText(`Dirt: ${dirtRef.current}/${MAX_DIRT}`, 28, 58);
      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      const dirtBarW = Math.min(180, hudW - 280);
      const dirtFill = Math.max(0, Math.min(1, dirtRef.current / MAX_DIRT));
      const dirtBarX = 28;
      const dirtBarY = compactHud ? 66 : 68;
      ctx.fillStyle = "rgba(14,22,35,0.7)";
      ctx.fillRect(dirtBarX, dirtBarY, dirtBarW, 8);
      const dirtGrad = ctx.createLinearGradient(dirtBarX, dirtBarY, dirtBarX + dirtBarW, dirtBarY);
      dirtGrad.addColorStop(0, "rgba(212, 166, 102, 0.9)");
      dirtGrad.addColorStop(1, "rgba(248, 210, 138, 0.95)");
      ctx.fillStyle = dirtGrad;
      ctx.fillRect(dirtBarX, dirtBarY, dirtBarW * dirtFill, 8);
      ctx.strokeStyle = "rgba(214,230,255,0.32)";
      ctx.strokeRect(dirtBarX, dirtBarY, dirtBarW, 8);
      if (hudWind.storm > 0.02) {
        const windText = `Wind ${windDir} ${Math.round(windLevel * 100)}%`;
        ctx.fillStyle = windLevel > 0.6 ? "#ffd8bf" : "#cde9ff";
        ctx.fillText(windText, 222, compactHud ? 74 : 76);
      }

      if (barrierActive || questHud.state === "success" || questHud.state === "fail") {
        const chipW = 196;
        const chipH = 24;
        const chipX = 14 + hudW - chipW - 16;
        const chipY = 34;
        const pulse = 0.45 + Math.sin(performance.now() * 0.006) * 0.25;

        const chipGrad = ctx.createLinearGradient(chipX, chipY, chipX, chipY + chipH);
        chipGrad.addColorStop(0, "rgba(18, 38, 62, 0.72)");
        chipGrad.addColorStop(1, "rgba(10, 24, 42, 0.72)");
        ctx.fillStyle = chipGrad;
        ctx.fillRect(chipX, chipY, chipW, chipH);
        ctx.strokeStyle = `rgba(178, 220, 255, ${0.36 + pulse * 0.24})`;
        ctx.strokeRect(chipX, chipY, chipW, chipH);

        ctx.fillStyle = "#dff2ff";
        ctx.font = "12px system-ui";
        const waveLabel = questHud.state === "wave" ? "Tsunami impact in progress" : questHud.state === "countdown" ? "Tsunami incoming" : "Round complete";
        ctx.fillText(waveLabel, chipX + 10, chipY + 16);
      }

      if (!compactHud) {
        const objectiveY = 92;
        ctx.fillStyle = "rgba(216, 238, 255, 0.94)";
        ctx.fillText(objective, 28, objectiveY);
        ctx.fillStyle = "rgba(198, 224, 248, 0.82)";
        ctx.fillText("Mouse: L Suck / R Drop | Touch: Left joystick move/jump | Right side grab/place + toggle", 28, objectiveY + 22);
      }

      if (questHud.state === "success" || questHud.state === "fail") {
        ctx.fillStyle = questHud.state === "success" ? "rgba(46,144,94,0.82)" : "rgba(157,58,58,0.86)";
        ctx.fillRect(canvasEl.width * 0.5 - 170, 18, 340, 34);
        ctx.strokeStyle = "rgba(230,240,255,0.55)";
        ctx.strokeRect(canvasEl.width * 0.5 - 170, 18, 340, 34);
        ctx.fillStyle = "#eef7ff";
        ctx.font = "bold 15px system-ui";
        ctx.fillText(questHud.state === "success" ? "TRIBE SAVED" : "TRIBE LOST", canvasEl.width * 0.5 - 56, 40);
      }

      // restart control (mobile + desktop click)
      const restartW = 104;
      const restartH = 34;
      const restartX = canvasEl.width - restartW - 16;
      const restartY = 18;
      const restartGrad = ctx.createLinearGradient(restartX, restartY, restartX, restartY + restartH);
      restartGrad.addColorStop(0, "rgba(28, 56, 86, 0.82)");
      restartGrad.addColorStop(1, "rgba(12, 30, 48, 0.86)");
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      ctx.fillRect(restartX + 2, restartY + 2, restartW, restartH);
      ctx.fillStyle = restartGrad;
      ctx.fillRect(restartX, restartY, restartW, restartH);
      ctx.strokeStyle = "rgba(186,218,255,0.6)";
      ctx.strokeRect(restartX, restartY, restartW, restartH);
      ctx.fillStyle = "#e8f5ff";
      ctx.font = "bold 14px system-ui";
      ctx.fillText("Restart", restartX + 22, restartY + 22);

      // mobile left joystick (movement only)
      const mobile = mobileRef.current;
      const joyCenterX = 96;
      const joyCenterY = canvasEl.height - 108;
      const joyR = 60;

      ctx.fillStyle = "rgba(9,17,30,0.3)";
      ctx.beginPath();
      ctx.arc(joyCenterX, joyCenterY, joyR + 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(186,218,255,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(joyCenterX, joyCenterY, joyR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = "rgba(115,205,255,0.4)";
      ctx.beginPath();
      ctx.arc(joyCenterX + mobile.stickX, joyCenterY + mobile.stickY, 24, 0, Math.PI * 2);
      ctx.fill();

      // mobile tool toggle (bottom-right)
      const toggleW = 132;
      const toggleH = 44;
      const toggleX = canvasEl.width - toggleW - 16;
      const toggleY = canvasEl.height - toggleH - 52;

      const toggleGrad = ctx.createLinearGradient(toggleX, toggleY, toggleX, toggleY + toggleH);
      toggleGrad.addColorStop(0, "rgba(22, 42, 68, 0.82)");
      toggleGrad.addColorStop(1, "rgba(10, 20, 34, 0.84)");
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.fillRect(toggleX + 2, toggleY + 2, toggleW, toggleH);
      ctx.fillStyle = toggleGrad;
      ctx.fillRect(toggleX, toggleY, toggleW, toggleH);
      ctx.strokeStyle = "rgba(186,218,255,0.52)";
      ctx.strokeRect(toggleX, toggleY, toggleW, toggleH);

      const grabActive = mobile.toolToggle === "suck";
      ctx.fillStyle = grabActive ? "rgba(95,196,255,0.36)" : "rgba(255,183,120,0.28)";
      ctx.fillRect(toggleX + 4, toggleY + 4, toggleW - 8, toggleH - 8);
      ctx.fillStyle = "#e8f5ff";
      ctx.font = "bold 14px system-ui";
      ctx.fillText(grabActive ? "Mode: GRAB" : "Mode: PLACE", toggleX + 16, toggleY + 28);

      // lightweight cinematic framing (visual-only, non-intrusive)
      const letterbox = Math.floor(4 + cinematicFocus * 6 + waveVisualIntensity * 8);
      ctx.fillStyle = `rgba(4, 8, 14, ${0.2 + stormMood * 0.15})`;
      ctx.fillRect(0, 0, canvasEl.width, letterbox);
      ctx.fillRect(0, canvasEl.height - letterbox, canvasEl.width, letterbox);

      // lightweight post stack: bloom-ish lift + edge softness
      const highlightWash = ctx.createRadialGradient(
        canvasEl.width * 0.5,
        canvasEl.height * 0.38,
        20,
        canvasEl.width * 0.5,
        canvasEl.height * 0.38,
        Math.max(canvasEl.width, canvasEl.height) * 0.85,
      );
      highlightWash.addColorStop(0, `rgba(255, 238, 210, ${0.022 + (1 - stormMood) * 0.022})`);
      highlightWash.addColorStop(1, "rgba(255, 238, 210, 0)");
      ctx.fillStyle = highlightWash;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const edgeSoften = ctx.createRadialGradient(
        canvasEl.width * 0.5,
        canvasEl.height * 0.5,
        Math.min(canvasEl.width, canvasEl.height) * 0.24,
        canvasEl.width * 0.5,
        canvasEl.height * 0.5,
        Math.max(canvasEl.width, canvasEl.height) * 0.76,
      );
      edgeSoften.addColorStop(0, "rgba(0,0,0,0)");
      edgeSoften.addColorStop(1, `rgba(8, 14, 24, ${0.09 + humidity * 0.06})`);
      ctx.fillStyle = edgeSoften;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // very subtle edge chromatic separation for lens character
      const aberration = 0.012 + humidity * 0.01 + waveVisualIntensity * 0.008 + chromaPulse;
      ctx.fillStyle = `rgba(110, 170, 255, ${aberration})`;
      ctx.fillRect(0, 0, 2, canvasEl.height);
      ctx.fillStyle = `rgba(255, 136, 124, ${aberration * 0.9})`;
      ctx.fillRect(canvasEl.width - 2, 0, 2, canvasEl.height);

      const halation = ctx.createRadialGradient(
        canvasEl.width * 0.46,
        canvasEl.height * 0.32,
        16,
        canvasEl.width * 0.46,
        canvasEl.height * 0.32,
        Math.max(canvasEl.width, canvasEl.height) * 0.6,
      );
      halation.addColorStop(0, `rgba(255, 220, 172, ${0.03 + airGlow * 0.05})`);
      halation.addColorStop(1, "rgba(255, 220, 172, 0)");
      ctx.fillStyle = halation;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // subtle film grain + chroma jitter
      const t = performance.now() * 0.001;
      ctx.fillStyle = `rgba(255,255,255,${(filmGrainAmount + Math.sin(t * 2.7) * 0.003) * uiNoiseFade})`;
      for (let i = 0; i < Math.floor(86 + uiNoiseFade * 44); i++) {
        const gx = ((i * 73.13 + t * 97) % canvasEl.width + canvasEl.width) % canvasEl.width;
        const gy = ((i * 51.77 + t * 61) % canvasEl.height + canvasEl.height) % canvasEl.height;
        ctx.fillRect(gx, gy, 1, 1);
      }

      // subtle scanline pass for retro camera feel
      ctx.fillStyle = `rgba(6, 12, 24, ${0.038 + humidity * 0.024})`;
      for (let y = 0; y < canvasEl.height; y += 4) {
        ctx.fillRect(0, y, canvasEl.width, 1);
      }

      // soft highlight bloom lift + low-end tone compression pass
      const toneCurve = ctx.createLinearGradient(0, 0, 0, canvasEl.height);
      toneCurve.addColorStop(0, `rgba(255, 236, 202, ${highlightBloom * 0.42})`);
      toneCurve.addColorStop(0.52, "rgba(255, 236, 202, 0)");
      toneCurve.addColorStop(1, `rgba(2, 8, 18, ${0.06 + humidity * 0.04})`);
      ctx.fillStyle = toneCurve;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // mild bleach-bypass inspired pass during high action for cinematic punch
      const bleach = ctx.createLinearGradient(0, 0, 0, canvasEl.height);
      bleach.addColorStop(0, `rgba(252, 242, 224, ${colorBleach * 0.34})`);
      bleach.addColorStop(0.4, `rgba(214, 226, 240, ${colorBleach * 0.12})`);
      bleach.addColorStop(1, `rgba(10, 18, 30, ${0.04 + colorBleach * 0.22})`);
      ctx.fillStyle = bleach;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      const finalTone = ctx.createLinearGradient(0, 0, canvasEl.width, canvasEl.height);
      finalTone.addColorStop(0, `rgba(255, 220, 174, ${0.018 + cinematicGradeStrength * 0.03})`);
      finalTone.addColorStop(0.52, "rgba(0,0,0,0)");
      finalTone.addColorStop(1, `rgba(14, 28, 58, ${0.03 + cinematicGradeStrength * 0.045})`);
      ctx.fillStyle = finalTone;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // subtle film-gate flicker around frame to sell camera presentation
      const gatePulse = 0.02 + Math.sin(now * 0.009) * 0.008 + cinematicFocus * 0.012;
      ctx.fillStyle = `rgba(4, 8, 16, ${gatePulse})`;
      ctx.fillRect(0, 0, canvasEl.width, 2);
      ctx.fillRect(0, canvasEl.height - 2, canvasEl.width, 2);
      ctx.fillRect(0, 0, 1, canvasEl.height);
      ctx.fillRect(canvasEl.width - 1, 0, 1, canvasEl.height);

      // tiny ordered-noise dither to reduce flat gradients/banding
      const ditherAlpha = 0.016 + humidity * 0.01;
      ctx.fillStyle = `rgba(255,255,255,${ditherAlpha})`;
      for (let y = 0; y < canvasEl.height; y += 2) {
        const jitter = ((y * 13.37 + now * 0.19) % 6) - 3;
        for (let x = ((y / 2) % 2) + jitter; x < canvasEl.width; x += 6) {
          ctx.fillRect(x, y, 1, 1);
        }
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
    const preventSelect = (e: Event) => e.preventDefault();
    canvasEl.addEventListener("contextmenu", preventMenu);
    window.addEventListener("dblclick", preventSelect, { passive: false });
    window.addEventListener("selectstart", preventSelect, { passive: false });

    canvasEl.style.touchAction = "none";
    canvasEl.style.userSelect = "none";
    (canvasEl.style as CSSStyleDeclaration & { webkitTouchCallout?: string; webkitUserSelect?: string }).webkitTouchCallout = "none";
    (canvasEl.style as CSSStyleDeclaration & { webkitTouchCallout?: string; webkitUserSelect?: string }).webkitUserSelect = "none";
    document.body.style.overscrollBehavior = "none";
    document.body.style.userSelect = "none";
    (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = "none";

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
      window.removeEventListener("dblclick", preventSelect);
      window.removeEventListener("selectstart", preventSelect);
      document.body.style.overscrollBehavior = "";
      document.body.style.userSelect = "";
      if (audioRef.current.storm) {
        audioRef.current.storm.src.stop();
        audioRef.current.storm.src.disconnect();
        audioRef.current.storm.filter.disconnect();
        audioRef.current.storm.gain.disconnect();
        audioRef.current.storm = null;
      }
      if (audioRef.current.ctx) {
        audioRef.current.ctx.close();
        audioRef.current.ctx = null;
      }
    };
  }, []);

  return <canvas ref={canvasRef} style={{ display: "block", width: "100vw", height: "100vh" }} />;
};
