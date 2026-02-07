import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type Vec = { x: number; y: number };

type Particle = {
  x: number; // grid-space (cells)
  y: number;
  vx: number; // cells / second
  vy: number;
  life: number; // ms
  maxLife: number; // ms
  color: string;
  size: number; // in cells
};


type RpsChoice = "rock" | "paper" | "scissors";

type GamePhase =
  | { kind: "menu" }
  | { kind: "startperk" }
  | { kind: "playing" }
  | { kind: "paused" }
  | { kind: "upgrade" }
  | { kind: "rps"; your: RpsChoice | null; ai: RpsChoice | null }
  | { kind: "rpsResult"; res: "win" | "lose" | "tie"; your: RpsChoice; ai: RpsChoice }
  | { kind: "gameover" }
  | { kind: "win"; winner: "you" | "rival" };

type UpgradeId =
  | "shield_charge"
  | "magnet"
  | "control_chip"
  | "doubleFood"
  | "dash_charge"
  | "tunnel"
  | "pacman"
  | "overclock"
  | "antidote"
  | "emp" // inventory active
  | "phase" // inventory active
  | "stasis"; // inventory active

type InventoryKind = "emp" | "phase" | "stasis";

type UpgradeDef = {
  id: UpgradeId;
  title: string;
  good: string;
  bad: string;

  // draft rules
  stackable?: boolean; // if true, can appear multiple times
  maxStacks?: number; // only if stackable
  consumable?: boolean; // if true, grants charges (can repeat)

  apply: (s: GameState) => GameState;
};

type GameState = {
  seed: number;

  gridW: number;
  gridH: number;

  // player snake
  snake: Vec[]; // [0] is head
  dir: Vec;
  nextDir: Vec;

  // enemy snake (optional)
  enemyEnabled: boolean;
  enemySnake: Vec[];
  enemyDir: Vec;
  enemySpeed: number; // cells / second
  enemyGrowth: number; // segments gained per food

  // objects
  foodA: Vec;
  foodB: Vec;
  poison: Vec | null;
  walls: Set<string>;

  // progression
  score: number;
  round: number;
  timeLeftMs: number; // in current 30s round
  bestScore: number;

  // tuning (mutated by upgrades)
  speed: number; // cells / second
  baseGrowth: number; // segments gained per food
  scoreMult: number;
  magnetRadius: number; // cells
  slowmoFactor: number; // multiplier to speed (<= 1)
  shieldCharges: number;
  dashCharges: number;
  dashIframes: number; // ticks of intangibility through self/enemy
  tunnelWrap: boolean; // if true, crossing arena boundary wraps to other side

  // rare boost food
  boostFood: Vec | null;
  boostFoodTtlMs: number;

  // difficulty (downsides)
  poisonChance: number; // 0..1 per round
  fogRadius: number; // cells visible around head (<=0 means off)
  wallDensity: number; // additional walls per round
  shrinkEveryRound: number; // cells removed from each side per round

  // temporary powerups
  enemyEdibleMs: number; // while >0, you can bite rival body (not head)
  enemySlowMs: number; // slows rival while >0

  // upgrades/inventory
  upgradeStacks: Partial<Record<UpgradeId, number>>;
  inventory: { kind: InventoryKind; charges: number } | null;
};

const ROUND_MS = 15_000;

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function key(v: Vec) {
  return `${v.x},${v.y}`;
}

function eq(a: Vec, b: Vec) {
  return a.x === b.x && a.y === b.y;
}

function add(a: Vec, b: Vec): Vec {
  return { x: a.x + b.x, y: a.y + b.y };
}

function isOpposite(a: Vec, b: Vec) {
  return a.x === -b.x && a.y === -b.y;
}

function inBounds(v: Vec, w: number, h: number) {
  return v.x >= 0 && v.y >= 0 && v.x < w && v.y < h;
}

function distManhattan(a: Vec, b: Vec) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function rand01(seed: number) {
  // xorshift32-ish
  let x = seed | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  // keep it positive
  return ((x >>> 0) % 1_000_000) / 1_000_000;
}

function nextSeed(seed: number) {
  // LCG
  return (seed * 1664525 + 1013904223) >>> 0;
}

function randInt(seed: number, a: number, b: number) {
  const s2 = nextSeed(seed);
  const r = rand01(s2);
  return { seed: s2, value: a + Math.floor(r * (b - a + 1)) };
}

function shuffle<T>(seed: number, arr: T[]) {
  let s = seed;
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const ri = randInt(s, 0, i);
    s = ri.seed;
    const j = ri.value;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return { seed: s, value: a };
}

function pickEmptyCell(s: GameState, seed: number) {
  let ss = seed;
  for (let tries = 0; tries < 5000; tries++) {
    const rx = randInt(ss, 0, s.gridW - 1);
    ss = rx.seed;
    const ry = randInt(ss, 0, s.gridH - 1);
    ss = ry.seed;
    const v = { x: rx.value, y: ry.value };
    if (s.walls.has(key(v))) continue;
    if (s.snake.some((p) => eq(p, v))) continue;
    if (s.enemyEnabled && s.enemySnake.some((p) => eq(p, v))) continue;
    if (s.poison && eq(s.poison, v)) continue;
    if (s.boostFood && eq(s.boostFood, v)) continue;
    if (eq(s.foodA, v)) continue;
    if (eq(s.foodB, v)) continue;
    return { seed: ss, value: v };
  }
  // fallback: return head-adjacent in bounds
  const cand = add(s.snake[0], { x: 1, y: 0 });
  return { seed: ss, value: inBounds(cand, s.gridW, s.gridH) ? cand : s.snake[0] };
}

function makeWallsForRound(s: GameState, seed: number) {
  // Create some random walls, but avoid spawning on snake or food.
  let ss = seed;
  const walls = new Set<string>(s.walls);

  const count = Math.floor(s.wallDensity);
  for (let i = 0; i < count; i++) {
    const cell = pickEmptyCell({ ...s, walls }, ss);
    ss = cell.seed;
    walls.add(key(cell.value));
  }
  return { seed: ss, value: walls };
}

function shrinkGridForRound(s: GameState) {
  if (s.shrinkEveryRound <= 0) return s;

  const shrink = Math.min(s.shrinkEveryRound * (s.round - 1), 10);
  const newW = clamp(s.gridW - 2 * shrink, 14, 40);
  const newH = clamp(s.gridH - 2 * shrink, 14, 40);

  // Keep snake positions within bounds by clamping; if multiple overlap, it's ok (will be resolved quickly).
  const snake = s.snake.map((p) => ({
    x: clamp(p.x, 0, newW - 1),
    y: clamp(p.y, 0, newH - 1),
  }));

  const foodA = {
    x: clamp(s.foodA.x, 0, newW - 1),
    y: clamp(s.foodA.y, 0, newH - 1),
  };
  const foodB = {
    x: clamp(s.foodB.x, 0, newW - 1),
    y: clamp(s.foodB.y, 0, newH - 1),
  };
  const poison = s.poison
    ? {
        x: clamp(s.poison.x, 0, newW - 1),
        y: clamp(s.poison.y, 0, newH - 1),
      }
    : null;

  const walls = new Set<string>();
  for (const k of s.walls) {
    const [xStr, yStr] = k.split(",");
    const x = Number(xStr);
    const y = Number(yStr);
    if (x >= 0 && y >= 0 && x < newW && y < newH) walls.add(k);
  }

  return { ...s, gridW: newW, gridH: newH, snake, foodA, foodB, poison, walls };
}

function initialState(bestScore: number): GameState {
  const gridW = 30;
  const gridH = 20;
  const snake: Vec[] = [
    { x: Math.floor(gridW / 2), y: Math.floor(gridH / 2) },
    { x: Math.floor(gridW / 2) - 1, y: Math.floor(gridH / 2) },
    { x: Math.floor(gridW / 2) - 2, y: Math.floor(gridH / 2) },
  ];
  const seed = (Date.now() >>> 0) ^ 0xa5a5a5a5;
  const foodA = { x: Math.floor(gridW / 2) + 6, y: Math.floor(gridH / 2) };
  const foodB = { x: Math.floor(gridW / 2) - 6, y: Math.floor(gridH / 2) };

  // rival is always present
  const enemySnake: Vec[] = [
    { x: Math.floor(gridW / 2), y: Math.floor(gridH / 2) + 5 },
    { x: Math.floor(gridW / 2) - 1, y: Math.floor(gridH / 2) + 5 },
    { x: Math.floor(gridW / 2) - 2, y: Math.floor(gridH / 2) + 5 },
  ];

  return {
    seed,
    gridW,
    gridH,

    snake,
    dir: { x: 1, y: 0 },
    nextDir: { x: 1, y: 0 },

    enemyEnabled: true,
    enemySnake,
    enemyDir: { x: -1, y: 0 },
    enemySpeed: 7.5,
    enemyGrowth: 1,

    foodA,
    foodB,
    poison: null,
    walls: new Set<string>(),

    score: 0,
    round: 1,
    timeLeftMs: ROUND_MS,
    bestScore,

    speed: 5, // baseline speed (mobile-friendly)
    baseGrowth: 1,
    scoreMult: 1,
    magnetRadius: 0,
    slowmoFactor: 1,
    shieldCharges: 0,
    dashCharges: 0,
    dashIframes: 0,
    tunnelWrap: false,

    boostFood: null,
    boostFoodTtlMs: 0,

    poisonChance: 0,
    fogRadius: 0,
    wallDensity: 0,
    shrinkEveryRound: 0,

    enemyEdibleMs: 0,
    enemySlowMs: 0,

    upgradeStacks: {},
    inventory: null,
  };
}

const STARTER_PERKS: UpgradeDef[] = [
  {
    id: "shield_charge",
    title: "Starter: Neon Shield",
    good: "+1 shield charge",
    bad: "+1 random wall each round",
    consumable: true,
    apply: (s) => ({
      ...s,
      shieldCharges: s.shieldCharges + 1,
      wallDensity: s.wallDensity + 1,
    }),
  },
  {
    id: "magnet",
    title: "Starter: Food Magnet",
    good: "+3 magnet radius",
    bad: "+6% poison chance",
    stackable: true,
    maxStacks: 3,
    apply: (s) => ({
      ...s,
      magnetRadius: s.magnetRadius + 3,
      poisonChance: clamp(s.poisonChance + 0.06, 0, 0.6),
    }),
  },
  {
    id: "dash_charge",
    title: "Starter: Dash Core",
    good: "+1 dash charge",
    bad: "+2 walls each round",
    consumable: true,
    apply: (s) => ({
      ...s,
      dashCharges: s.dashCharges + 1,
      wallDensity: s.wallDensity + 2,
    }),
  },
  {
    id: "control_chip",
    title: "Starter: Control Chip",
    good: "-10% speed (control)",
    bad: "+8% enemy speed",
    apply: (s) => ({
      ...s,
      slowmoFactor: s.slowmoFactor * 0.9,
      enemySpeed: s.enemySpeed * 1.08,
    }),
  },
  {
    id: "tunnel",
    title: "Starter: Wormhole Skin",
    good: "Wrap through edges",
    bad: "+10% speed",
    apply: (s) => ({ ...s, tunnelWrap: true, speed: s.speed * 1.1 }),
  },
  {
    id: "pacman",
    title: "Starter: Pac-Man Permit",
    good: "For 5s, bite rival body (not head) to steal tail segments",
    bad: "+10% enemy speed",
    apply: (s) => ({
      ...s,
      enemyEdibleMs: Math.max(s.enemyEdibleMs, 5000),
      enemySpeed: s.enemySpeed * 1.1,
    }),
  },
];

