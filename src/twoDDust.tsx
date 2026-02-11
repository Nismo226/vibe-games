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
const GAME_VERSION = "v0.1.5";
const BARRIER_GOAL = 16;

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
  }>({
    state: "explore",
    timer: 90,
    dialogElapsed: 0,
    tsunamiX: -220,
    tsunamiSpeed: 94,
    waveTime: 0,
    resultText: "",
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

          const tcx = Math.floor((tribe.x + tribe.w * 0.5) / CELL);
        const tcy = Math.floor((tribe.y + tribe.h * 0.5) / CELL);
        let tribeWet = false;
        for (let y = tcy - 2; y <= tcy + 2 && !tribeWet; y++) {
          for (let x = tcx - 2; x <= tcx + 2 && !tribeWet; x++) {
            if (inBounds(x, y) && getCell(x, y) === 3) tribeWet = true;
          }
        }

        const barrier = tribeBarrierStrength();
        const buried = tribeEntombed();
        const wavePassed = frontCell >= GRID_W - 2 && quest.waveTime > 5;
        if (buried) {
          quest.state = "fail";
          quest.resultText = "The tribe was buried. Keep an open safety pocket around them.";
        } else if (tribeWet && barrier < BARRIER_GOAL) {
          quest.state = "fail";
          quest.resultText = "The wave broke through. Build a bigger wall and try again.";
        } else if (wavePassed) {
          if (barrier >= BARRIER_GOAL && !buried) {
            quest.state = "success";
            quest.resultText = "Barrier held! The tribe is safe.";
          } else {
            quest.state = "fail";
            quest.resultText = "Defense incomplete. Build the wave-facing barrier without burying the tribe.";
          }
        }
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
      const waveVisualIntensity =
        q.state === "wave" ? Math.min(1, 0.45 + q.waveTime * 0.25) : q.state === "countdown" ? Math.max(0, 1 - q.timer / 90) * 0.55 : 0;
      const shake = q.state === "wave" ? Math.min(4, 1.2 + q.waveTime * 0.45) : 0;
      const shakeX = shake > 0 ? Math.sin(performance.now() * 0.04) * shake : 0;
      const shakeY = shake > 0 ? Math.cos(performance.now() * 0.05) * (shake * 0.6) : 0;

      const lookAheadX = Math.max(-120, Math.min(120, player.vx * 0.28));
      const aimLift = Math.max(0, (canvasEl.height * 0.38 - mouseRef.current.y) * 0.85);
      const targetCamX = Math.max(0, Math.min(player.x - canvasEl.width * 0.5 + lookAheadX + shakeX, GRID_W * CELL - canvasEl.width));
      const targetCamY = Math.max(0, Math.min(player.y - canvasEl.height * 0.55 - aimLift + shakeY, GRID_H * CELL - canvasEl.height));

      const cam = cameraRef.current;
      const followSpeed = player.onGround ? 11 : 7.5;
      const smooth = 1 - Math.exp(-dt * followSpeed);
      cam.x += (targetCamX - cam.x) * smooth;
      cam.y += (targetCamY - cam.y) * smooth;

      const camX = cam.x;
      const camY = cam.y;

      // background
      const bg = ctx.createLinearGradient(0, 0, 0, canvasEl.height);
      bg.addColorStop(0, "#09122a");
      bg.addColorStop(1, "#0c1d12");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

      // parallax atmosphere (holistic polish)
      const tSky = performance.now() * 0.00008;
      const ridgeA = canvasEl.height * 0.44;
      const ridgeB = canvasEl.height * 0.56;
      ctx.fillStyle = "rgba(34,64,96,0.35)";
      for (let i = -1; i <= 8; i++) {
        const x = i * 170 - ((camX * 0.12 + tSky * 400) % 170);
        const h = 24 + ((i * 37) % 42);
        ctx.fillRect(x, ridgeA - h, 210, h);
      }
      ctx.fillStyle = "rgba(18,40,62,0.42)";
      for (let i = -1; i <= 7; i++) {
        const x = i * 220 - ((camX * 0.2 + tSky * 520) % 220);
        const h = 36 + ((i * 23) % 56);
        ctx.fillRect(x, ridgeB - h, 260, h);
      }

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

            const grad = ctx.createLinearGradient(sx, sy, sx + CELL, sy + CELL);
            grad.addColorStop(0, "rgba(238, 199, 132, 0.12)");
            grad.addColorStop(1, "rgba(90, 62, 30, 0.14)");
            ctx.fillStyle = grad;
            ctx.fillRect(sx, sy, CELL, CELL);

            ctx.fillStyle = "rgba(234, 196, 134, 0.24)";
            if (hash2(x + 11, y + 7) > 0.35) ctx.fillRect(sx + 2, sy + 2, 2, 2);
            if (hash2(x + 17, y + 3) > 0.45) ctx.fillRect(sx + 7, sy + 3, 2, 2);
            if (hash2(x + 5, y + 19) > 0.4) ctx.fillRect(sx + 4, sy + 8, 2, 2);
            if (hash2(x + 13, y + 31) > 0.52) ctx.fillRect(sx + 9, sy + 5, 1, 1);

            ctx.fillStyle = "rgba(58, 40, 22, 0.24)";
            if (hash2(x + 23, y + 29) > 0.5) ctx.fillRect(sx + 9, sy + 7, 2, 2);
            if (hash2(x + 2, y + 37) > 0.58) ctx.fillRect(sx + 5, sy + 10, 1, 1);

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
          } else if (c === 3) {
            const t = performance.now() * 0.003;
            const wn = hash2(x + Math.floor(t * 11), y + Math.floor(t * 7));
            const topAir = getCell(x, y - 1) === 0;
            const leftAir = getCell(x - 1, y) === 0;
            const rightAir = getCell(x + 1, y) === 0;

            const deep = 130 + Math.floor(wn * 25);
            ctx.fillStyle = `rgba(${28 + Math.floor(wn * 22)}, ${deep}, ${220 + Math.floor(wn * 24)}, 0.9)`;
            ctx.fillRect(sx, sy, CELL, CELL);

            const inner = ctx.createLinearGradient(sx, sy, sx + CELL, sy + CELL);
            inner.addColorStop(0, "rgba(190,238,255,0.18)");
            inner.addColorStop(1, "rgba(12,78,156,0.22)");
            ctx.fillStyle = inner;
            ctx.fillRect(sx, sy, CELL, CELL);

            if (topAir) {
              const foamBase = 0.5 + waveVisualIntensity * 0.34;
              ctx.fillStyle = `rgba(232,250,255,${foamBase})`;
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
            ctx.fillStyle = "#5b5f68";
            ctx.fillRect(sx, sy, CELL, CELL);
          }
        }
      }

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

        ctx.fillStyle = "rgba(8, 18, 34, 0.82)";
        ctx.fillRect(ix - 44, iy + 12, 88, 20);
        ctx.strokeStyle = "rgba(170, 220, 255, 0.65)";
        ctx.strokeRect(ix - 44, iy + 12, 88, 20);
        ctx.fillStyle = "#d9f1ff";
        ctx.font = "12px system-ui";
        ctx.fillText(`${distCells}m → tribe`, ix - 36, iy + 26);
      }

      // tribe character (first rescue target)
      const tx = tribe.x - camX;
      const tribeBob = Math.sin(performance.now() * 0.005) * 1.5;
      const ty = tribe.y - camY + tribeBob;

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

      // adaptive barrier blueprint overlay (countdown/wave): shows where protection is still missing
      if (quest.state === "countdown" || quest.state === "wave") {
        const plan = getBarrierPlan();
        let missing = 0;

        for (let x = plan.x0; x <= plan.x1; x++) {
          for (let y = plan.y0; y <= plan.y1; y++) {
            if (!inBounds(x, y)) continue;
            const cell = getCell(x, y);
            const sx = x * CELL - camX;
            const sy = y * CELL - camY;
            const filled = cell === 1;
            if (!filled) missing++;

            if (filled) {
              ctx.fillStyle = "rgba(124, 214, 167, 0.2)";
              ctx.fillRect(sx + 1, sy + 1, CELL - 2, CELL - 2);
            } else {
              const pulse = 0.35 + Math.sin(performance.now() * 0.006 + x * 0.8 + y * 0.35) * 0.2;
              ctx.fillStyle = `rgba(243, 138, 116, ${Math.max(0.14, pulse)})`;
              ctx.fillRect(sx + 1, sy + 1, CELL - 2, CELL - 2);
              ctx.strokeStyle = "rgba(255, 223, 205, 0.42)";
              ctx.strokeRect(sx + 1.5, sy + 1.5, CELL - 3, CELL - 3);
            }
          }
        }

        const labelX = tribeScreenX - 92;
        const labelY = ty - 52;
        const labelW = 184;
        const labelH = 24;
        ctx.fillStyle = "rgba(16, 24, 36, 0.8)";
        ctx.fillRect(labelX, labelY, labelW, labelH);
        ctx.strokeStyle = "rgba(197, 224, 255, 0.42)";
        ctx.strokeRect(labelX, labelY, labelW, labelH);
        ctx.fillStyle = missing > 0 ? "#ffd5c9" : "#d1ffe5";
        ctx.font = "12px system-ui";
        ctx.fillText(missing > 0 ? `Barrier blueprint: fill ${missing} tiles` : "Barrier blueprint: complete", labelX + 8, labelY + 16);
      }

      // removed legacy white wave overlays; keep only block-water visuals

      if (quest.state === "wave") {
        const floodTint = Math.min(0.2, 0.06 + quest.waveTime * 0.01);
        ctx.fillStyle = `rgba(60,132,210,${floodTint})`;
        ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
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
          ctx.moveTo(rx, ry);
          ctx.lineTo(rx + slant, ry + len);
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
        ctx.strokeStyle = "rgba(180,220,255,0.9)";
        ctx.lineWidth = 2;
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

      ctx.fillStyle = playerWater > 0.12 ? "#bfe4ff" : "#cfe9ff";
      ctx.fillRect(player.x - camX, player.y - camY, player.w, player.h);

      // HUD (auto-compact while actively playing/building)
      const questHud = questRef.current;
      let objective = "Objective: Reach the far-right tribe.";
      if (questHud.state === "dialog") objective = "Objective: Listen to the elder...";
      if (questHud.state === "countdown") objective = `Objective: Build a sand barrier! Tsunami in: ${questHud.timer.toFixed(1)}s`;
      if (questHud.state === "wave") objective = "Objective: Hold the barrier! Tsunami is hitting from the LEFT.";
      if (questHud.state === "success") objective = `Success: ${questHud.resultText}`;
      if (questHud.state === "fail") objective = `Failed: ${questHud.resultText}`;

      const visCols = Math.floor(canvasEl.width / CELL);
      const visRows = Math.floor(canvasEl.height / CELL);
      const visSquares = visCols * visRows;
      const compactHud = mouseRef.current.left || mouseRef.current.right || mobileRef.current.moveId !== -1;
      const barrierStrength = tribeBarrierStrength();
      const barrierRatio = Math.max(0, Math.min(1, barrierStrength / BARRIER_GOAL));
      const barrierActive = questHud.state === "countdown" || questHud.state === "wave";
      const countdownProgress = questHud.state === "countdown" ? Math.max(0, Math.min(1, 1 - questHud.timer / 90)) : questHud.state === "wave" ? 1 : 0;
      const expectedBarrier = Math.floor(BARRIER_GOAL * (0.2 + countdownProgress * 0.75));
      const urgencyGap = barrierActive ? Math.max(0, expectedBarrier - barrierStrength) : 0;

      ctx.fillStyle = "rgba(10,18,30,0.72)";
      ctx.fillRect(14, 14, 760, compactHud ? 62 : 110);
      ctx.strokeStyle = "rgba(170,210,255,0.45)";
      ctx.strokeRect(14, 14, 760, compactHud ? 62 : 110);

      const hudWind = getStormWind(questHud);
      const windLevel = Math.min(1, Math.abs(hudWind.gust) / 88);
      const windDir = hudWind.gust >= 0 ? "→" : "←";

      ctx.fillStyle = "#d8eeff";
      ctx.font = "16px system-ui";
      ctx.fillText(`2D Dust Prototype ${GAME_VERSION} - Level 1: Tsunami Warning`, 28, 38);
      ctx.font = "14px system-ui";
      ctx.fillText(`Dirt: ${dirtRef.current}/${MAX_DIRT} | Visible: ~${visSquares} cells (${visCols}x${visRows})`, 28, 60);
      if (hudWind.storm > 0.02) {
        const windText = `Wind ${windDir} ${Math.round(windLevel * 100)}%`;
        ctx.fillStyle = windLevel > 0.6 ? "#ffd8bf" : "#cde9ff";
        ctx.fillText(windText, 28, compactHud ? 82 : 82);
      }

      if (barrierActive || questHud.state === "success" || questHud.state === "fail") {
        const barX = 516;
        const barY = 44;
        const barW = 238;
        const barH = 12;
        const fillW = Math.round(barW * barrierRatio);
        const pulse = urgencyGap > 0 ? 0.55 + Math.sin(performance.now() * 0.012) * 0.45 : 0.25;

        ctx.fillStyle = "rgba(8,14,24,0.85)";
        ctx.fillRect(barX - 2, barY - 2, barW + 4, barH + 4);
        ctx.fillStyle = "rgba(165,205,240,0.18)";
        ctx.fillRect(barX, barY, barW, barH);
        const barGrad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
        barGrad.addColorStop(0, urgencyGap > 0 ? "rgba(243,132,112,0.9)" : "rgba(117,219,174,0.85)");
        barGrad.addColorStop(1, urgencyGap > 0 ? "rgba(255,191,149,0.92)" : "rgba(85,186,255,0.9)");
        ctx.fillStyle = barGrad;
        ctx.fillRect(barX, barY, fillW, barH);
        ctx.strokeStyle = `rgba(206,232,255,${0.45 + pulse * 0.35})`;
        ctx.strokeRect(barX - 0.5, barY - 0.5, barW + 1, barH + 1);

        ctx.fillStyle = "#dff2ff";
        ctx.font = "12px system-ui";
        ctx.fillText(`Barrier ${barrierStrength}/${BARRIER_GOAL}`, barX, barY - 6);

        if (questHud.state === "countdown" || questHud.state === "wave") {
          const tribeCellX = Math.floor((tribe.x + tribe.w * 0.5) / CELL);
          const frontCell = Math.max(0, Math.floor(questHud.tsunamiX / CELL));
          const distToTribe = Math.max(0, tribeCellX - frontCell);
          const threat = Math.max(0, Math.min(1, 1 - distToTribe / 42));
          const tPulse = 0.5 + Math.sin(performance.now() * (0.006 + threat * 0.012)) * 0.5;

          const threatX = barX;
          const threatY = barY + 18;
          const threatW = barW;
          const threatH = 8;
          ctx.fillStyle = "rgba(20, 28, 40, 0.78)";
          ctx.fillRect(threatX, threatY, threatW, threatH);
          ctx.fillStyle = `rgba(${Math.floor(210 + threat * 45)}, ${Math.floor(110 + (1 - threat) * 90)}, 92, ${0.4 + threat * 0.45})`;
          ctx.fillRect(threatX, threatY, Math.max(2, threatW * threat), threatH);
          ctx.strokeStyle = `rgba(255, 232, 210, ${0.26 + threat * 0.5 + tPulse * 0.18})`;
          ctx.strokeRect(threatX - 0.5, threatY - 0.5, threatW + 1, threatH + 1);

          ctx.fillStyle = threat > 0.7 ? "#ffd6c7" : "#d5ebff";
          ctx.font = "11px system-ui";
          ctx.fillText(`Wave proximity: ${distToTribe}m`, threatX, threatY + 20);
        }

      }

      if (!compactHud) {
        const objectiveY = hudWind.storm > 0.02 ? 100 : 82;
        ctx.fillStyle = "#d8eeff";
        ctx.fillText(objective, 28, objectiveY);
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
      ctx.fillStyle = "rgba(12,26,42,0.82)";
      ctx.fillRect(restartX, restartY, restartW, restartH);
      ctx.strokeStyle = "rgba(186,218,255,0.5)";
      ctx.strokeRect(restartX, restartY, restartW, restartH);
      ctx.fillStyle = "#e8f5ff";
      ctx.font = "bold 14px system-ui";
      ctx.fillText("Restart", restartX + 22, restartY + 22);

      // mobile left joystick (movement only)
      const mobile = mobileRef.current;
      const joyCenterX = 96;
      const joyCenterY = canvasEl.height - 108;
      const joyR = 60;

      ctx.fillStyle = "rgba(9,17,30,0.42)";
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

      ctx.fillStyle = "rgba(9,17,30,0.82)";
      ctx.fillRect(toggleX, toggleY, toggleW, toggleH);
      ctx.strokeStyle = "rgba(186,218,255,0.45)";
      ctx.strokeRect(toggleX, toggleY, toggleW, toggleH);

      const grabActive = mobile.toolToggle === "suck";
      ctx.fillStyle = grabActive ? "rgba(95,196,255,0.32)" : "rgba(255,183,120,0.22)";
      ctx.fillRect(toggleX + 4, toggleY + 4, toggleW - 8, toggleH - 8);
      ctx.fillStyle = "#e8f5ff";
      ctx.font = "bold 14px system-ui";
      ctx.fillText(grabActive ? "Mode: GRAB" : "Mode: PLACE", toggleX + 16, toggleY + 28);

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
