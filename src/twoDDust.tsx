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

function idx(x: number, y: number) {
  return y * GRID_W + x;
}

function inBounds(x: number, y: number) {
  return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H;
}

function solid(c: Cell) {
  return c === 1 || c === 2;
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

  useEffect(() => {
    dirtRef.current = dirt;
  }, [dirt]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const canvasEl: HTMLCanvasElement = canvas;
    const world = worldRef.current;
    const player = playerRef.current;

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

    function onMouseMove(e: MouseEvent) {
      mouseRef.current.x = e.clientX;
      mouseRef.current.y = e.clientY;
    }

    function onMouseDown(e: MouseEvent) {
      if (e.button === 0) mouseRef.current.left = true;
      if (e.button === 2) mouseRef.current.right = true;
    }

    function onMouseUp(e: MouseEvent) {
      if (e.button === 0) mouseRef.current.left = false;
      if (e.button === 2) mouseRef.current.right = false;
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
      const reach = 96 + tool.carrySize * 1.6;

      if (mouseRef.current.left) {
        tool.blobSize = Math.min(22, tool.blobSize + dt * 30);

        if (dist <= reach && tool.mineCooldown <= 0) {
          const suckRadius = Math.max(1, Math.floor((tool.blobSize + tool.carrySize) / 7));
          let mined = false;
          let minedX = tc.x;
          let minedY = tc.y;
          let bestScore = Number.POSITIVE_INFINITY;

          // select nearest valid dirt in radius for more consistent suction
          for (let r = 0; r <= suckRadius; r++) {
            for (let oy = -r; oy <= r; oy++) {
              for (let ox = -r; ox <= r; ox++) {
                const tx = tc.x + ox;
                const ty = tc.y + oy;
                if (!inBounds(tx, ty)) continue;
                if (getCell(tx, ty) !== 1) continue;
                const score = Math.hypot(ox, oy) + (isEdgeDirt(tx, ty) ? -0.25 : 0.2);
                if (score < bestScore) {
                  bestScore = score;
                  mined = true;
                  minedX = tx;
                  minedY = ty;
                }
              }
            }
          }

          if (mined) {
            setCell(minedX, minedY, 0);
            setDirt((v) => v + 1);

            const speedBoost = (tool.blobSize + tool.carrySize) / 40;
            tool.mineCooldown = Math.max(0.014, 0.045 - speedBoost * 0.02);
            tool.blobPulse = 1;

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
          tool.falling.push({ x: tc.x * CELL + CELL * 0.5, y: tc.y * CELL + CELL * 0.5, vy: 0 });
          if (tool.falling.length > 220) tool.falling.splice(0, tool.falling.length - 220);
          setDirt((v) => Math.max(0, v - 1));
          tool.placeCooldown = 0.05;
          tool.blobPulse = Math.max(tool.blobPulse, 0.45);
        }
      }
    }

    function update(dt: number) {
      const keys = keysRef.current;

      // horizontal input
      const left = keys["a"] || keys["arrowleft"];
      const right = keys["d"] || keys["arrowright"];
      player.vx = 0;
      if (left) player.vx = -MOVE_SPEED;
      if (right) player.vx = MOVE_SPEED;

      // jump
      const jump = keys["w"] || keys["arrowup"] || keys[" "];
      if (jump && player.onGround) {
        player.vy = JUMP_VEL;
        player.onGround = false;
      }

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
        f.vy += GRAVITY * dt * 0.9;
        if (f.vy > 720) f.vy = 720;
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

          if (c === 1) ctx.fillStyle = "#7b5b3a";
          else ctx.fillStyle = "#5b5f68";

          ctx.fillRect(sx, sy, CELL, CELL);
        }
      }

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
      ctx.fillText(`Dirt: ${dirtRef.current}`, 28, 60);
      ctx.fillText("Move: A/D  Jump: W/Space  Suck: Hold Left  Place: Hold Right (falls + stacks)", 28, 82);

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
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);

    const preventMenu = (e: Event) => e.preventDefault();
    canvasEl.addEventListener("contextmenu", preventMenu);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      canvasEl.removeEventListener("contextmenu", preventMenu);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ display: "block", width: "100vw", height: "100vh" }} />;
};
