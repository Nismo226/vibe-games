import { useEffect, useMemo, useRef, useState } from "react";

// ARC//BREAKER — feel prototype (portrait, one-hand)
// Goals for v0:
// - responsive one-thumb paddle control (direct drag with smoothing)
// - deterministic ball physics + brick collision
// - keep ball readable (glow + trail stub)

type Brick = { x: number; y: number; hp: number };

type Particle = { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; r: number; color: string };

type PowerUpKind = "dmg" | "missiles" | "laser" | "multiball" | "wide";

type PowerUp = { kind: PowerUpKind; x: number; y: number; vy: number; ttl: number };

type Missile = { x: number; y: number; vy: number; ttl: number };

type Effects = {
  dmgMult: number;
  dmgMs: number;
  missilesMs: number;
  missileCooldownMs: number;
  laserMs: number;
  multiballMs: number;
  wideMs: number;
};

type AudioState = {
  ctx: AudioContext;
  master: GainNode;
};

type TouchState = {
  id: number;
  x: number; // css px
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export function ArcBreaker() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 390, h: 844 });

  // touch control
  const touchRef = useRef<TouchState | null>(null);
  const targetXRef = useRef<number | null>(null);

  // sim state (refs so we can run in rAF)
  const paddleRef = useRef({ x: 0.5, w: 0.22 }); // normalized 0..1, width as fraction of arena width
  const ballRef = useRef({ x: 0.5, y: 0.72, vx: 0.25, vy: -0.55, r: 0.018 });
  const bricksRef = useRef<Brick[]>([]);
  const scoreRef = useRef(0);

  // juice + powerups
  const particlesRef = useRef<Particle[]>([]);
  const trailRef = useRef<{ x: number; y: number; life: number }[]>([]);
  const powerUpsRef = useRef<PowerUp[]>([]);
  const missilesRef = useRef<Missile[]>([]);
  const effectsRef = useRef<Effects>({
    dmgMult: 1,
    dmgMs: 0,
    missilesMs: 0,
    missileCooldownMs: 0,
    laserMs: 0,
    multiballMs: 0,
    wideMs: 0,
  });
  const screenShakeRef = useRef(0);
  const audioRef = useRef<AudioState | null>(null);

  // boss scaffolding (end-of-run)
  const bossRef = useRef<{
    active: boolean;
    phase: 0 | 1 | 2 | 3;
    coreHp: number;
    vulnMs: number; // remaining vulnerable window
    parts: { kind: "anchor" | "core"; x: number; y: number; w: number; h: number; hp: number }[];
  }>({ active: false, phase: 0, coreHp: 0, vulnMs: 0, parts: [] });

  const dpr = typeof window !== "undefined" ? Math.max(1, Math.min(3, window.devicePixelRatio || 1)) : 1;

  const layout = useMemo(() => {
    const w = size.w;
    const h = size.h;

    // portrait-first playfield with room for top HUD + bottom thumb zone
    const pad = Math.round(w * 0.06);
    const hudH = Math.round(h * 0.12);
    const controlZoneH = Math.round(h * 0.28);
    const arena = {
      x: pad,
      y: hudH,
      w: w - pad * 2,
      h: h - hudH - controlZoneH - pad,
    };

    const controlZone = {
      x: 0,
      y: h - controlZoneH,
      w,
      h: controlZoneH,
    };

    return { arena, hudH, controlZone, pad };
  }, [size]);

  function reset() {
    paddleRef.current = { x: 0.5, w: 0.22 };
    ballRef.current = { x: 0.5, y: 0.72, vx: 0.26, vy: -0.58, r: 0.018 };
    scoreRef.current = 0;

    particlesRef.current = [];
    trailRef.current = [];
    powerUpsRef.current = [];
    missilesRef.current = [];
    effectsRef.current = {
      dmgMult: 1,
      dmgMs: 0,
      missilesMs: 0,
      missileCooldownMs: 0,
      laserMs: 0,
      multiballMs: 0,
      wideMs: 0,
    };
    screenShakeRef.current = 0;

    bossRef.current = { active: false, phase: 0, coreHp: 0, vulnMs: 0, parts: [] };

    const bricks: Brick[] = [];
    const cols = 9;
    const rows = 6;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        bricks.push({ x, y, hp: 1 + (y >= 3 ? 1 : 0) });
      }
    }
    bricksRef.current = bricks;
  }

  function startBoss() {
    // Warden Prism (first end-of-run boss): break anchors → expose core windows → finish.
    paddleRef.current = { x: 0.5, w: 0.22 };
    ballRef.current = { x: 0.5, y: 0.78, vx: 0.22, vy: -0.62, r: 0.018 };
    scoreRef.current = 0;

    particlesRef.current = [];
    trailRef.current = [];
    powerUpsRef.current = [];
    missilesRef.current = [];
    effectsRef.current = {
      dmgMult: 1,
      dmgMs: 0,
      missilesMs: 0,
      missileCooldownMs: 0,
      laserMs: 0,
      multiballMs: 0,
      wideMs: 0,
    };
    screenShakeRef.current = 0;

    // clear stage bricks for boss arena
    bricksRef.current = [];

    const parts = [
      { kind: "anchor" as const, x: 0.12, y: 0.14, w: 0.14, h: 0.07, hp: 6 },
      { kind: "anchor" as const, x: 0.74, y: 0.14, w: 0.14, h: 0.07, hp: 6 },
      { kind: "anchor" as const, x: 0.12, y: 0.26, w: 0.14, h: 0.07, hp: 6 },
      { kind: "anchor" as const, x: 0.74, y: 0.26, w: 0.14, h: 0.07, hp: 6 },
      { kind: "core" as const, x: 0.38, y: 0.18, w: 0.24, h: 0.18, hp: 36 },
    ];

    bossRef.current = {
      active: true,
      phase: 1,
      coreHp: 36,
      vulnMs: 0,
      parts,
    };
  }

  useEffect(() => {
    reset();
  }, []);

  useEffect(() => {
    function onResize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setSize({ w, h });
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // resize backing store
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    canvas.width = Math.floor(size.w * dpr);
    canvas.height = Math.floor(size.h * dpr);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sfx = (kind: "hit" | "break" | "power" | "laser") => {
      const a = audioRef.current;
      if (!a) return;
      const t = a.ctx.currentTime;
      const o = a.ctx.createOscillator();
      const g = a.ctx.createGain();
      o.type = kind === "laser" ? "sawtooth" : "triangle";
      const f =
        kind === "hit" ? 520 : kind === "break" ? 240 : kind === "power" ? 740 : 160;
      o.frequency.setValueAtTime(f, t);
      o.frequency.exponentialRampToValueAtTime(f * (kind === "break" ? 0.55 : 1.35), t + 0.08);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(kind === "laser" ? 0.06 : 0.12, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === "laser" ? 0.12 : 0.09));
      o.connect(g);
      g.connect(a.master);
      o.start(t);
      o.stop(t + (kind === "laser" ? 0.13 : 0.1));
    };

    let raf = 0;
    let last = performance.now();

    const step = (now: number) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;

      // control: smooth paddle toward target
      const targetX = targetXRef.current;
      if (targetX != null) {
        const { arena } = layout;
        const nx = clamp((targetX - arena.x) / arena.w, 0, 1);

        const p = paddleRef.current;
        // AAA-ish feel: critically damped-ish smoothing + max speed
        const maxSpeed = 2.2; // normalized units/sec
        const accel = 18;
        const dx = nx - p.x;
        const desiredV = clamp(dx * accel, -maxSpeed, maxSpeed);
        p.x += desiredV * dt;
        p.x = clamp(p.x, 0, 1);
      }

      // timers + effects
      const fx = effectsRef.current;
      fx.dmgMs = Math.max(0, fx.dmgMs - dt * 1000);
      fx.missilesMs = Math.max(0, fx.missilesMs - dt * 1000);
      fx.laserMs = Math.max(0, fx.laserMs - dt * 1000);
      fx.multiballMs = Math.max(0, fx.multiballMs - dt * 1000);
      fx.wideMs = Math.max(0, fx.wideMs - dt * 1000);
      fx.missileCooldownMs = Math.max(0, fx.missileCooldownMs - dt * 1000);
      if (fx.dmgMs <= 0) fx.dmgMult = 1;

      // widen paddle if active
      paddleRef.current.w = fx.wideMs > 0 ? 0.30 : 0.22;

      // missiles spawn
      if (fx.missilesMs > 0 && fx.missileCooldownMs <= 0) {
        fx.missileCooldownMs = 220;
        missilesRef.current.push({ x: paddleRef.current.x, y: 0.92, vy: -1.35, ttl: 1600 });
        sfx("power");
      }

      // update missiles
      for (let i = 0; i < missilesRef.current.length; i++) {
        const m = missilesRef.current[i];
        m.y += m.vy * dt;
        m.ttl -= dt * 1000;
        if (m.ttl <= 0 || m.y < -0.1) {
          missilesRef.current.splice(i, 1);
          i--;
        }
      }

      // update particles
      for (let i = 0; i < particlesRef.current.length; i++) {
        const pt = particlesRef.current[i];
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
        pt.life -= dt * 1000;
        if (pt.life <= 0) {
          particlesRef.current.splice(i, 1);
          i--;
        }
      }

      // update powerups
      for (let i = 0; i < powerUpsRef.current.length; i++) {
        const pu = powerUpsRef.current[i];
        pu.y += pu.vy * dt;
        pu.ttl -= dt * 1000;
        if (pu.ttl <= 0 || pu.y > 1.15) {
          powerUpsRef.current.splice(i, 1);
          i--;
        }
      }

      // update trail (ball afterimages)
      for (let i = 0; i < trailRef.current.length; i++) {
        trailRef.current[i].life -= dt * 1000;
        if (trailRef.current[i].life <= 0) {
          trailRef.current.splice(i, 1);
          i--;
        }
      }

      // sim
      const b = ballRef.current;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      trailRef.current.push({ x: b.x, y: b.y, life: 180 });
      if (trailRef.current.length > 22) trailRef.current.shift();

      // walls
      if (b.x - b.r < 0) {
        b.x = b.r;
        b.vx *= -1;
      }
      if (b.x + b.r > 1) {
        b.x = 1 - b.r;
        b.vx *= -1;
      }
      if (b.y - b.r < 0) {
        b.y = b.r;
        b.vy *= -1;
      }

      // paddle
      const p = paddleRef.current;
      const paddleY = 0.93;
      const px0 = p.x - p.w / 2;
      const px1 = p.x + p.w / 2;
      const py0 = paddleY - 0.018;
      const py1 = paddleY + 0.018;
      if (b.vy > 0 && b.y + b.r >= py0 && b.y - b.r <= py1 && b.x >= px0 && b.x <= px1) {
        b.y = py0 - b.r;

        // reflect with controlled “english” based on hit position
        const t = (b.x - p.x) / (p.w / 2);
        const english = clamp(t, -1, 1);
        const speed = Math.max(0.35, Math.hypot(b.vx, b.vy));
        b.vy = -Math.abs(b.vy);
        b.vx = clamp(b.vx + english * 0.35, -0.85, 0.85);
        const ns = Math.hypot(b.vx, b.vy);
        b.vx = (b.vx / ns) * speed;
        b.vy = (b.vy / ns) * speed;
      }

      // bricks (simple AABB in normalized space)
      const bricks = bricksRef.current;
      if (bricks.length) {
        const cols = 9;
        const bxPad = 0.06;
        const top = 0.08;
        const areaW = 1 - bxPad * 2;
        const cellW = areaW / cols;
        const cellH = 0.045;
        for (let i = 0; i < bricks.length; i++) {
          const br = bricks[i];
          const x0 = bxPad + br.x * cellW + 0.004;
          const x1 = bxPad + (br.x + 1) * cellW - 0.004;
          const y0 = top + br.y * cellH + 0.004;
          const y1 = top + (br.y + 1) * cellH - 0.004;

          // circle vs AABB
          const cx = clamp(b.x, x0, x1);
          const cy = clamp(b.y, y0, y1);
          const dx = b.x - cx;
          const dy = b.y - cy;
          if (dx * dx + dy * dy <= b.r * b.r) {
            // basic normal
            if (Math.abs(dx) > Math.abs(dy)) b.vx *= -1;
            else b.vy *= -1;

            const dmg = Math.max(1, Math.round(effectsRef.current.dmgMult));
            br.hp -= dmg;
            scoreRef.current += 10;

            // hit juice
            screenShakeRef.current = Math.max(screenShakeRef.current, 0.6);
            sfx("hit");
            for (let k = 0; k < 8; k++) {
              const a = Math.random() * Math.PI * 2;
              const sp = 0.35 + Math.random() * 0.55;
              particlesRef.current.push({
                x: (x0 + x1) * 0.5,
                y: (y0 + y1) * 0.5,
                vx: Math.cos(a) * sp,
                vy: Math.sin(a) * sp,
                life: 240 + Math.random() * 180,
                maxLife: 400,
                r: 0.006 + Math.random() * 0.006,
                color: br.hp >= 2 ? "rgba(255,150,90,0.9)" : "rgba(80,220,255,0.9)",
              });
            }

            if (br.hp <= 0) {
              // chance to drop powerup
              if (Math.random() < 0.22) {
                const roll = Math.random();
                const kind: PowerUpKind =
                  roll < 0.26
                    ? "dmg"
                    : roll < 0.48
                      ? "missiles"
                      : roll < 0.62
                        ? "laser"
                        : roll < 0.78
                          ? "wide"
                          : "multiball";
                powerUpsRef.current.push({ kind, x: (x0 + x1) * 0.5, y: (y0 + y1) * 0.5, vy: 0.55, ttl: 9000 });
                sfx("break");
              } else {
                sfx("break");
              }
              bricks.splice(i, 1);
              i--;
            }
            break;
          }
        }
      }

      // paddle catches powerups
      {
        const p = paddleRef.current;
        const paddleY = 0.93;
        const px0 = p.x - p.w / 2;
        const px1 = p.x + p.w / 2;
        const catchY0 = paddleY - 0.05;
        const catchY1 = paddleY + 0.03;
        for (let i = 0; i < powerUpsRef.current.length; i++) {
          const pu = powerUpsRef.current[i];
          if (pu.y >= catchY0 && pu.y <= catchY1 && pu.x >= px0 && pu.x <= px1) {
            // apply
            if (pu.kind === "dmg") {
              fx.dmgMult = 2;
              fx.dmgMs = 10_000;
            } else if (pu.kind === "missiles") {
              fx.missilesMs = 10_000;
            } else if (pu.kind === "laser") {
              fx.laserMs = 5_000;
              sfx("laser");
            } else if (pu.kind === "wide") {
              fx.wideMs = 12_000;
            } else if (pu.kind === "multiball") {
              fx.multiballMs = 8_000;
            }
            sfx("power");
            powerUpsRef.current.splice(i, 1);
            i--;
          }
        }
      }

      // laser beam damage (5s)
      if (fx.laserMs > 0) {
        const lx = paddleRef.current.x;
        // bricks
        for (let i = 0; i < bricksRef.current.length; i++) {
          const br = bricksRef.current[i];
          const cols = 9;
          const bxPad = 0.06;
          const top = 0.08;
          const areaW = 1 - bxPad * 2;
          const cellW = areaW / cols;
          const cellH = 0.045;
          const x0 = bxPad + br.x * cellW;
          const x1 = bxPad + (br.x + 1) * cellW;
          const y1 = top + (br.y + 1) * cellH;
          if (lx >= x0 && lx <= x1 && y1 < 0.92) {
            br.hp -= 1;
            if (br.hp <= 0) {
              bricksRef.current.splice(i, 1);
              i--;
              scoreRef.current += 15;
            }
          }
        }
        // boss parts
        const boss = bossRef.current;
        if (boss.active && boss.phase === 2 && boss.vulnMs > 0) {
          for (const part of boss.parts) {
            if (part.kind !== "core" || part.hp <= 0) continue;
            if (lx >= part.x && lx <= part.x + part.w) {
              part.hp -= 1;
              boss.coreHp = part.hp;
              scoreRef.current += 2;
              if (part.hp <= 0) {
                boss.phase = 3;
                boss.active = false;
              }
            }
          }
        }
      }

      // missiles damage
      for (let mi = 0; mi < missilesRef.current.length; mi++) {
        const m = missilesRef.current[mi];
        // bricks
        const cols = 9;
        const bxPad = 0.06;
        const top = 0.08;
        const areaW = 1 - bxPad * 2;
        const cellW = areaW / cols;
        const cellH = 0.045;
        let hit = false;
        for (let i = 0; i < bricksRef.current.length; i++) {
          const br = bricksRef.current[i];
          const x0 = bxPad + br.x * cellW;
          const x1 = bxPad + (br.x + 1) * cellW;
          const y0 = top + br.y * cellH;
          const y1 = top + (br.y + 1) * cellH;
          if (m.x >= x0 && m.x <= x1 && m.y >= y0 && m.y <= y1) {
            br.hp -= 2;
            if (br.hp <= 0) {
              bricksRef.current.splice(i, 1);
              i--;
              scoreRef.current += 20;
            }
            hit = true;
            break;
          }
        }
        if (!hit) {
          const boss = bossRef.current;
          if (boss.active && boss.phase === 2 && boss.vulnMs > 0) {
            for (const part of boss.parts) {
              if (part.kind !== "core" || part.hp <= 0) continue;
              if (m.x >= part.x && m.x <= part.x + part.w && m.y >= part.y && m.y <= part.y + part.h) {
                part.hp -= 2;
                boss.coreHp = part.hp;
                scoreRef.current += 8;
                hit = true;
                break;
              }
            }
          }
        }
        if (hit) {
          // explosion particles
          for (let k = 0; k < 10; k++) {
            const a = Math.random() * Math.PI * 2;
            const sp = 0.4 + Math.random() * 0.7;
            particlesRef.current.push({
              x: m.x,
              y: m.y,
              vx: Math.cos(a) * sp,
              vy: Math.sin(a) * sp,
              life: 260 + Math.random() * 180,
              maxLife: 400,
              r: 0.006 + Math.random() * 0.008,
              color: "rgba(255,110,90,0.95)",
            });
          }
          sfx("break");
          missilesRef.current.splice(mi, 1);
          mi--;
        }
      }

      // boss parts (phase scaffolding)
      const boss = bossRef.current;
      if (boss.active) {
        boss.vulnMs = Math.max(0, boss.vulnMs - dt * 1000);

        // phase logic: once all anchors are down, open a vulnerability window on the core
        const anchorsAlive = boss.parts.some((p) => p.kind === "anchor" && p.hp > 0);
        if (!anchorsAlive && boss.phase === 1) {
          boss.phase = 2;
          boss.vulnMs = 4500;
        }
        if (boss.phase === 2 && boss.vulnMs <= 0) {
          // if player didn't finish, re-arm anchors lightly and repeat window
          boss.phase = 1;
          for (const p of boss.parts) {
            if (p.kind === "anchor") p.hp = Math.max(p.hp, 3);
          }
        }

        // collisions
        for (const part of boss.parts) {
          if (part.hp <= 0) continue;
          if (part.kind === "core") {
            const coreVulnerable = boss.phase === 2 && boss.vulnMs > 0;
            if (!coreVulnerable) continue;
          }

          const x0 = part.x;
          const x1 = part.x + part.w;
          const y0 = part.y;
          const y1 = part.y + part.h;

          const cx = clamp(b.x, x0, x1);
          const cy = clamp(b.y, y0, y1);
          const dx = b.x - cx;
          const dy = b.y - cy;
          if (dx * dx + dy * dy <= b.r * b.r) {
            if (Math.abs(dx) > Math.abs(dy)) b.vx *= -1;
            else b.vy *= -1;

            part.hp -= 1;
            scoreRef.current += part.kind === "core" ? 50 : 20;

            if (part.kind === "core") {
              boss.coreHp = part.hp;
              if (part.hp <= 0) {
                boss.phase = 3;
                boss.active = false;
              }
            }
            break;
          }
        }
      }

      // fail/reset
      if (b.y - b.r > 1.05) {
        reset();
      }

      // draw
      // camera juice
      const shake = screenShakeRef.current;
      screenShakeRef.current = Math.max(0, shake - dt * 2.6);
      const sx = (Math.random() - 0.5) * 10 * screenShakeRef.current;
      const sy = (Math.random() - 0.5) * 10 * screenShakeRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, sx, sy);

      ctx.clearRect(-50, -50, size.w + 100, size.h + 100);

      // background
      const g = ctx.createLinearGradient(0, 0, 0, size.h);
      g.addColorStop(0, "#070B18");
      g.addColorStop(1, "#03040A");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size.w, size.h);

      // arena frame
      const { arena, controlZone } = layout;
      ctx.strokeStyle = "rgba(120,180,255,0.18)";
      ctx.lineWidth = 2;
      ctx.strokeRect(arena.x, arena.y, arena.w, arena.h);

      // HUD
      ctx.fillStyle = "rgba(220,240,255,0.85)";
      ctx.font = "600 16px system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillText("ARC//BREAKER (prototype)", layout.pad, layout.pad + 18);
      ctx.fillStyle = "rgba(220,240,255,0.55)";
      ctx.font = "500 14px system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillText(`Score ${scoreRef.current}`, layout.pad, layout.pad + 40);

      // debug boss button (tap)
      const btnW = 110;
      const btnH = 28;
      const btnX = size.w - layout.pad - btnW;
      const btnY = layout.pad + 14;
      ctx.fillStyle = "rgba(80,200,255,0.12)";
      ctx.fillRect(btnX, btnY, btnW, btnH);
      ctx.strokeStyle = "rgba(120,220,255,0.25)";
      ctx.strokeRect(btnX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);
      ctx.fillStyle = "rgba(220,240,255,0.75)";
      ctx.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillText("Start Boss", btnX + 16, btnY + 19);

      // bricks
      const cols = 9;
      const bxPad = 0.06;
      const top = 0.08;
      const areaW = 1 - bxPad * 2;
      const cellW = areaW / cols;
      const cellH = 0.045;
      for (const br of bricksRef.current) {
        const x0n = bxPad + br.x * cellW + 0.004;
        const x1n = bxPad + (br.x + 1) * cellW - 0.004;
        const y0n = top + br.y * cellH + 0.004;
        const y1n = top + (br.y + 1) * cellH - 0.004;
        const x0 = arena.x + x0n * arena.w;
        const y0 = arena.y + y0n * arena.h;
        const w = (x1n - x0n) * arena.w;
        const h = (y1n - y0n) * arena.h;

        // emissive-ish brick
        ctx.fillStyle = br.hp >= 2 ? "rgba(255,120,80,0.85)" : "rgba(80,200,255,0.78)";
        ctx.fillRect(x0, y0, w, h);
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
      }

      // boss render (Warden Prism scaffolding)
      const boss2 = bossRef.current;
      if (boss2.active) {
        // subtle backdrop
        ctx.fillStyle = "rgba(80,200,255,0.04)";
        ctx.fillRect(arena.x, arena.y, arena.w, arena.h * 0.42);

        for (const part of boss2.parts) {
          if (part.hp <= 0) continue;
          const x = arena.x + part.x * arena.w;
          const y = arena.y + part.y * arena.h;
          const w = part.w * arena.w;
          const h = part.h * arena.h;

          const isCore = part.kind === "core";
          const coreVulnerable = isCore && boss2.phase === 2 && boss2.vulnMs > 0;

          ctx.fillStyle = isCore
            ? coreVulnerable
              ? "rgba(255,90,200,0.85)"
              : "rgba(180,200,255,0.18)"
            : "rgba(255,190,80,0.82)";
          ctx.fillRect(x, y, w, h);

          // hp pips
          ctx.fillStyle = "rgba(0,0,0,0.25)";
          ctx.fillRect(x, y + h - 4, w, 4);
          ctx.fillStyle = isCore ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.55)";
          const frac = clamp(part.hp / (isCore ? 36 : 6), 0, 1);
          ctx.fillRect(x, y + h - 4, w * frac, 4);

          ctx.strokeStyle = "rgba(255,255,255,0.16)";
          ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        }

        // boss status text
        ctx.fillStyle = "rgba(220,240,255,0.5)";
        ctx.font = "600 13px system-ui, -apple-system, Segoe UI, Roboto";
        const msg = boss2.phase === 1 ? "BOSS: Warden Prism — break anchors" : "BOSS: CORE VULNERABLE";
        ctx.fillText(msg, arena.x + 8, arena.y + 18);
      }

      // powerups (falling)
      for (const pu of powerUpsRef.current) {
        const x = arena.x + pu.x * arena.w;
        const y = arena.y + pu.y * arena.h;
        const rr = 10;
        ctx.fillStyle =
          pu.kind === "dmg"
            ? "rgba(255,90,120,0.9)"
            : pu.kind === "missiles"
              ? "rgba(255,190,80,0.9)"
              : pu.kind === "laser"
                ? "rgba(255,90,200,0.9)"
                : pu.kind === "wide"
                  ? "rgba(120,220,255,0.9)"
                  : "rgba(140,255,160,0.9)";
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.font = "700 11px system-ui, -apple-system, Segoe UI, Roboto";
        const label = pu.kind === "dmg" ? "DMG" : pu.kind === "missiles" ? "MSL" : pu.kind === "laser" ? "LAS" : pu.kind === "wide" ? "WID" : "MB";
        ctx.fillText(label, x - 12, y + 4);
      }

      // missiles
      ctx.fillStyle = "rgba(255,210,120,0.9)";
      for (const m of missilesRef.current) {
        const x = arena.x + m.x * arena.w;
        const y = arena.y + m.y * arena.h;
        ctx.fillRect(x - 2, y - 10, 4, 12);
      }

      // laser beam (visual)
      if (effectsRef.current.laserMs > 0) {
        const lx = arena.x + paddleRef.current.x * arena.w;
        ctx.strokeStyle = "rgba(255,90,200,0.55)";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(lx, arena.y + arena.h * 0.92);
        ctx.lineTo(lx, arena.y + arena.h * 0.02);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,180,240,0.45)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(lx, arena.y + arena.h * 0.92);
        ctx.lineTo(lx, arena.y + arena.h * 0.02);
        ctx.stroke();
      }

      // particles
      for (const pt of particlesRef.current) {
        const x = arena.x + pt.x * arena.w;
        const y = arena.y + pt.y * arena.h;
        const a = clamp(pt.life / (pt.maxLife || 400), 0, 1);
        ctx.fillStyle = pt.color.replace(/\)$/, `,${a})`).replace("rgba(", "rgba(");
        ctx.beginPath();
        ctx.arc(x, y, pt.r * arena.w, 0, Math.PI * 2);
        ctx.fill();
      }

      // trail
      for (const t of trailRef.current) {
        const x = arena.x + t.x * arena.w;
        const y = arena.y + t.y * arena.h;
        const a = clamp(t.life / 180, 0, 1);
        ctx.fillStyle = `rgba(120,220,255,${0.10 * a})`;
        ctx.beginPath();
        ctx.arc(x, y, b.r * arena.w * (0.8 + 0.6 * a), 0, Math.PI * 2);
        ctx.fill();
      }

      // paddle
      const px = arena.x + paddleRef.current.x * arena.w;
      const pw = paddleRef.current.w * arena.w;
      const py = arena.y + 0.93 * arena.h;
      ctx.fillStyle = effectsRef.current.wideMs > 0 ? "rgba(120,240,255,0.9)" : "rgba(190,220,255,0.85)";
      ctx.fillRect(px - pw / 2, py - 8, pw, 16);
      ctx.fillStyle = effectsRef.current.laserMs > 0 ? "rgba(255,90,200,0.45)" : "rgba(80,200,255,0.35)";
      ctx.fillRect(px - pw / 2, py - 8, pw, 3);

      // ball (reactor glow + state)
      const bx = arena.x + b.x * arena.w;
      const by = arena.y + b.y * arena.h;
      const br = b.r * arena.w;
      const hot = effectsRef.current.dmgMs > 0;
      const col0 = hot ? "rgba(255,90,120,0.9)" : "rgba(120,220,255,0.85)";
      const col1 = hot ? "rgba(255,90,120,0.2)" : "rgba(120,220,255,0.22)";
      const glow = ctx.createRadialGradient(bx, by, 1, bx, by, br * 3.6);
      glow.addColorStop(0, col0);
      glow.addColorStop(0.35, col1);
      glow.addColorStop(1, "rgba(120,220,255,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(bx, by, br * 3.6, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(230,250,255,0.95)";
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();

      // status / powerup timers
      ctx.fillStyle = "rgba(220,240,255,0.45)";
      ctx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto";
      const fx2 = effectsRef.current;
      const bits: string[] = [];
      if (fx2.dmgMs > 0) bits.push("DMG x2");
      if (fx2.missilesMs > 0) bits.push("MISSILES");
      if (fx2.laserMs > 0) bits.push("LASER");
      if (fx2.wideMs > 0) bits.push("WIDE");
      ctx.fillText(bits.join("  •  ") || "", layout.pad, layout.pad + 62);

      // control zone hint
      ctx.fillStyle = "rgba(120,180,255,0.06)";
      ctx.fillRect(controlZone.x, controlZone.y, controlZone.w, controlZone.h);
      ctx.strokeStyle = "rgba(120,180,255,0.12)";
      ctx.strokeRect(controlZone.x + 0.5, controlZone.y + 0.5, controlZone.w - 1, controlZone.h - 1);
      ctx.fillStyle = "rgba(220,240,255,0.35)";
      ctx.font = "500 13px system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillText("Touch & drag to move paddle — catch drops", layout.pad, controlZone.y + 24);

      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [dpr, layout, size.h, size.w]);

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        touchAction: "none",
      }}
      onPointerDown={(e) => {
        // init audio on first user gesture (iOS requirement)
        if (!audioRef.current) {
          const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
          if (Ctx) {
            const ctx = new Ctx();
            const master = ctx.createGain();
            master.gain.value = 0.55;
            master.connect(ctx.destination);
            audioRef.current = { ctx, master };
          }
        } else {
          // resume if needed
          audioRef.current.ctx.resume().catch(() => {});
        }

        // HUD taps (debug actions)
        const btnW = 110;
        const btnH = 28;
        const btnX = size.w - layout.pad - btnW;
        const btnY = layout.pad + 14;
        if (
          e.clientX >= btnX &&
          e.clientX <= btnX + btnW &&
          e.clientY >= btnY &&
          e.clientY <= btnY + btnH
        ) {
          startBoss();
          return;
        }

        // lock paddle control to first pointer inside control zone
        if (touchRef.current) return;
        const { controlZone } = layout;
        if (e.clientY < controlZone.y) return;
        touchRef.current = { id: e.pointerId, x: e.clientX };
        targetXRef.current = e.clientX;
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!touchRef.current) return;
        if (touchRef.current.id !== e.pointerId) return;
        touchRef.current.x = e.clientX;
        targetXRef.current = e.clientX;
      }}
      onPointerUp={(e) => {
        if (!touchRef.current) return;
        if (touchRef.current.id !== e.pointerId) return;
        touchRef.current = null;
        targetXRef.current = null;
      }}
      onPointerCancel={(e) => {
        if (!touchRef.current) return;
        if (touchRef.current.id !== e.pointerId) return;
        touchRef.current = null;
        targetXRef.current = null;
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