const UPGRADE_POOL: UpgradeDef[] = [
  {
    id: "shield_charge",
    title: "Neon Shield",
    good: "+1 shield charge (ignore one fatal hit)",
    bad: "+1 random wall each round",
    consumable: true,
    apply: (s) => ({
      ...s,
      shieldCharges: s.shieldCharges + 1,
      wallDensity: s.wallDensity + 1,
    }),
  },
  {
    id: "dash_charge",
    title: "Dash Battery",
    good: "+1 dash charge",
    bad: "+7% enemy speed",
    consumable: true,
    apply: (s) => ({ ...s, dashCharges: s.dashCharges + 1, enemySpeed: s.enemySpeed * 1.07 }),
  },
  {
    id: "magnet",
    title: "Magnet Coils",
    good: "+2 magnet radius",
    bad: "+10% speed",
    stackable: true,
    maxStacks: 3,
    apply: (s) => ({ ...s, magnetRadius: s.magnetRadius + 2, speed: s.speed * 1.1 }),
  },
  {
    id: "doubleFood",
    title: "Glutton Protocol",
    good: "+1 extra growth per food",
    bad: "+8% poison chance per round",
    apply: (s) => ({
      ...s,
      baseGrowth: s.baseGrowth + 1,
      poisonChance: clamp(s.poisonChance + 0.08, 0, 0.6),
    }),
  },
  {
    id: "control_chip",
    title: "Time Dilator",
    good: "-12% speed (smoother control)",
    bad: "+1 wall each round",
    apply: (s) => ({
      ...s,
      slowmoFactor: s.slowmoFactor * 0.88,
      wallDensity: s.wallDensity + 1,
    }),
  },
  {
    id: "tunnel",
    title: "Wormhole Skin",
    good: "Wrap through arena edges",
    bad: "+15% speed",
    apply: (s) => ({ ...s, tunnelWrap: true, speed: s.speed * 1.15 }),
  },
  {
    id: "pacman",
    title: "Pac-Man Permit",
    good: "For 5s, bite rival body (not head) to steal tail segments",
    bad: "+12% poison chance per round",
    apply: (s) => ({
      ...s,
      enemyEdibleMs: Math.max(s.enemyEdibleMs, 5000),
      poisonChance: clamp(s.poisonChance + 0.12, 0, 0.6),
    }),
  },
  {
    id: "overclock",
    title: "Overclock",
    good: "+12% speed",
    bad: "+1 enemy growth per food",
    apply: (s) => ({ ...s, speed: s.speed * 1.12, enemyGrowth: clamp(s.enemyGrowth + 1, 1, 4) }),
  },
  {
    id: "antidote",
    title: "Antidote Gel",
    good: "Poison penalty reduced",
    bad: "+8% enemy speed",
    apply: (s) => ({ ...s, enemySpeed: s.enemySpeed * 1.08 }),
  },
  {
    id: "emp",
    title: "EMP Pulse (Inventory)",
    good: "Store 1 EMP. Use to slow rival for 4s",
    bad: "+10% poison chance per round",
    apply: (s) => ({
      ...s,
      inventory: { kind: "emp", charges: 1 },
      poisonChance: clamp(s.poisonChance + 0.1, 0, 0.6),
    }),
  },
  {
    id: "phase",
    title: "Phase Shift (Inventory)",
    good: "Store 1 Phase. Use to become intangible briefly",
    bad: "+1 wall each round",
    apply: (s) => ({
      ...s,
      inventory: { kind: "phase", charges: 1 },
      wallDensity: s.wallDensity + 1,
    }),
  },
  {
    id: "stasis",
    title: "Stasis Spike (Inventory)",
    good: "Store 1 Stasis. Use to nearly-freeze rival for 2.5s",
    bad: "+10% speed",
    apply: (s) => ({
      ...s,
      inventory: { kind: "stasis", charges: 1 },
      speed: s.speed * 1.1,
    }),
  },
];

const WIN_LENGTH = 100;

