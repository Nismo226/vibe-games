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

    function applyTools(camX: number, camY: number) {
      const mx = mouseRef.current.x + camX;
      const my = mouseRef.current.y + camY;
      const tc = worldToCell(mx, my);

      const pCenterX = player.x + player.w * 0.5;
      const pCenterY = player.y + player.h * 0.5;
      const dx = tc.x * CELL + CELL * 0.5 - pCenterX;
      const dy = tc.y * CELL + CELL * 0.5 - pCenterY;
      const dist = Math.hypot(dx, dy);
      if (dist > 96) return;

      if (mouseRef.current.left) {
        const c = getCell(tc.x, tc.y);
        if (c === 1) {
          setCell(tc.x, tc.y, 0);
          setDirt((v) => v + 1);
          mouseRef.current.left = false; // one action per click
        }
      }

      if (mouseRef.current.right) {
        const c = getCell(tc.x, tc.y);
        if (c === 0) {
          setDirt((v) => {
            if (v <= 0) return 0;
            setCell(tc.x, tc.y, 1);
            return v - 1;
          });
          mouseRef.current.right = false;
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
    }

    function draw() {
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
      ctx.fillText("Move: A/D  Jump: W/Space  Suck: Left Click  Place: Right Click", 28, 82);

      applyTools(camX, camY);
    }

    function frame(ts: number) {
      if (!lastRef.current) lastRef.current = ts;
      const dt = Math.min(0.033, (ts - lastRef.current) / 1000);
      lastRef.current = ts;

      update(dt);
      draw();
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
