import { useEffect, useMemo, useRef, useState } from "react";

// ARC//BREAKER — feel prototype (portrait, one-hand)
// Goals for v0:
// - responsive one-thumb paddle control (direct drag with smoothing)
// - deterministic ball physics + brick collision
// - keep ball readable (glow + trail stub)

type Brick = { x: number; y: number; hp: number };

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

      // sim
      const b = ballRef.current;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

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

            br.hp -= 1;
            scoreRef.current += 10;
            if (br.hp <= 0) {
              bricks.splice(i, 1);
              i--;
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
      ctx.clearRect(0, 0, size.w, size.h);

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

      // paddle
      const px = arena.x + paddleRef.current.x * arena.w;
      const pw = paddleRef.current.w * arena.w;
      const py = arena.y + 0.93 * arena.h;
      ctx.fillStyle = "rgba(190,220,255,0.85)";
      ctx.fillRect(px - pw / 2, py - 8, pw, 16);
      ctx.fillStyle = "rgba(80,200,255,0.35)";
      ctx.fillRect(px - pw / 2, py - 8, pw, 3);

      // ball (reactor glow stub)
      const bx = arena.x + b.x * arena.w;
      const by = arena.y + b.y * arena.h;
      const br = b.r * arena.w;
      const glow = ctx.createRadialGradient(bx, by, 1, bx, by, br * 3.2);
      glow.addColorStop(0, "rgba(120,220,255,0.85)");
      glow.addColorStop(0.35, "rgba(120,220,255,0.22)");
      glow.addColorStop(1, "rgba(120,220,255,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(bx, by, br * 3.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(230,250,255,0.95)";
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();

      // control zone hint
      ctx.fillStyle = "rgba(120,180,255,0.06)";
      ctx.fillRect(controlZone.x, controlZone.y, controlZone.w, controlZone.h);
      ctx.strokeStyle = "rgba(120,180,255,0.12)";
      ctx.strokeRect(controlZone.x + 0.5, controlZone.y + 0.5, controlZone.w - 1, controlZone.h - 1);
      ctx.fillStyle = "rgba(220,240,255,0.35)";
      ctx.font = "500 13px system-ui, -apple-system, Segoe UI, Roboto";
      ctx.fillText("Touch & drag to move paddle", layout.pad, controlZone.y + 24);

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