function formatTime(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return m > 0 ? `${m}:${String(ss).padStart(2, "0")}` : `${ss}s`;
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const particlesRef = useRef<Particle[]>([]);
  const shakeRef = useRef<{ power: number; tMs: number }>({ power: 0, tMs: 0 });

  function addShake(power: number) {
    const s = shakeRef.current;
    s.power = Math.min(14, s.power + power);
    s.tMs = 120; // decay window
  }

  const [sfxVolume, setSfxVolume] = useState<number>(() => {
    const v = Number(localStorage.getItem("ultimateSnake_sfxVolume") || "0.9");
    return Number.isFinite(v) ? clamp(v, 0, 1) : 0.9;
  });

  const [bgmVolume, setBgmVolume] = useState<number>(() => {
    const v = Number(localStorage.getItem("ultimateSnake_bgmVolume") || "0.45");
    return Number.isFinite(v) ? clamp(v, 0, 1) : 0.45;
  });

  const [bgmOn, setBgmOn] = useState<boolean>(() => {
    return localStorage.getItem("ultimateSnake_bgmOn") !== "0";
  });

  const webBgmTracks = useMemo(
    () => [
      { id: "track1", label: "Track 1", src: "music/track1.mp3" },
      { id: "track2", label: "Track 2", src: "music/track2.mp3" },
      { id: "track3", label: "Track 3", src: "music/track3.mp3" },
      { id: "track4", label: "Track 4", src: "music/track4.mp3" },
    ],
    [],
  );

  const [webBgmTrackId, setWebBgmTrackId] = useState<string>(() => {
    return localStorage.getItem("ultimateSnake_webBgmTrack") || "track1";
  });

  const [sfxMuted, setSfxMuted] = useState<boolean>(() => {
    return localStorage.getItem("ultimateSnake_sfxMuted") === "1";
  });

  // --- Snake customization (web + tauri) ---
  type SnakeSkin = {
    presetId: string;

    // gradient along the body
    hueStart: number; // 0..360
    hueEnd: number; // 0..360
    sat: number; // 0..100
    light: number; // 0..100
    alpha: number; // 0..1

    // bloom strength
    bloom: number; // 0..1

    // geometry
    headRound: number; // 0..0.5
    bodyRound: number; // 0..0.5

    // eyes
    eyesOn: boolean;
    eyeSize: number; // multiplier
  };

  const DEFAULT_SKIN: SnakeSkin = {
    presetId: "neonClassic",
    hueStart: 270,
    hueEnd: 80,
    sat: 95,
    light: 62,
    alpha: 0.92,
    bloom: 0.35,
    headRound: 0.18,
    bodyRound: 0.28,
    eyesOn: true,
    eyeSize: 1,
  };

  const SKIN_PRESETS: Array<{ id: string; label: string; skin: SnakeSkin }> = [
    { id: "neonClassic", label: "Neon Classic", skin: DEFAULT_SKIN },
    {
      id: "toxic",
      label: "Toxic Slime",
      skin: { ...DEFAULT_SKIN, presetId: "toxic", hueStart: 135, hueEnd: 60, sat: 98, light: 58, bloom: 0.42 },
    },
    {
      id: "vapor",
      label: "Vaporwave",
      skin: { ...DEFAULT_SKIN, presetId: "vapor", hueStart: 310, hueEnd: 190, sat: 95, light: 64, bloom: 0.48 },
    },
    {
      id: "ice",
      label: "Ice",
      skin: { ...DEFAULT_SKIN, presetId: "ice", hueStart: 200, hueEnd: 260, sat: 80, light: 70, bloom: 0.35 },
    },
    {
      id: "inferno",
      label: "Inferno",
      skin: { ...DEFAULT_SKIN, presetId: "inferno", hueStart: 20, hueEnd: 330, sat: 98, light: 58, bloom: 0.5 },
    },
    {
      id: "mono",
      label: "Mono",
      skin: { ...DEFAULT_SKIN, presetId: "mono", hueStart: 0, hueEnd: 0, sat: 0, light: 75, alpha: 0.95, bloom: 0.2 },
    },
  ];

  const [skin, setSkin] = useState<SnakeSkin>(() => {
    try {
      const raw = localStorage.getItem("ultimateSnake_skin");
      if (!raw) return DEFAULT_SKIN;
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SKIN, ...parsed } as SnakeSkin;
    } catch {
      return DEFAULT_SKIN;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("ultimateSnake_skin", JSON.stringify(skin));
    } catch {}
  }, [skin]);

  type SfxKind = "eat" | "boost" | "poison" | "dash" | "shield" | "death" | "ui";

  // --- Runtime detection (Tauri vs Web) ---
  const isTauri = useMemo(() => {
    const w = window as any;
    return !!(w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__);
  }, []);

  async function safeInvoke(cmd: string, args: any) {
    if (!isTauri) throw new Error("not-tauri");
    return invoke(cmd as any, args);
  }

  // --- Persistent debug log (Tauri only) ---
  const logQueueRef = useRef<string[]>([]);
  const logFlushTimerRef = useRef<number | null>(null);

  function logLine(line: string) {
    if (!isTauri) return;
    const ts = new Date().toISOString();
    logQueueRef.current.push("[" + ts + "] " + line);

    if (logFlushTimerRef.current != null) return;
    logFlushTimerRef.current = window.setTimeout(() => {
      const batch = logQueueRef.current.splice(0, 200);
      logFlushTimerRef.current = null;
      if (!batch.length) return;
      safeInvoke("append_log", { lines: batch }).catch(() => {
        // ignore logging failures
      });
    }, 150);
  }

  // --- Web audio fallback ---
  type WebSfxKind = SfxKind | "enemy_pickup";
  const webBaseUrl = (import.meta as any).env?.BASE_URL || "/";
  const webSfxUrls: Record<WebSfxKind, string> = {
    eat: webBaseUrl + "sfx/eat.wav",
    boost: webBaseUrl + "sfx/boost.wav",
    poison: webBaseUrl + "sfx/poison.wav",
    dash: webBaseUrl + "sfx/dash.wav",
    shield: webBaseUrl + "sfx/shield.wav",
    death: webBaseUrl + "sfx/death.wav",
    ui: webBaseUrl + "sfx/ui.wav",
    enemy_pickup: webBaseUrl + "sfx/enemy_pickup.wav",
  };

  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);

  const webAudioCtxRef = useRef<AudioContext | null>(null);

  function webCtx() {
    if (webAudioCtxRef.current) return webAudioCtxRef.current;
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return null;
    webAudioCtxRef.current = new Ctx();
    return webAudioCtxRef.current;
  }

  function webBossSfx() {
    const ctx = webCtx();
    if (!ctx) return;
    const now = ctx.currentTime;

    // quick "boss" chirp: detuned double-osc + downward sweep + soft distortion
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g = ctx.createGain();
    const shaper = ctx.createWaveShaper();

    const makeCurve = (amt = 18) => {
      const n = 44100;
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / n - 1;
        curve[i] = ((1 + amt) * x) / (1 + amt * Math.abs(x));
      }
      return curve;
    };
    shaper.curve = makeCurve(12);

    o1.type = "sawtooth";
    o2.type = "square";
    o1.frequency.setValueAtTime(620, now);
    o2.frequency.setValueAtTime(520, now);
    o1.frequency.exponentialRampToValueAtTime(140, now + 0.14);
    o2.frequency.exponentialRampToValueAtTime(120, now + 0.14);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.55 * clamp(sfxVolume, 0, 1), now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);

    o1.connect(shaper);
    o2.connect(shaper);
    shaper.connect(g);
    g.connect(ctx.destination);

    o1.start(now);
    o2.start(now);
    o1.stop(now + 0.2);
    o2.stop(now + 0.2);
  }

  function webPlaySfx(kind: string) {
    if (kind === "enemy_pickup") {
      webBossSfx();
      return;
    }

    const src = (webSfxUrls as any)[kind];
    if (!src) return;
    // clone-per-play so rapid events can overlap
    const a = new Audio(src);
    a.volume = clamp(sfxVolume, 0, 1);
    a.play().catch(() => {
      // browser may block until user interaction; ignore
    });
  }

  function webBgmSrc() {
    const t = webBgmTracks.find((x) => x.id === webBgmTrackId) || webBgmTracks[0];
    return webBaseUrl + (t?.src || "music/track1.mp3");
  }

  function nextWebTrack() {
    setWebBgmTrackId((prev) => {
      const i = webBgmTracks.findIndex((t) => t.id === prev);
      const next = webBgmTracks[(i >= 0 ? i + 1 : 1) % webBgmTracks.length];
      return next?.id || "track1";
    });
  }

  function ensureWebBgm() {
    const desired = webBgmSrc();

    const wire = (a: HTMLAudioElement) => {
      a.loop = false; // play sequentially, not repeat
      a.onended = () => {
        // advance playlist when a track ends
        if (bgmOn) nextWebTrack();
      };
    };

    if (bgmAudioRef.current) {
      const a = bgmAudioRef.current;
      wire(a);
      if (a.src !== desired) {
        try {
          a.pause();
        } catch {}
        a.src = desired;
        a.load();
      }
      return a;
    }

    const a = new Audio(desired);
    a.preload = "auto";
    wire(a);
    bgmAudioRef.current = a;
    return a;
  }

  // --- BGM (Tauri backend OR Web fallback) ---
  useEffect(() => {
    localStorage.setItem("ultimateSnake_bgmVolume", String(bgmVolume));
    if (isTauri) {
      safeInvoke("bgm_volume", { volume: bgmVolume, muted: !bgmOn }).catch(() => {});
    } else {
      const a = ensureWebBgm();
      a.volume = bgmOn ? clamp(bgmVolume, 0, 1) : 0;
    }
  }, [bgmVolume, bgmOn, isTauri]);

  useEffect(() => {
    localStorage.setItem("ultimateSnake_bgmOn", bgmOn ? "1" : "0");

    if (isTauri) {
      if (bgmOn) safeInvoke("bgm_play", { volume: bgmVolume, muted: false }).catch(() => {});
      else safeInvoke("bgm_stop", {}).catch(() => {});
      return;
    }

    const a = ensureWebBgm();
    a.volume = bgmOn ? clamp(bgmVolume, 0, 1) : 0;
    if (bgmOn) {
      a.play().catch(() => {
        // will start after first user interaction; see unlock effect below
      });
    } else {
      a.pause();
      a.currentTime = 0;
    }
  }, [bgmOn, bgmVolume, isTauri, webBgmTrackId]);

  useEffect(() => {
    localStorage.setItem("ultimateSnake_webBgmTrack", webBgmTrackId);
  }, [webBgmTrackId]);

  // Try to "unlock" audio on first interaction (Web only)
  useEffect(() => {
    if (isTauri) return;

    const unlock = () => {
      // resume audio context for synthesized sounds
      try {
        const ctx = webCtx();
        if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
      } catch {}

      if (!bgmOn) return;
      const a = ensureWebBgm();
      a.volume = clamp(bgmVolume, 0, 1);
      a.play().catch(() => {});
    };

    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [isTauri, bgmOn, bgmVolume]);

  // --- SFX (Tauri invoke OR Web fallback) ---
  useEffect(() => {
    localStorage.setItem("ultimateSnake_sfxMuted", sfxMuted ? "1" : "0");
  }, [sfxMuted]);

  useEffect(() => {
    localStorage.setItem("ultimateSnake_sfxVolume", String(sfxVolume));
  }, [sfxVolume]);

  function enemyPickupSfxKind(): string {
    // single procedural rival pickup sound (generated in Rust backend)
    return "enemy_pickup";
  }

  function sfx(kind: SfxKind | string) {
    if (sfxMuted || sfxVolume <= 0.001) return;

    if (!isTauri) {
      webPlaySfx(kind);
      return;
    }

    logLine(
      "SFX invoke <" +
        kind +
        "> vol=" +
        sfxVolume.toFixed(2) +
        " muted=" +
        String(sfxMuted),
    );
    safeInvoke("play_sfx", { kind, volume: sfxVolume, muted: sfxMuted }).catch((err: any) => {
      const msg = String(err?.message || err);
      logLine("SFX invoke <" + kind + "> failed: " + msg);
    });
  }

  function spawnBurst(v: Vec, color: string, n = 18) {
    const arr = particlesRef.current;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3.0 + Math.random() * 8.0;
      arr.push({
        x: v.x + 0.5,
        y: v.y + 0.5,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 420,
        maxLife: 420,
        color,
        size: 0.10 + Math.random() * 0.14,
      });
    }
    if (arr.length > 900) arr.splice(0, arr.length - 900);
  }


  const rafRef = useRef<number | null>(null);
  const lastTRef = useRef<number | null>(null);
  const accRef = useRef(0);
  const tickCountRef = useRef(0);

  // controller support
  const gamepadDirRef = useRef<Vec | null>(null);
  const lastGamepadDirRef = useRef<Vec | null>(null);

  const [phase, setPhase] = useState<GamePhase>({ kind: "menu" });

  // swipe-to-turn (mobile)
  const swipeRef = useRef<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 });
  const phaseRef = useRef<GamePhase>(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  const [state, setState] = useState<GameState>(() => {
    const best = Number(localStorage.getItem("lyricDoorSnake_best") || "0") || 0;
    return initialState(best);
  });
  const stateRef = useRef<GameState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  function setPhaseIfPlaying(p: GamePhase) {
    if (phaseRef.current.kind === "playing") setPhase(p);
  }

  const [upgradeChoices, setUpgradeChoices] = useState<UpgradeDef[]>([]);
  const [overlayIndex, setOverlayIndex] = useState<number>(0);
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const skinPreviewRef = useRef<HTMLCanvasElement | null>(null);

  // draggable on-screen controls (saved per-device)
  const [editControls, setEditControls] = useState<boolean>(false);
  const [controlsEditorOpen, setControlsEditorOpen] = useState<boolean>(false);
  const [controlPos, setControlPos] = useState<{
    touchPadRight: number;
    touchPadBottom: number;
    touchPadScale: number;
    useLeft: number;
    useBottom: number;
    useScale: number;
  }>(() => {
    try {
      const raw = localStorage.getItem("ultimateSnake_controlPos");
      if (raw) {
        const p = JSON.parse(raw);
        return {
          touchPadRight: p.touchPadRight ?? 12,
          touchPadBottom: p.touchPadBottom ?? 150,
          touchPadScale: p.touchPadScale ?? 1,
          useLeft: p.useLeft ?? 12,
          useBottom: p.useBottom ?? 150,
          useScale: p.useScale ?? 1,
        };
      }
    } catch {}
    return { touchPadRight: 12, touchPadBottom: 150, touchPadScale: 1, useLeft: 12, useBottom: 150, useScale: 1 };
  });

  useEffect(() => {
    try {
      localStorage.setItem("ultimateSnake_controlPos", JSON.stringify(controlPos));
    } catch {}
  }, [controlPos]);

  const dragRef = useRef<
    | null
    | {
        kind: "touchPad" | "use";
        startX: number;
        startY: number;
        startRight?: number;
        startBottom?: number;
        startLeft?: number;
      }
  >(null);

  useEffect(() => {
    if (phase.kind === "startperk" || phase.kind === "upgrade" || phase.kind === "gameover" || phase.kind === "win") {
      setOverlayIndex(0);
    }
  }, [phase.kind]);

  // Settings: live skin preview (head + ~10 segments)
  useEffect(() => {
    if (!settingsOpen) return;
    const c = skinPreviewRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const w = c.width;
    const h = c.height;
    ctx.clearRect(0, 0, w, h);

    // background
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    ctx.fillRect(0, 0, w, h);

    const n = 11;
    const size = Math.min(42, Math.floor((w - 24) / n));
    const y = Math.floor(h / 2 - size / 2);

    for (let i = 0; i < n; i++) {
      const t = i / Math.max(1, n - 1);
      const hue = skin.hueStart + (skin.hueEnd - skin.hueStart) * t;
      ctx.fillStyle = `hsl(${hue} ${clamp(skin.sat, 0, 100)}% ${clamp(skin.light, 0, 100)}% / ${clamp(skin.alpha, 0, 1)})`;
      const x = 12 + i * size;
      const rr = i === 0 ? skin.headRound : skin.bodyRound;
      // reuse same geometry as game
      roundedRect(ctx as any, x, y, size - 4, size - 4, (size - 4) * clamp(rr, 0, 0.5));
      ctx.fill();

      if (i === 0 && skin.eyesOn) {
        ctx.fillStyle = "rgba(10,10,20,0.7)";
        const ex = x + (size - 4) * 0.35;
        const ey = y + (size - 4) * 0.38;
        const eyeR = (size - 4) * 0.10 * clamp(skin.eyeSize, 0.6, 2.0);
        ctx.beginPath();
        ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
        ctx.arc(x + (size - 4) * 0.70, ey, eyeR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [settingsOpen, skin]);

  // input debug removed (was used for VM key troubleshooting)

  const cellSize = useMemo(() => {
    // computed in render loop based on canvas size too, but this is fine for UI layout
    return 24;
  }, []);

  function rpsResult(you: RpsChoice, ai: RpsChoice): "win" | "lose" | "tie" {
    if (you === ai) return "tie";
    if (
      (you === "rock" && ai === "scissors") ||
      (you === "paper" && ai === "rock") ||
      (you === "scissors" && ai === "paper")
    )
      return "win";
    return "lose";
  }

  function randChoice(seed: number): { seed: number; value: RpsChoice } {
    const r = randInt(seed, 0, 2);
    const v: RpsChoice = r.value === 0 ? "rock" : r.value === 1 ? "paper" : "scissors";
    return { seed: r.seed, value: v };
  }

  function relocateAfterTie(prev: GameState) {
    // Teleport both snakes to safe spots so a tie doesn't instantly re-collide.
    // We keep lengths but collapse segments onto the new head cell.
    let seed = prev.seed;

    const a = pickEmptyCell(prev, seed);
    seed = a.seed;

    const tmp: GameState = {
      ...prev,
      seed,
      snake: prev.snake.map(() => a.value),
    };

    const b = pickEmptyCell(tmp, seed);
    seed = b.seed;

    const snake = prev.snake.map(() => a.value);
    const enemySnake = prev.enemySnake.map(() => b.value);

    return {
      ...prev,
      seed,
      snake,
      enemySnake,
      dir: { x: 1, y: 0 },
      nextDir: { x: 1, y: 0 },
      enemyDir: { x: -1, y: 0 },
    };
  }

  function lockInRps() {
    const ph = phaseRef.current;
    if (ph.kind !== "rps" || !ph.your) return;

    // roll AI choice and resolve
    setState((prev) => {
      const rr = randChoice(prev.seed);
      const ai = rr.value;
      const res = rpsResult(ph.your!, ai);

      queueMicrotask(() => {
        setToast(`RPS: you ${ph.your} vs ai ${ai} → ${res.toUpperCase()}`);
        setTimeout(() => setToast(null), 1800);
        setPhase({ kind: "rpsResult", res, your: ph.your!, ai });
      });

      if (res === "tie") {
        const moved = relocateAfterTie({ ...prev, seed: rr.seed });
        return moved;
      }

      return { ...prev, seed: rr.seed };
    });
  }

  // Key handling (Tauri webview focus can be finicky; listen on document + keep canvas focusable)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      const ph = phaseRef.current;
      const k = e.key.toLowerCase();
      // key debug disabled

      // Attempt to unlock audio on first keyboard gesture (Tauri/webviews can require this)
      
      if (k === "enter") {
        if (ph.kind === "paused") {
          e.preventDefault();
          setPhase({ kind: "playing" });
          return;
        }

        if (ph.kind === "menu" || ph.kind === "gameover" || ph.kind === "win") {
          e.preventDefault();
          startNewGame();
          return;
        }

        if (ph.kind === "rpsResult") {
          e.preventDefault();
          if (ph.res === "win") setPhase({ kind: "win", winner: "you" });
          else if (ph.res === "lose") setPhase({ kind: "gameover" });
          else setPhase({ kind: "playing" });
          return;
        }

        if (ph.kind === "rps") {
          e.preventDefault();
          lockInRps();
          return;
        }
      }

      if (ph.kind === "startperk" || ph.kind === "upgrade") {
        const max = Math.max(0, upgradeChoices.length - 1);

        if (k === "arrowleft" || k === "a" || k === "arrowup" || k === "w") {
          e.preventDefault();
          setOverlayIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (k === "arrowright" || k === "d" || k === "arrowdown" || k === "s") {
          e.preventDefault();
          setOverlayIndex((i) => Math.min(max, i + 1));
          return;
        }

        if (k === "1" || k === "2" || k === "3") {
          e.preventDefault();
          const idx = Number(k) - 1;
          const u = upgradeChoices[idx];
          if (u) {
            applyUpgrade(u);
            setPhase({ kind: "playing" });
          }
          return;
        }

        if (k === "enter") {
          e.preventDefault();
          const u = upgradeChoices[overlayIndex];
          if (u) {
            applyUpgrade(u);
            setPhase({ kind: "playing" });
          }
          return;
        }

        if (k === "escape") {
          e.preventDefault();
          setPhase({ kind: "menu" });
          return;
        }

        return;
      }

      if (k === "escape") {
        if (ph.kind === "playing") {
          e.preventDefault();
          setPhase({ kind: "paused" });
          return;
        }
        if (ph.kind === "rps") {
          e.preventDefault();
          setPhase({ kind: "menu" });
          return;
        }
      }

      if (ph.kind === "rps") {
        if (k === "arrowleft" || k === "a") {
          e.preventDefault();
          setPhase((p) => ({ ...p, kind: "rps", your: "rock", ai: null }));
        }
        if (k === "arrowup" || k === "w") {
          e.preventDefault();
          setPhase((p) => ({ ...p, kind: "rps", your: "paper", ai: null }));
        }
        if (k === "arrowright" || k === "d") {
          e.preventDefault();
          setPhase((p) => ({ ...p, kind: "rps", your: "scissors", ai: null }));
        }
        return;
      }

      if (k === "p") {
        e.preventDefault();
        setPhase((cur) => (cur.kind === "playing" ? { kind: "paused" } : cur));
        return;
      }

      if (ph.kind !== "playing") return;

      // prevent arrow keys/space from being eaten by scrolling or default handlers
      if (
        k === "arrowup" ||
        k === "arrowdown" ||
        k === "arrowleft" ||
        k === "arrowright" ||
        k === " "
      ) {
        e.preventDefault();
      }

      if (k === "arrowup" || k === "w") queueDir({ x: 0, y: -1 });
      if (k === "arrowdown" || k === "s") queueDir({ x: 0, y: 1 });
      if (k === "arrowleft" || k === "a") queueDir({ x: -1, y: 0 });
      if (k === "arrowright" || k === "d") queueDir({ x: 1, y: 0 });

      if (k === " ") {
        useActive();
      }
    }

    // use capture so we see keys even if something else stops propagation
    document.addEventListener("keydown", onKeyDown, { passive: false, capture: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown, { capture: true } as any);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  // keep canvas focused while playing (so key events reliably reach the webview)
  useEffect(() => {
    if (phase.kind !== "playing") return;
    const t = setTimeout(() => {
      canvasRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [phase.kind]);

  function queueDir(d: Vec) {
    setState((prev) => {
      if (isOpposite(d, prev.dir)) return prev;
      return { ...prev, nextDir: d };
    });
  }

  function useActive() {
    let dashedTo: Vec | null = null;
    let used = false;

    setState((prev) => {
      // inventory has priority
      if (prev.inventory && prev.inventory.charges > 0) {
        used = true;
        const inv = prev.inventory;
        let nextState: GameState = { ...prev };

        if (inv.kind === "emp") {
          nextState = { ...nextState, enemySlowMs: Math.max(nextState.enemySlowMs, 4000) };
        } else if (inv.kind === "stasis") {
          nextState = { ...nextState, enemySlowMs: Math.max(nextState.enemySlowMs, 2500) };
        } else if (inv.kind === "phase") {
          nextState = { ...nextState, dashIframes: Math.max(nextState.dashIframes, 35) };
        }

        const remaining = inv.charges - 1;
        return {
          ...nextState,
          inventory: remaining > 0 ? { ...inv, charges: remaining } : null,
        };
      }

      // else: dash
      if (prev.dashCharges <= 0) return prev;
      used = true;

      const dir = prev.nextDir;
      const head = prev.snake[0];
      let next = add(head, dir);
      next = wrapIfNeeded(next, prev);
      if (!inBounds(next, prev.gridW, prev.gridH)) return prev;
      if (prev.walls.has(key(next))) return prev;

      dashedTo = next;
      const snake = [next, ...prev.snake];
      snake.pop();
      return {
        ...prev,
        snake,
        dashCharges: prev.dashCharges - 1,
        dashIframes: Math.max(prev.dashIframes, 2),
      };
    });

    if (dashedTo) {
      addShake(1.5);
      spawnBurst(dashedTo, "rgba(190, 210, 255, 0.95)", 14);
      sfx("dash");
    } else if (used) {
      addShake(2);
      sfx("ui");
    }
  }

  function startStarterPerkDraft(nextState: GameState) {
    const d = draftUpgrades(nextState.seed, STARTER_PERKS, nextState);
    setUpgradeChoices(d.choices);
    setState({ ...nextState, seed: d.seed });
    setPhase({ kind: "startperk" });
  }

  function startNewGame() {
    setToast(null);
    setUpgradeChoices([]);
    setState((prev) => {
      const ns = initialState(prev.bestScore);
      queueMicrotask(() => startStarterPerkDraft(ns));
      return ns;
    });
    // phase set by draft
  }

  function canOfferUpgrade(s: GameState, u: UpgradeDef) {
    const stacks = s.upgradeStacks[u.id] || 0;
    if (u.consumable) return true;
    if (u.stackable) {
      const max = u.maxStacks ?? 999;
      return stacks < max;
    }
    return stacks <= 0;
  }

  function draftUpgrades(seed: number, pool: UpgradeDef[], s: GameState) {
    let ss = seed;
    const out: UpgradeDef[] = [];
    let guard = 0;

    while (out.length < 3 && guard++ < 40) {
      const sh = shuffle(ss, pool);
      ss = sh.seed;
      for (const u of sh.value) {
        if (out.length >= 3) break;
        if (out.some((x) => x.id === u.id && !u.consumable && !u.stackable)) continue;
        if (!canOfferUpgrade(s, u)) continue;
        out.push(u);
      }
    }

    return { seed: ss, choices: out.slice(0, 3) };
  }

  function endRoundAndOfferUpgrades(nextState: GameState) {
    const d = draftUpgrades(nextState.seed, UPGRADE_POOL, nextState);
    setUpgradeChoices(d.choices);
    setState({ ...nextState, seed: d.seed });
    setPhase({ kind: "upgrade" });
  }

  function applyUpgrade(u: UpgradeDef) {
    // ensure audio is allowed (first user gesture is clicking this button)
    sfx("ui");
    setToast(`${u.title}: ${u.good} / ${u.bad}`);
    setTimeout(() => setToast(null), 2200);

    setState((prev) => {
      let s2 = u.apply(prev);
      const stacks = (prev.upgradeStacks[u.id] || 0) + 1;
      s2 = { ...s2, upgradeStacks: { ...prev.upgradeStacks, [u.id]: stacks } };

      if (phaseRef.current.kind === "startperk") {
        // starter perk: begin round 1 immediately, keep round counter at 1
        return { ...s2, timeLeftMs: ROUND_MS };
      }

      // start next round
      s2 = {
        ...s2,
        round: prev.round + 1,
        timeLeftMs: ROUND_MS,
        dashCharges: s2.dashCharges, // persistent pool
      };

      // shrink arena and add walls as difficulty grows
      s2 = shrinkGridForRound(s2);

      const wallsRes = makeWallsForRound(s2, s2.seed);
      s2 = { ...s2, seed: wallsRes.seed, walls: wallsRes.value };

      // spawn poison this round based on chance
      const r = rand01(s2.seed);
      s2 = { ...s2, seed: nextSeed(s2.seed) };
      if (r < s2.poisonChance) {
        const pp = pickEmptyCell(s2, s2.seed);
        s2 = { ...s2, seed: pp.seed, poison: pp.value };
      } else {
        s2 = { ...s2, poison: null };
      }

      // refresh foods if invalid
      if (!inBounds(s2.foodA, s2.gridW, s2.gridH) || s2.walls.has(key(s2.foodA))) {
        const ff = pickEmptyCell(s2, s2.seed);
        s2 = { ...s2, seed: ff.seed, foodA: ff.value };
      }
      if (!inBounds(s2.foodB, s2.gridW, s2.gridH) || s2.walls.has(key(s2.foodB))) {
        const ff = pickEmptyCell(s2, s2.seed);
        s2 = { ...s2, seed: ff.seed, foodB: ff.value };
      }

      // rival gets a modifier every round too
      {
        const rmod = rand01(s2.seed);
        s2 = { ...s2, seed: nextSeed(s2.seed) };
        if (rmod < 0.5) {
          s2 = { ...s2, enemySpeed: s2.enemySpeed * 1.08 };
        } else {
          s2 = { ...s2, enemyGrowth: clamp(s2.enemyGrowth + 1, 1, 4) };
        }
      }

      return s2;
    });

    setPhase({ kind: "playing" });
  }

  // Main loop (single setState per frame to avoid React batching clobbering updates)
  useEffect(() => {
    if (phase.kind !== "playing") {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTRef.current = null;
      accRef.current = 0;
      return;
    }

    const step = (t: number) => {
      if (lastTRef.current == null) lastTRef.current = t;
      const dt = Math.min(50, t - lastTRef.current); // clamp
      lastTRef.current = t;

      // camera shake decay
      {
        const sh = shakeRef.current;
        if (sh.tMs > 0) {
          sh.tMs = Math.max(0, sh.tMs - dt);
          sh.power *= 0.85;
          if (sh.tMs <= 0 || sh.power < 0.1) {
            sh.tMs = 0;
            sh.power = 0;
          }
        }
      }

      // particles update (in grid-space)
      {
        const ps = particlesRef.current;
        if (ps.length) {
          const dd = dt / 1000;
          for (let i = ps.length - 1; i >= 0; i--) {
            const p = ps[i];
            p.life -= dt;
            if (p.life <= 0) {
              ps.splice(i, 1);
              continue;
            }
            p.x += p.vx * dd;
            p.y += p.vy * dd;
            p.vx *= 0.94;
            p.vy *= 0.94;
          }
        }
      }

      // poll gamepad (Xbox controller via Gamepad API)
      try {
        const gps = navigator.getGamepads?.() || [];
        const gp = gps[0];
        if (gp) {
          const axX = gp.axes?.[0] ?? 0;
          const axY = gp.axes?.[1] ?? 0;
          const dead = 0.55;
          let d: Vec | null = null;

          // dpad buttons (standard mapping)
          const up = gp.buttons?.[12]?.pressed;
          const down = gp.buttons?.[13]?.pressed;
          const left = gp.buttons?.[14]?.pressed;
          const right = gp.buttons?.[15]?.pressed;
          if (up) d = { x: 0, y: -1 };
          else if (down) d = { x: 0, y: 1 };
          else if (left) d = { x: -1, y: 0 };
          else if (right) d = { x: 1, y: 0 };
          else if (Math.abs(axX) > dead || Math.abs(axY) > dead) {
            if (Math.abs(axX) >= Math.abs(axY)) d = { x: axX > 0 ? 1 : -1, y: 0 };
            else d = { x: 0, y: axY > 0 ? 1 : -1 };
          }

          gamepadDirRef.current = d;
        } else {
          gamepadDirRef.current = null;
        }
      } catch {
        gamepadDirRef.current = null;
      }

      setState((prev) => {
        // apply gamepad direction (edge-triggered)
        let s: GameState = prev;
        const gd = gamepadDirRef.current;
        const ld = lastGamepadDirRef.current;
        const changed =
          (gd && (!ld || gd.x !== ld.x || gd.y !== ld.y)) || (!gd && ld);
        if (changed) lastGamepadDirRef.current = gd;
        if (gd && phaseRef.current.kind === "playing") {
          if (!isOpposite(gd, s.dir)) s = { ...s, nextDir: gd };
        }

        // timer
        const timeLeftMs = s.timeLeftMs - dt;
        if (timeLeftMs <= 0) {
          const s2 = { ...s, timeLeftMs: 0 };
          stateRef.current = s2;
          queueMicrotask(() => {
            if (phaseRef.current.kind === "playing") endRoundAndOfferUpgrades(s2);
          });
          return s2;
        }

        // boost-food TTL
        let boostFood = s.boostFood;
        let boostFoodTtlMs = s.boostFoodTtlMs;

        // pac-man timer
        const enemyEdibleMs = Math.max(0, s.enemyEdibleMs - dt);
        const enemySlowMs = Math.max(0, s.enemySlowMs - dt);
        if (boostFood && boostFoodTtlMs > 0) {
          boostFoodTtlMs = Math.max(0, boostFoodTtlMs - dt);
          if (boostFoodTtlMs <= 0) {
            boostFood = null;
            boostFoodTtlMs = 0;
          }
        }

        s = { ...s, timeLeftMs, boostFood, boostFoodTtlMs, enemyEdibleMs, enemySlowMs };

        // movement
        accRef.current += dt;
        const effectiveSpeed = s.speed * s.slowmoFactor;
        const stepMs = 1000 / clamp(effectiveSpeed, 3, 40);

        let acc = accRef.current;
        const maxSteps = 5;
        let steps = 0;

        while (acc >= stepMs && steps < maxSteps) {
          steps++;
          acc -= stepMs;
          tickCountRef.current++;
          s = tickSnake(s);
          if (s.timeLeftMs <= 0) break;
        }

        accRef.current = acc;
        stateRef.current = s;
        return s;
      });

      draw();
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  function wrapIfNeeded(v: Vec, s: GameState): Vec {
    if (!s.tunnelWrap) return v;
    let x = v.x;
    let y = v.y;
    if (x < 0) x = s.gridW - 1;
    if (x >= s.gridW) x = 0;
    if (y < 0) y = s.gridH - 1;
    if (y >= s.gridH) y = 0;
    return { x, y };
  }

  function nearestFood(head: Vec, a: Vec, b: Vec) {
    const da = distManhattan(head, a);
    const db = distManhattan(head, b);
    return da <= db ? { which: "A" as const, food: a } : { which: "B" as const, food: b };
  }

  function tickEnemy(s: GameState, ctx?: { playerPrevHead: Vec; enemyPrevHead: Vec; playerNext: Vec }): GameState {
    if (!s.enemyEnabled) return s;
    if (s.enemySnake.length < 2) return s;

    // Speed model: enemySpeed is cells/sec; we approximate by moving 0-2 steps per player step.
    // Also apply enemySlowMs as a temporary slow.
    const slowFactor = s.enemySlowMs > 0 ? 0.35 : 1;
    const playerSpd = clamp(s.speed * s.slowmoFactor, 3, 40);
    const enemySpd = clamp(s.enemySpeed * slowFactor, 1, 40);
    const ratio = enemySpd / playerSpd;

    // determine steps this tick (deterministic)
    let steps = 0;
    let seed = s.seed;
    const base = Math.floor(ratio);
    const frac = ratio - base;
    steps += clamp(base, 0, 2);
    if (frac > 0) {
      const r = rand01(seed);
      seed = nextSeed(seed);
      if (r < frac) steps += 1;
    }
    steps = clamp(steps, 0, 2);
    if (steps <= 0) return { ...s, seed };

    const moveOnce = (st: GameState, ctxOnce?: { playerPrevHead: Vec; enemyPrevHead: Vec; playerNext: Vec }) => {
      const head = st.enemySnake[0];
      const target = nearestFood(head, st.foodA, st.foodB).food;

      const dirs: Vec[] = [
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: -1 },
      ];

      // Greedy-ish: pick a safe move that minimizes distance to nearest food.
      let bestDir = st.enemyDir;
      let bestScore = Number.POSITIVE_INFINITY;

      for (const d of dirs) {
        if (isOpposite(d, st.enemyDir)) continue;
        let nx = add(head, d);
        nx = wrapIfNeeded(nx, st);

        if (!inBounds(nx, st.gridW, st.gridH)) continue;
        if (st.walls.has(key(nx))) continue;
        if (st.enemySnake.some((p) => eq(p, nx))) continue;
        if (st.snake.some((p) => eq(p, nx))) continue;
        if (st.poison && eq(st.poison, nx)) continue;

        const sc = distManhattan(nx, target);
        if (sc < bestScore) {
          bestScore = sc;
          bestDir = d;
        }
      }

      // if no safe move found, just keep direction (may die)
      let nx = add(head, bestDir);
      nx = wrapIfNeeded(nx, st);

      const hitWall = !inBounds(nx, st.gridW, st.gridH) || st.walls.has(key(nx));
      const hitSelf = st.enemySnake.some((p) => eq(p, nx));
      const hitPlayer = st.snake.some((p) => eq(p, nx));

      // head-on handling (only for the first enemy step this tick)
      if (ctxOnce) {
        const swap = eq(nx, ctxOnce.playerPrevHead) && eq(ctxOnce.playerNext, ctxOnce.enemyPrevHead);
        const same = eq(nx, ctxOnce.playerNext);
        if (swap || same) {
          queueMicrotask(() => setPhaseIfPlaying({ kind: "rps", your: null, ai: null }));
          return st;
        }
      }

      if (hitPlayer) {
        addShake(10);
        spawnBurst(head, "rgba(255, 80, 140, 0.95)", 42);
        sfx("death");
        queueMicrotask(() => setPhaseIfPlaying({ kind: "gameover" }));
        return st;
      }

      if (hitWall || hitSelf) {
        queueMicrotask(() => setPhaseIfPlaying({ kind: "win", winner: "you" }));
        return { ...st, enemySnake: [], enemyEnabled: false };
      }

      let enemySnake = [nx, ...st.enemySnake];

      // enemy eats food
      const ateA = eq(nx, st.foodA);
      const ateB = eq(nx, st.foodB);
      if (ateA || ateB) {
        sfx(enemyPickupSfxKind());
        const tail = enemySnake[enemySnake.length - 1];
        for (let i = 0; i < st.enemyGrowth; i++) enemySnake = [...enemySnake, { ...tail }];

        // respawn only the eaten food
        let foodA = st.foodA;
        let foodB = st.foodB;
        let ss = st.seed;
        if (ateA) {
          const ff = pickEmptyCell({ ...st, enemySnake, foodA, foodB }, ss);
          ss = ff.seed;
          foodA = ff.value;
        }
        if (ateB) {
          const ff = pickEmptyCell({ ...st, enemySnake, foodA, foodB }, ss);
          ss = ff.seed;
          foodB = ff.value;
        }

        return { ...st, seed: ss, enemySnake, enemyDir: bestDir, foodA, foodB };
      }

      // normal tail move
      enemySnake.pop();
      return { ...st, enemySnake, enemyDir: bestDir };
    };

    let out = { ...s, seed };
    for (let i = 0; i < steps; i++) {
      out = moveOnce(out, i === 0 ? ctx : undefined);
      if (!out.enemyEnabled || out.enemySnake.length < 2) break;
    }
    return out;
  }

  function tickSnake(s: GameState): GameState {
    const dir = s.nextDir;
    const head = s.snake[0];

    // magnet: pull the closer food one step toward you if within radius
    let foodA = s.foodA;
    let foodB = s.foodB;
    let seed = s.seed;

    if (s.magnetRadius > 0) {
      const da = distManhattan(head, foodA);
      const db = distManhattan(head, foodB);
      const which = da <= db ? "A" : "B";
      const food = which === "A" ? foodA : foodB;

      if (distManhattan(head, food) <= s.magnetRadius) {
        const dx = clamp(head.x - food.x, -1, 1);
        const dy = clamp(head.y - food.y, -1, 1);
        const candidate: Vec = {
          x: food.x + (Math.abs(dx) >= Math.abs(dy) ? dx : 0),
          y: food.y + (Math.abs(dy) > Math.abs(dx) ? dy : 0),
        };
        if (inBounds(candidate, s.gridW, s.gridH) && !s.walls.has(key(candidate))) {
          if (!s.snake.some((p) => eq(p, candidate)) && !s.enemySnake.some((p) => eq(p, candidate))) {
            if (which === "A") foodA = candidate;
            else foodB = candidate;
          }
        }
      }
    }

    const playerPrevHead = head;
    const enemyPrevHead = s.enemySnake[0] || { x: -999, y: -999 };

    let next = add(head, dir);
    next = wrapIfNeeded(next, s);

    const hitWall = !inBounds(next, s.gridW, s.gridH) || s.walls.has(key(next));
    const intangible = s.dashIframes > 0;
    const hitSelf = !intangible && s.snake.some((p) => eq(p, next));

    // if you run into the rival's head, treat it as a head-on clash (RPS) instead of instant death
    const enemyHead = s.enemyEnabled && s.enemySnake.length ? s.enemySnake[0] : null;
    const headClash = !intangible && enemyHead && eq(next, enemyHead);
    if (headClash) {
      queueMicrotask(() => setPhaseIfPlaying({ kind: "rps", your: null, ai: null }));
      return s;
    }

    const enemyBiteActive = s.enemyEdibleMs > 0;
    const enemyBiteIndex =
      !intangible && enemyBiteActive && s.enemyEnabled
        ? s.enemySnake.findIndex((p, i) => i > 0 && eq(p, next))
        : -1;
    const hitEnemyBody = !intangible && s.enemyEnabled && s.enemySnake.some((p, i) => i > 0 && eq(p, next));

    // decrement dash i-frames
    const dashIframes = Math.max(0, s.dashIframes - 1);

    // Pac-Man bite: if active and you collide with enemy body (not head), you cut off the tail from that segment.
    if (enemyBiteIndex > 0) {
      const eaten = s.enemySnake.length - enemyBiteIndex;
      const newEnemy = s.enemySnake.slice(0, enemyBiteIndex);

      // If you bite so close to the head that the rival would become length-1,
      // treat it as a decisive win (otherwise the AI freezes).
      if (newEnemy.length < 2) {
        addShake(8);
        spawnBurst(next, "rgba(255, 210, 90, 0.95)", 40);
        sfx("enemy_pickup");
        queueMicrotask(() => setPhaseIfPlaying({ kind: "win", winner: "you" }));
        return {
          ...s,
          seed,
          foodA,
          foodB,
          dir,
          score: s.score + eaten * 10,
        };
      }

      addShake(5);
      spawnBurst(next, "rgba(255, 210, 90, 0.95)", 28);
      sfx("enemy_pickup");

      // reward: gain segments and score proportional to eaten tail
      const gain = clamp(eaten, 1, 10);
      const tailScore = eaten * 6;

      // move player into that cell
      let snake2 = [next, ...s.snake];
      snake2 = growSnake(snake2, gain);
      // normal move unless growth covers it
      snake2.pop();

      return {
        ...s,
        seed,
        foodA,
        foodB,
        dir,
        snake: snake2,
        enemySnake: newEnemy,
        score: s.score + tailScore,
        dashIframes,
      };
    }

    if (hitWall || hitSelf || hitEnemyBody) {
      if (s.shieldCharges > 0) {
        // consume shield and "bounce" by not moving this tick
        addShake(3);
        spawnBurst(head, "rgba(120, 200, 255, 0.95)", 18);
        sfx("shield");
        return {
          ...s,
          seed,
          foodA,
          foodB,
          shieldCharges: s.shieldCharges - 1,
        };
      }
      queueMicrotask(() => setPhaseIfPlaying({ kind: "gameover" }));
      return s;
    }

    // move snake
    let snake = [next, ...s.snake];
    let score = s.score;
    let growth = 0;

    // dash i-frames already decremented above

    // check poison
    if (s.poison && eq(next, s.poison)) {
      // harsh penalty: lose segments + points
      const cut = Math.min(4, snake.length - 2);
      snake = snake.slice(0, snake.length - cut);
      score = Math.max(0, score - 30);
      addShake(6);
      spawnBurst(next, "rgba(255,140,60,0.95)", 22);
      sfx("poison");
      // respawn poison elsewhere
      const pp = pickEmptyCell({ ...s, snake, foodA, foodB }, seed);
      seed = pp.seed;
      return { ...s, seed, snake, foodA, foodB, poison: pp.value, score, dashIframes };
    }

    // rare boost food (purple)
    let boostGrowth = 0;
    if (s.boostFood && eq(next, s.boostFood)) {
      boostGrowth = 5;
      score += 5;
      addShake(4);
      spawnBurst(next, "rgba(190, 90, 255, 0.95)", 26);
      sfx("boost");
    }

    const ateA = eq(next, foodA);
    const ateB = eq(next, foodB);

    if (ateA || ateB) {
      growth += s.baseGrowth;
      score += Math.floor(10 * s.scoreMult + snake.length * 0.2);
      addShake(2);
      spawnBurst(next, "rgba(80, 255, 190, 0.95)", 16);
      sfx("eat");

      // respawn only the food that was eaten
      if (ateA) {
        const ff = pickEmptyCell({ ...s, snake, foodA, foodB }, seed);
        seed = ff.seed;
        foodA = ff.value;
      }
      if (ateB) {
        const ff = pickEmptyCell({ ...s, snake, foodA, foodB }, seed);
        seed = ff.seed;
        foodB = ff.value;
      }

      // chance to spawn a rare boost-food for a short time
      {
        const r2 = rand01(seed);
        seed = nextSeed(seed);
        if (r2 < 0.12) {
          const bf = pickEmptyCell({ ...s, snake, foodA, foodB }, seed);
          seed = bf.seed;
          // 6 seconds to grab it
          return {
            ...s,
            seed,
            snake: growSnake(snake, growth),
            foodA,
            foodB,
            boostFood: bf.value,
            boostFoodTtlMs: 6000,
            dashIframes,
            score,
          };
        }
      }

      // chance to spawn poison immediately if none exists
      if (!s.poison) {
        const r = rand01(seed);
        seed = nextSeed(seed);
        if (r < s.poisonChance * 0.5) {
          const pp = pickEmptyCell({ ...s, snake, foodA, foodB }, seed);
          seed = pp.seed;
          return {
            ...s,
            seed,
            snake: growSnake(snake, growth),
            foodA,
            foodB,
            poison: pp.value,
            boostFood: s.boostFood,
            boostFoodTtlMs: s.boostFoodTtlMs,
            dashIframes,
            score,
          };
        }
      }
    }

    // apply any rare boost
    growth += boostGrowth;

    snake = growSnake(snake, growth);

    // normal tail move if no growth
    if (growth === 0) snake.pop();

    const bestScore = Math.max(s.bestScore, score);
    if (bestScore !== s.bestScore) localStorage.setItem("lyricDoorSnake_best", String(bestScore));

    const ateBoost = s.boostFood && eq(next, s.boostFood);

    let out: GameState = {
      ...s,
      seed,
      dir,
      snake,
      foodA,
      foodB,
      score,
      bestScore,
      dashIframes,
      boostFood: ateBoost ? null : s.boostFood,
      boostFoodTtlMs: ateBoost ? 0 : s.boostFoodTtlMs,
    };

    // win condition
    if (out.snake.length >= WIN_LENGTH) {
      queueMicrotask(() => setPhaseIfPlaying({ kind: "win", winner: "you" }));
      return out;
    }

    // enemy moves after player (pass context so head-on can trigger RPS)
    out = tickEnemy(out, { playerPrevHead, enemyPrevHead, playerNext: next });
    if (out.enemySnake.length >= WIN_LENGTH) {
      queueMicrotask(() => setPhaseIfPlaying({ kind: "win", winner: "rival" }));
      return out;
    }

    return out;
  }

  function growSnake(snake: Vec[], growth: number) {
    if (growth <= 0) return snake;
    const tail = snake[snake.length - 1];
    const out = [...snake];
    for (let i = 0; i < growth; i++) out.push({ ...tail });
    return out;
  }

  function draw() {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    // size canvas to container
    const parent = c.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    // Cap DPR to keep performance reasonable (especially when window is maximized)
    // Large canvases are expensive; keep DPR low.
    const area = rect.width * rect.height;
    const dprCap = area > 900_000 ? 1.0 : 1.25;
    const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    const w = Math.floor(rect.width * dpr);
    const h = Math.floor(rect.height * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(1, 1);

    // background
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#070a14");
    g.addColorStop(1, "#100a1f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const s = stateRef.current;

    const perfScale = clamp(900_000 / Math.max(1, w * h), 0.25, 1);

    // subtle stars
    ctx.globalAlpha = 0.25 * perfScale;
    ctx.fillStyle = "#cdd6ff";
    const starCount = Math.floor(60 * perfScale);
    for (let i = 0; i < starCount; i++) {
      const x = ((s.seed + i * 977) % 1000) / 1000;
      const y = ((s.seed + i * 571) % 1000) / 1000;
      ctx.fillRect(Math.floor(x * w), Math.floor(y * h), 1, 1);
    }
    ctx.globalAlpha = 1;

    // board metrics
    const pad = 18 * dpr;
    const boardWpx = w - pad * 2;
    const boardHpx = h - pad * 2;
    const cell = Math.floor(Math.min(boardWpx / s.gridW, boardHpx / s.gridH));
    const bw = cell * s.gridW;
    const bh = cell * s.gridH;
    const ox = Math.floor((w - bw) / 2);
    const oy = Math.floor((h - bh) / 2);

    // board shake
    const sh = shakeRef.current.power;
    const shx = (Math.random() - 0.5) * sh * dpr;
    const shy = (Math.random() - 0.5) * sh * dpr;
    ctx.save();
    ctx.translate(shx, shy);

    // board frame
    ctx.strokeStyle = "rgba(190, 160, 255, 0.24)";
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(ox - 1 * dpr, oy - 1 * dpr, bw + 2 * dpr, bh + 2 * dpr);

    // fog mask
    const fogOn = s.fogRadius > 0;
    if (fogOn) {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(ox, oy, bw, bh);

      const head = s.snake[0];
      const cx = ox + (head.x + 0.5) * cell;
      const cy = oy + (head.y + 0.5) * cell;
      const r = s.fogRadius * cell;
      const rg = ctx.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
      rg.addColorStop(0, "rgba(0,0,0,0)");
      rg.addColorStop(1, "rgba(0,0,0,0.95)");

      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }

    // grid glow
    ctx.globalAlpha = 0.09;
    ctx.strokeStyle = "#bba6ff";
    ctx.lineWidth = 1;
    for (let x = 0; x <= s.gridW; x++) {
      ctx.beginPath();
      ctx.moveTo(ox + x * cell, oy);
      ctx.lineTo(ox + x * cell, oy + bh);
      ctx.stroke();
    }
    for (let y = 0; y <= s.gridH; y++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + y * cell);
      ctx.lineTo(ox + bw, oy + y * cell);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // walls
    for (const k of s.walls) {
      const [xs, ys] = k.split(",");
      const x = Number(xs);
      const y = Number(ys);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const px = ox + x * cell;
      const py = oy + y * cell;
      ctx.fillStyle = "rgba(255, 70, 220, 0.16)";
      ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
      ctx.strokeStyle = "rgba(255, 120, 240, 0.35)";
      ctx.strokeRect(px + 1, py + 1, cell - 2, cell - 2);
    }

    // food (two)
    for (const f of [s.foodA, s.foodB]) {
      const px = ox + f.x * cell;
      const py = oy + f.y * cell;
      const cx = px + cell / 2;
      const cy = py + cell / 2;

      const rg = ctx.createRadialGradient(cx, cy, 2, cx, cy, cell * 0.6);
      rg.addColorStop(0, "rgba(80, 255, 190, 1)");
      rg.addColorStop(1, "rgba(80, 255, 190, 0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.62, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#47ffb8";
      ctx.fillRect(px + cell * 0.25, py + cell * 0.25, cell * 0.5, cell * 0.5);
    }

    // rare boost food (purple) - despawns quickly
    if (s.boostFood && s.boostFoodTtlMs > 0) {
      const f = s.boostFood;
      const px = ox + f.x * cell;
      const py = oy + f.y * cell;
      const cx = px + cell / 2;
      const cy = py + cell / 2;

      const pulse = 0.35 + 0.65 * Math.abs(Math.sin((s.boostFoodTtlMs / 1000) * 3));
      const rg = ctx.createRadialGradient(cx, cy, 2, cx, cy, cell * 0.75);
      rg.addColorStop(0, `rgba(190, 90, 255, ${0.85 * pulse})`);
      rg.addColorStop(1, "rgba(190, 90, 255, 0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.72, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(220, 170, 255, ${0.9 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.22, 0, Math.PI * 2);
      ctx.stroke();
    }

    // poison
    if (s.poison) {
      const p = s.poison;
      const px = ox + p.x * cell;
      const py = oy + p.y * cell;
      const cx = px + cell / 2;
      const cy = py + cell / 2;
      const rg = ctx.createRadialGradient(cx, cy, 2, cx, cy, cell * 0.7);
      rg.addColorStop(0, "rgba(255, 120, 40, 0.9)");
      rg.addColorStop(1, "rgba(255, 120, 40, 0)");
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.72, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(255, 160, 80, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px + cell * 0.25, py + cell * 0.25);
      ctx.lineTo(px + cell * 0.75, py + cell * 0.75);
      ctx.moveTo(px + cell * 0.75, py + cell * 0.25);
      ctx.lineTo(px + cell * 0.25, py + cell * 0.75);
      ctx.stroke();
    }

    // enemy snake
    if (s.enemyEnabled && s.enemySnake.length) {
      const edible = s.enemyEdibleMs > 0;
      const flash = edible && (Math.floor((s.enemyEdibleMs / 1000) * 8) % 2 === 0);

      for (let i = s.enemySnake.length - 1; i >= 0; i--) {
        const seg = s.enemySnake[i];
        const px = ox + seg.x * cell;
        const py = oy + seg.y * cell;
        const tt = i / Math.max(1, s.enemySnake.length - 1);

        if (edible && i > 0 && flash) {
          // Pac-Man flash: body becomes bright yellow when edible (head stays normal)
          ctx.fillStyle = `rgba(255, 220, 90, 0.92)`;
        } else {
          const hue = 20 + tt * 30;
          ctx.fillStyle = `hsl(${hue} 95% 60% / 0.85)`;
        }

        const r = i === 0 ? 0.2 : 0.3;
        roundedRect(ctx, px + 1, py + 1, cell - 2, cell - 2, cell * r);
        ctx.fill();

        if (i === 0) {
          ctx.fillStyle = "rgba(10, 10, 20, 0.7)";
          const ex = px + cell * 0.35;
          const ey = py + cell * 0.35;
          ctx.beginPath();
          ctx.arc(ex, ey, cell * 0.08, 0, Math.PI * 2);
          ctx.arc(px + cell * 0.65, ey, cell * 0.08, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // player snake (customizable)
    for (let i = s.snake.length - 1; i >= 0; i--) {
      const seg = s.snake[i];
      const px = ox + seg.x * cell;
      const py = oy + seg.y * cell;
      const t = i / Math.max(1, s.snake.length - 1);

      const hue = skin.hueStart + (skin.hueEnd - skin.hueStart) * t;
      ctx.fillStyle = `hsl(${hue} ${clamp(skin.sat, 0, 100)}% ${clamp(skin.light, 0, 100)}% / ${clamp(skin.alpha, 0, 1)})`;
      const rr = i === 0 ? skin.headRound : skin.bodyRound;
      roundedRect(ctx, px + 1, py + 1, cell - 2, cell - 2, cell * clamp(rr, 0, 0.5));
      ctx.fill();

      if (i === 0 && skin.eyesOn) {
        // eyes
        ctx.fillStyle = "rgba(10, 10, 20, 0.7)";
        const ex = px + cell * 0.35;
        const ey = py + cell * 0.35;
        const eyeR = cell * 0.08 * clamp(skin.eyeSize, 0.6, 2.0);
        ctx.beginPath();
        ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
        ctx.arc(px + cell * 0.65, ey, eyeR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // particles (screen-space)
    {
      const ps = particlesRef.current;
      if (ps.length) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (const p of ps) {
          const a = Math.max(0, Math.min(1, p.life / p.maxLife));
          const px = ox + p.x * cell;
          const py = oy + p.y * cell;
          const r = Math.max(1.2 * dpr, p.size * cell);
          ctx.globalAlpha = 0.75 * a;
          const rg = ctx.createRadialGradient(px, py, 0, px, py, r * 3.2);
          rg.addColorStop(0, p.color);
          rg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = rg;
          ctx.beginPath();
          ctx.arc(px, py, r * 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // cheap bloom: blur + screen composite
    {
      ctx.save();
      const blurPx = Math.max(3, Math.floor(cell * 0.18));
      ctx.globalCompositeOperation = "screen";
      ctx.globalAlpha = clamp(skin.bloom, 0, 1) * perfScale;
      ctx.filter = `blur(${blurPx}px)`;
      ctx.drawImage(c, 0, 0);
      ctx.filter = "none";
      ctx.restore();
    }

    // vignette + subtle grain
    {
      ctx.save();
      const vg = ctx.createRadialGradient(w * 0.5, h * 0.52, Math.min(w, h) * 0.25, w * 0.5, h * 0.52, Math.min(w, h) * 0.78);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,0.55)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);

      ctx.globalAlpha = 0.05 * perfScale;
      ctx.fillStyle = "#ffffff";
      const grain = Math.floor(120 * perfScale);
      for (let i = 0; i < grain; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        ctx.fillRect(x, y, 1, 1);
      }
      ctx.restore();
    }

    // HUD removed: keep the playfield clean (no text inside the arena)

    // end shake transform
    ctx.restore();
  }

  function roundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  return (
    <div className="appRoot">
      <div className="topBar">
        <div className="title">
          <div className="name">Ultimate Snake</div>
          <div className="sub">ULTIMATE SNAKE • rounds • upgrades • pain</div>
          <div className="sub" style={{ marginTop: 6, letterSpacing: 0.04, textTransform: "none" }}>
            You {state.snake.length}/{WIN_LENGTH} • Rival {state.enemySnake.length}/{WIN_LENGTH} • Round {state.round} • Time {formatTime(state.timeLeftMs)} • Score {state.score}
          </div>
        </div>
        <div className="topControls">
          <button
            className="mini"
            onClick={() => {
              sfx("ui");
              setSettingsOpen(false);
              setControlsEditorOpen(false);
              setEditControls(false);
              setPhase({ kind: "menu" });
            }}
          >
            Menu
          </button>
          <button
            className="mini"
            onClick={() => {
                            setSfxMuted((m) => {
                const next = !m;
                setToast(next ? "SFX muted" : "SFX on");
                setTimeout(() => setToast(null), 900);
                return next;
              });
              sfx("ui");
            }}
          >
            {sfxMuted ? "Unmute SFX" : "Mute SFX"}
          </button>

          <button
            className="mini"
            onClick={() => {
              setBgmOn((x) => !x);
              sfx("ui");
            }}
          >
            {bgmOn ? "Music On" : "Music Off"}
          </button>

          {!isTauri && (
            <button
              className="mini"
              onClick={() => {
                // skip to next track
                setWebBgmTrackId((prev) => {
                  const i = webBgmTracks.findIndex((t) => t.id === prev);
                  const next = webBgmTracks[(i >= 0 ? i + 1 : 1) % webBgmTracks.length];
                  return next?.id || "track1";
                });
                sfx("ui");
              }}
            >
              Next Track
            </button>
          )}

          <label className="vol">
            <span>Music</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={bgmVolume}
              onChange={(e) => setBgmVolume(Number(e.target.value))}
            />
          </label>

          <label className="vol">
            <span>SFX</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={sfxVolume}
              onChange={(e) => setSfxVolume(Number(e.target.value))}
              onPointerDown={() => {
                sfx("ui");
              }}
            />
          </label>

          {/* Test SFX button removed for production */}
        </div>

        <div className="hint">
          <div>
            <span className="kbd">WASD</span>/<span className="kbd">Arrows</span> move
          </div>
          <div>
            <span className="kbd">Space</span> dash (if you have it) • <span className="kbd">Enter</span> start
          </div>
        </div>
      </div>

      <div className="stage">
        <canvas
          ref={canvasRef}
          className="gameCanvas"
          tabIndex={0}
          onPointerDown={(e) => {
            canvasRef.current?.focus();
            sfx("ui");

            // swipe tracking
            const t = swipeRef.current;
            t.active = true;
            t.x = e.clientX;
            t.y = e.clientY;
          }}
          onPointerMove={(e) => {
            const t = swipeRef.current;
            if (!t.active) return;
            const dx = e.clientX - t.x;
            const dy = e.clientY - t.y;
            const adx = Math.abs(dx);
            const ady = Math.abs(dy);
            const thresh = 18;
            if (adx < thresh && ady < thresh) return;

            // lock to dominant axis
            if (adx >= ady) {
              queueDir({ x: dx > 0 ? 1 : -1, y: 0 });
            } else {
              queueDir({ x: 0, y: dy > 0 ? 1 : -1 });
            }

            // reset so you can chain fast turns
            t.x = e.clientX;
            t.y = e.clientY;
          }}
          onPointerUp={() => {
            swipeRef.current.active = false;
          }}
          onPointerCancel={() => {
            swipeRef.current.active = false;
          }}
        />

        {toast && <div className="toast">{toast}</div>}

        {phase.kind === "menu" && (
          <div className="landing">
            <img className="landingImg" src={(import.meta as any).env?.BASE_URL + "ui-landing.jpg"} alt="Ultimate Snake" />

            {/* Invisible click zones matching the art */}
            <button
              className="landingHotspot start"
              aria-label="Start Game"
              onClick={() => {
                sfx("ui");
                startNewGame();
              }}
            />
            <button
              className="landingHotspot settings"
              aria-label="Settings"
              onClick={() => {
                sfx("ui");
                setSettingsOpen(true);
              }}
            />
          </div>
        )}

        {settingsOpen && (
          <div className="overlay" onPointerDown={() => {}}>
            <div className="panel">
              <h2>Settings</h2>
              <div className="grid2">
                <div className="stat">
                  <div className="label">Best</div>
                  <div className="value">{state.bestScore}</div>
                </div>
                <div className="stat">
                  <div className="label">Mobile</div>
                  <div className="value">Swipe to turn</div>
                </div>
              </div>

              {/* Live preview */}
              <div className="stat" style={{ marginTop: 10 }}>
                <div className="label">Snake preview</div>
                <div className="value" style={{ marginTop: 8 }}>
                  <canvas className="skinPreview" ref={skinPreviewRef} width={560} height={120} />
                </div>
              </div>

              <div className="stat" style={{ marginTop: 10 }}>
                <div className="label">Touch controls</div>
                <div className="value" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ opacity: 0.85 }}>Drag controls to reposition</span>
                  <button
                    className={"pill" + (editControls ? " primary" : "")}
                    onClick={() => {
                      // open in-settings control editor (mock playfield)
                      setEditControls(true);
                      setControlsEditorOpen(true);
                    }}
                  >
                    Move Controls
                  </button>
                </div>
                <div className="fine" style={{ marginTop: 6 }}>
                  Tip: while editing, drag the D-pad by its empty area. Drag USE by grabbing the button.
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <div className="fine" style={{ marginBottom: 6 }}>
                  Presets
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {SKIN_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className={"pill" + (skin.presetId === p.id ? " primary" : "")}
                      onClick={() => setSkin({ ...p.skin })}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <details style={{ marginTop: 12 }}>
                <summary style={{ cursor: "pointer" }}>Advanced</summary>
                <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                  <label className="vol">
                    <span>Hue start</span>
                    <input type="range" min={0} max={360} step={1} value={skin.hueStart} onChange={(e) => setSkin((s) => ({ ...s, presetId: "custom", hueStart: Number(e.target.value) }))} />
                  </label>
                  <label className="vol">
                    <span>Hue end</span>
                    <input type="range" min={0} max={360} step={1} value={skin.hueEnd} onChange={(e) => setSkin((s) => ({ ...s, presetId: "custom", hueEnd: Number(e.target.value) }))} />
                  </label>
                  <label className="vol">
                    <span>Saturation</span>
                    <input type="range" min={0} max={100} step={1} value={skin.sat} onChange={(e) => setSkin((s) => ({ ...s, presetId: "custom", sat: Number(e.target.value) }))} />
                  </label>
                  <label className="vol">
                    <span>Light</span>
                    <input type="range" min={20} max={85} step={1} value={skin.light} onChange={(e) => setSkin((s) => ({ ...s, presetId: "custom", light: Number(e.target.value) }))} />
                  </label>
                  <label className="vol">
                    <span>Glow</span>
                    <input type="range" min={0} max={1} step={0.05} value={skin.bloom} onChange={(e) => setSkin((s) => ({ ...s, presetId: "custom", bloom: Number(e.target.value) }))} />
                  </label>
                  <label className="vol">
                    <span>Eyes</span>
                    <input type="checkbox" checked={skin.eyesOn} onChange={(e) => setSkin((s) => ({ ...s, presetId: "custom", eyesOn: e.target.checked }))} />
                  </label>
                  <label className="vol">
                    <span>Eye size</span>
                    <input type="range" min={0.6} max={2} step={0.1} value={skin.eyeSize} onChange={(e) => setSkin((s) => ({ ...s, presetId: "custom", eyeSize: Number(e.target.value) }))} />
                  </label>
                </div>
              </details>

              {!isTauri && (
                <div style={{ marginTop: 12 }}>
                  <div className="fine" style={{ marginBottom: 6 }}>
                    Background music track
                  </div>
                  <select
                    value={webBgmTrackId}
                    onChange={(e) => setWebBgmTrackId(e.target.value)}
                    style={{ width: "100%", padding: "10px 12px", borderRadius: 12 }}
                  >
                    {webBgmTracks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <button
                className="primary"
                onClick={() => {
                  setSettingsOpen(false);
                  setControlsEditorOpen(false);
                  setEditControls(false);
                }}
              >
                Done
              </button>
            </div>
          </div>
        )}

        {phase.kind === "startperk" && (
          <div className="overlay">
            <div className="panel wide">
              <h2>Choose your starting perk</h2>
              <p>Pick 1 perk to define your run. (Every perk still has a downside.)</p>
              <div className="fine">Use <b>←/→</b> or <b>1/2/3</b>, then <b>Enter</b>.</div>
              <div className="cards">
                {upgradeChoices.map((u, idx) => (
                  <button
                    key={u.id}
                    className={"card" + (idx === overlayIndex ? " selected" : "")}
                    onClick={() => {
                      applyUpgrade(u);
                      setPhase({ kind: "playing" });
                    }}
                  >
                    <div className="cardTitle">{u.title}</div>
                    <div className="cardGood">{u.good}</div>
                    <div className="cardBad">{u.bad}</div>
                  </button>
                ))}
              </div>
              <div className="fine">Tip: You can always pivot your build after Round 1.</div>
            </div>
          </div>
        )}

        {phase.kind === "upgrade" && (
          <div className="overlay">
            <div className="panel wide">
              <h2>Round {state.round} complete</h2>
              <p>Choose 1 upgrade. Each one comes with a modifier that hurts.</p>
              <div className="fine">Use <b>←/→</b> or <b>1/2/3</b>, then <b>Enter</b>.</div>
              <div className="cards">
                {upgradeChoices.map((u, idx) => (
                  <button key={u.id} className={"card" + (idx === overlayIndex ? " selected" : "")} onClick={() => applyUpgrade(u)}>
                    <div className="cardTitle">{u.title}</div>
                    <div className="cardGood">{u.good}</div>
                    <div className="cardBad">{u.bad}</div>
                  </button>
                ))}
              </div>
              <div className="fine">Tip: Sometimes a “worse” upgrade now is a better long-term build.</div>
            </div>
          </div>
        )}

        {phase.kind === "paused" && (
          <div className="overlay">
            <div className="panel">
              <h2>Paused</h2>
              <p>Press <b>Enter</b> to resume, or <b>Esc</b> for menu.</p>
              <button className="primary" onClick={() => setPhase({ kind: "playing" })}>
                Resume (Enter)
              </button>
              <button className="secondary" onClick={() => setPhase({ kind: "menu" })}>
                Menu (Esc)
              </button>
            </div>
          </div>
        )}

        {phase.kind === "gameover" && (
          <div className="overlay">
            <div className="panel">
              <h2>Game Over</h2>
              <p>
                Score <b>{state.score}</b> • Best <b>{state.bestScore}</b> • Round <b>{state.round}</b>
              </p>
              <button className="primary" onClick={startNewGame}>
                Run it back (Enter)
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setPhase({ kind: "menu" });
                }}
              >
                Menu
              </button>
            </div>
          </div>
        )}

        {phase.kind === "rps" && (
          <div className="overlay">
            <div className="panel">
              <h2>Head-on Clash</h2>
              <p>
                Pick one: <b>← Rock</b> • <b>↑ Paper</b> • <b>→ Scissors</b> • <b>Enter</b> to lock.
              </p>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 12, flexWrap: "wrap" }}>
                <button
                  className={"pill" + (phase.your === "rock" ? " primary" : "")}
                  onClick={() => setPhase((p) => (p.kind === "rps" ? { ...p, your: "rock" } : p))}
                >
                  Rock
                </button>
                <button
                  className={"pill" + (phase.your === "paper" ? " primary" : "")}
                  onClick={() => setPhase((p) => (p.kind === "rps" ? { ...p, your: "paper" } : p))}
                >
                  Paper
                </button>
                <button
                  className={"pill" + (phase.your === "scissors" ? " primary" : "")}
                  onClick={() => setPhase((p) => (p.kind === "rps" ? { ...p, your: "scissors" } : p))}
                >
                  Scissors
                </button>
              </div>
              <button className="primary" style={{ marginTop: 12 }} onClick={lockInRps} disabled={!phase.your}>
                Lock In
              </button>
              <div className="fine" style={{ marginTop: 10 }}>
                If you win: instant victory. If you lose: game over. Tie: both snakes reposition and the run continues.
              </div>
            </div>
          </div>
        )}

        {phase.kind === "rpsResult" && (
          <div className="overlay">
            <div className="panel">
              <h2>Clash Result</h2>
              <p>
                You: <b>{phase.your}</b> • Rival: <b>{phase.ai}</b>
              </p>
              <p style={{ fontSize: 18 }}>
                Outcome: <b>{phase.res.toUpperCase()}</b>
              </p>
              <button
                className="primary"
                onClick={() => {
                  sfx("ui");
                  if (phase.res === "win") setPhase({ kind: "win", winner: "you" });
                  else if (phase.res === "lose") setPhase({ kind: "gameover" });
                  else setPhase({ kind: "playing" });
                }}
              >
                Continue (Enter)
              </button>
              <div className="fine">Press Enter to continue.</div>
            </div>
          </div>
        )}

        {phase.kind === "win" && (
          <div className="overlay">
            <div className="panel">
              <h2>{phase.winner === "you" ? "You Win" : "Rival Wins"}</h2>
              <p>
                Goal: first to <b>{WIN_LENGTH}</b> length.
              </p>
              <p>
                You: <b>{state.snake.length}</b> • Rival: <b>{state.enemySnake.length}</b>
              </p>
              <button className="primary" onClick={startNewGame}>
                Rematch (Enter)
              </button>
              <button
                className="secondary"
                onClick={() => {
                  setPhase({ kind: "menu" });
                }}
              >
                Menu
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="bottomBar">
        <div className="pill">Round: 15s</div>
        <div className="pill">Food: green</div>
        <div className="pill">Poison: orange ✕</div>
        <div className="pill">Walls: pink blocks</div>
      </div>


      {settingsOpen && controlsEditorOpen && (
        <div className="overlay" style={{ zIndex: 400 }}>
          <div className="panel wide">
            <h2>Move Controls</h2>
            <div className="fine">Drag the controls where you want them. This is a mock playfield preview.</div>
            <div className="controlsMockStage">
              <div className="controlsMockBoard" />
              <div className="controlsMockHud">
                <div className="pill">Round: 15s</div>
                <div className="pill">Food: green</div>
                <div className="pill">Poison: orange ×</div>
                <div className="pill">Walls: pink blocks</div>
              </div>

              {/* USE mock */}
              <button
                className={"useBtn edit"}
                style={{
                  left: controlPos.useLeft,
                  bottom: "calc(" + controlPos.useBottom + "px + env(safe-area-inset-bottom, 0px))",
                  transform: `scale(${controlPos.useScale})`,
                  transformOrigin: "left bottom",
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  dragRef.current = {
                    kind: "use",
                    startX: e.clientX,
                    startY: e.clientY,
                    startLeft: controlPos.useLeft,
                    startBottom: controlPos.useBottom,
                  };
                  (e.currentTarget as any).setPointerCapture?.(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = dragRef.current;
                  if (!d || d.kind !== "use") return;
                  e.preventDefault();
                  const dx = e.clientX - d.startX;
                  const dy = e.clientY - d.startY;
                  setControlPos((p) => ({
                    ...p,
                    useLeft: clamp((d.startLeft ?? p.useLeft) + dx, 0, window.innerWidth - 60),
                    useBottom: clamp((d.startBottom ?? p.useBottom) - dy, 0, window.innerHeight - 60),
                  }));
                }}
                onPointerUp={() => {
                  dragRef.current = null;
                }}
                onPointerCancel={() => {
                  dragRef.current = null;
                }}
              >
                USE
              </button>

              {/* D-pad mock */}
              <div
                className={"touchPad edit"}
                style={{
                  right: controlPos.touchPadRight,
                  bottom: "calc(" + controlPos.touchPadBottom + "px + env(safe-area-inset-bottom, 0px))",
                  transform: `scale(${controlPos.touchPadScale})`,
                  transformOrigin: "right bottom",
                }}
                onPointerDown={(e) => {
                  const target = e.target as HTMLElement;
                  if (target && target.tagName === "BUTTON") return;
                  e.preventDefault();
                  dragRef.current = {
                    kind: "touchPad",
                    startX: e.clientX,
                    startY: e.clientY,
                    startRight: controlPos.touchPadRight,
                    startBottom: controlPos.touchPadBottom,
                  };
                  (e.currentTarget as any).setPointerCapture?.(e.pointerId);
                }}
                onPointerMove={(e) => {
                  const d = dragRef.current;
                  if (!d || d.kind !== "touchPad") return;
                  e.preventDefault();
                  const dx = e.clientX - d.startX;
                  const dy = e.clientY - d.startY;
                  setControlPos((p) => ({
                    ...p,
                    touchPadRight: clamp((d.startRight ?? p.touchPadRight) - dx, 0, window.innerWidth - 120),
                    touchPadBottom: clamp((d.startBottom ?? p.touchPadBottom) - dy, 0, window.innerHeight - 120),
                  }));
                }}
                onPointerUp={() => {
                  dragRef.current = null;
                }}
                onPointerCancel={() => {
                  dragRef.current = null;
                }}
              >
                <div />
                <button className="pill" onPointerDown={(e) => e.preventDefault()}>
                  ↑
                </button>
                <div />
                <button className="pill" onPointerDown={(e) => e.preventDefault()}>
                  ←
                </button>
                <button className="pill" onPointerDown={(e) => e.preventDefault()}>
                  ↓
                </button>
                <button className="pill" onPointerDown={(e) => e.preventDefault()}>
                  →
                </button>
                <div style={{ gridColumn: "1 / span 3", textAlign: "center", fontSize: 11, opacity: 0.8 }}>
                  Drag the pad (empty area)
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
              <div className="stat">
                <div className="label">Resize</div>
                <div className="value" style={{ display: "grid", gap: 10 }}>
                  <label className="vol">
                    <span>D-pad size</span>
                    <input
                      type="range"
                      min={0.7}
                      max={1.6}
                      step={0.05}
                      value={controlPos.touchPadScale}
                      onChange={(e) => setControlPos((p) => ({ ...p, touchPadScale: Number(e.target.value) }))}
                    />
                  </label>
                  <label className="vol">
                    <span>USE size</span>
                    <input
                      type="range"
                      min={0.7}
                      max={1.6}
                      step={0.05}
                      value={controlPos.useScale}
                      onChange={(e) => setControlPos((p) => ({ ...p, useScale: Number(e.target.value) }))}
                    />
                  </label>
                </div>
              </div>

              <button
                className="primary"
                onClick={() => {
                  setControlsEditorOpen(false);
                  setEditControls(false);
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {phase.kind === "playing" && (
        <>
          {state.inventory && state.inventory.charges > 0 && (
            <button
              className={"useBtn" + (editControls ? " edit" : "")}
              style={{
                left: controlPos.useLeft,
                bottom: `calc(${controlPos.useBottom}px + env(safe-area-inset-bottom, 0px))`,
                transform: `scale(${controlPos.useScale})`,
                transformOrigin: "left bottom",
              }}
              onPointerDown={(e) => {
                if (editControls) {
                  e.preventDefault();
                  dragRef.current = {
                    kind: "use",
                    startX: e.clientX,
                    startY: e.clientY,
                    startLeft: controlPos.useLeft,
                    startBottom: controlPos.useBottom,
                  };
                  (e.currentTarget as any).setPointerCapture?.(e.pointerId);
                  return;
                }
                e.preventDefault();
                useActive();
              }}
              onPointerMove={(e) => {
                const d = dragRef.current;
                if (!d || d.kind !== "use") return;
                e.preventDefault();
                const dx = e.clientX - d.startX;
                const dy = e.clientY - d.startY;
                setControlPos((p) => ({
                  ...p,
                  useLeft: clamp((d.startLeft ?? p.useLeft) + dx, 0, window.innerWidth - 60),
                  useBottom: clamp((d.startBottom ?? p.useBottom) - dy, 0, window.innerHeight - 60),
                }));
              }}
              onPointerUp={() => {
                dragRef.current = null;
              }}
              onPointerCancel={() => {
                dragRef.current = null;
              }}
            >
              USE
            </button>
          )}

          <div
            className={"touchPad" + (editControls ? " edit" : "")}
            style={{
              right: controlPos.touchPadRight,
              bottom: `calc(${controlPos.touchPadBottom}px + env(safe-area-inset-bottom, 0px))`,
              transform: `scale(${controlPos.touchPadScale})`,
              transformOrigin: "right bottom",
            }}
            onPointerDown={(e) => {
              if (!editControls) return;
              // only start dragging when touching empty area (not buttons)
              const target = e.target as HTMLElement;
              if (target && target.tagName === "BUTTON") return;
              e.preventDefault();
              dragRef.current = {
                kind: "touchPad",
                startX: e.clientX,
                startY: e.clientY,
                startRight: controlPos.touchPadRight,
                startBottom: controlPos.touchPadBottom,
              };
              (e.currentTarget as any).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d || d.kind !== "touchPad") return;
              e.preventDefault();
              const dx = e.clientX - d.startX;
              const dy = e.clientY - d.startY;
              setControlPos((p) => ({
                ...p,
                touchPadRight: clamp((d.startRight ?? p.touchPadRight) - dx, 0, window.innerWidth - 120),
                touchPadBottom: clamp((d.startBottom ?? p.touchPadBottom) - dy, 0, window.innerHeight - 120),
              }));
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
            onPointerCancel={() => {
              dragRef.current = null;
            }}
          >
          <div />
          <button
            className="pill"
            onPointerDown={(e) => {
              e.preventDefault();
              queueDir({ x: 0, y: -1 });
            }}
          >
            ↑
          </button>
          <div />
          <button
            className="pill"
            onPointerDown={(e) => {
              e.preventDefault();
              queueDir({ x: -1, y: 0 });
            }}
          >
            ←
          </button>
          <button
            className="pill"
            onPointerDown={(e) => {
              e.preventDefault();
              queueDir({ x: 0, y: 1 });
            }}
          >
            ↓
          </button>
          <button
            className="pill"
            onPointerDown={(e) => {
              e.preventDefault();
              queueDir({ x: 1, y: 0 });
            }}
          >
            →
          </button>
          <div style={{ gridColumn: "1 / span 3", textAlign: "center", fontSize: 11, opacity: 0.8 }}>
            Tap or swipe to turn
          </div>
          </div>
        </>
      )}

      {/* keep a tiny element so Vite/React has a stable root */}
      <div style={{ height: cellSize, opacity: 0 }} />
    </div>
  );
}

export default App;
