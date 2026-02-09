import { useEffect, useRef } from "react";
import {
  Engine,
  Scene,
  Vector3,
  HemisphericLight,
  DirectionalLight,
  Color3,
  MeshBuilder,
  StandardMaterial,
  FollowCamera,
  Quaternion,
  CubeTexture,
  VertexBuffer,
} from "@babylonjs/core";
import "@babylonjs/loaders";

// ELEMENT WEAVER (prototype)
// Goal: third-person character + modern lighting baseline + controller support.

type InputState = {
  moveX: number; // -1..1
  moveY: number; // -1..1 (forward is +)
  lookX: number; // -1..1
  lookY: number; // -1..1
  act: boolean;
  alt: boolean;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function deadzone(v: number, dz: number) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  // re-scale
  const s = (a - dz) / (1 - dz);
  return Math.sign(v) * s;
}

function pollInput(keys: Set<string>): InputState {
  // keyboard
  let mx = 0;
  let my = 0;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) mx -= 1;
  if (keys.has("KeyD") || keys.has("ArrowRight")) mx += 1;
  if (keys.has("KeyW") || keys.has("ArrowUp")) my += 1;
  if (keys.has("KeyS") || keys.has("ArrowDown")) my -= 1;

  let lx = 0;
  let ly = 0;
  if (keys.has("KeyJ")) lx -= 1;
  if (keys.has("KeyL")) lx += 1;
  if (keys.has("KeyI")) ly += 1;
  if (keys.has("KeyK")) ly -= 1;

  let act = keys.has("Space") || keys.has("Enter");
  let alt = keys.has("ShiftLeft") || keys.has("ShiftRight");

  // gamepad (best effort)
  const pads = (navigator.getGamepads && navigator.getGamepads()) || [];
  const gp = pads[0];
  if (gp) {
    const ax0 = deadzone(gp.axes[0] ?? 0, 0.15);
    const ax1 = deadzone(-(gp.axes[1] ?? 0), 0.15);
    const ax2 = deadzone(gp.axes[2] ?? 0, 0.12);
    const ax3 = deadzone(-(gp.axes[3] ?? 0), 0.12);

    mx += ax0;
    my += ax1;
    lx += ax2;
    ly += ax3;

    // A / Cross
    act = act || !!gp.buttons?.[0]?.pressed;
    // LT / L2
    alt = alt || !!gp.buttons?.[6]?.pressed;
  }

  // normalize move
  const ml = Math.hypot(mx, my);
  if (ml > 1) {
    mx /= ml;
    my /= ml;
  }

  return {
    moveX: clamp(mx, -1, 1),
    moveY: clamp(my, -1, 1),
    lookX: clamp(lx, -1, 1),
    lookY: clamp(ly, -1, 1),
    act,
    alt,
  };
}

export function Dust() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: false,
      antialias: true,
      adaptToDeviceRatio: true,
    });

    const scene = new Scene(engine);
    scene.clearColor = new Color3(0.02, 0.03, 0.04).toColor4(1);

    // Lighting baseline (modern-ish)
    const hemi = new HemisphericLight("hemi", new Vector3(0.1, 1, 0.2), scene);
    hemi.intensity = 0.55;

    const sun = new DirectionalLight("sun", new Vector3(-0.6, -1, -0.25), scene);
    sun.intensity = 2.25;

    // Environment texture (free, hosted by Babylon)
    // Looks way better than a flat light.
    scene.environmentTexture = CubeTexture.CreateFromPrefilteredData(
      "https://assets.babylonjs.com/environments/environmentSpecular.env",
      scene,
    );
    scene.createDefaultEnvironment({
      createSkybox: true,
      skyboxSize: 250,
    });

    // Ground (heightmap grid)
    const TERR_W = 120;
    const TERR_H = 120;
    const SUB = 128;
    const ground = MeshBuilder.CreateGround("ground", { width: TERR_W, height: TERR_H, subdivisions: SUB }, scene);
    const gmat = new StandardMaterial("gmat", scene);
    gmat.diffuseColor = new Color3(0.12, 0.14, 0.16);
    gmat.specularColor = new Color3(0.06, 0.06, 0.07);
    ground.material = gmat;

    // store heights aligned to ground vertices
    const heights = new Float32Array((SUB + 1) * (SUB + 1));

    const applyHeightsToMesh = () => {
      const pos = ground.getVerticesData(VertexBuffer.PositionKind);
      if (!pos) return;
      for (let i = 0; i < heights.length; i++) {
        // each vertex has xyz
        pos[i * 3 + 1] = heights[i];
      }
      ground.updateVerticesData(VertexBuffer.PositionKind, pos);
      ground.refreshBoundingInfo();
      ground.computeWorldMatrix(true);
    };

    const brushAt = (worldX: number, worldZ: number, delta: number) => {
      // map world xz to 0..SUB grid
      const gx = ((worldX / TERR_W) + 0.5) * SUB;
      const gz = ((worldZ / TERR_H) + 0.5) * SUB;
      const r = 5.5; // in grid units
      const r2 = r * r;

      const x0 = Math.max(0, Math.floor(gx - r - 1));
      const x1 = Math.min(SUB, Math.ceil(gx + r + 1));
      const z0 = Math.max(0, Math.floor(gz - r - 1));
      const z1 = Math.min(SUB, Math.ceil(gz + r + 1));

      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - gx;
          const dz = z - gz;
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          const t = 1 - d2 / r2;
          const k = t * t * (3 - 2 * t); // smoothstep-ish
          const idx = z * (SUB + 1) + x;
          heights[idx] = clamp(heights[idx] + delta * k, -8, 18);
        }
      }

      applyHeightsToMesh();
    };

    // Player avatar (placeholder)
    const player = MeshBuilder.CreateCapsule("player", { radius: 0.45, height: 1.75, tessellation: 12 }, scene);
    player.position = new Vector3(0, 1.2, 0);
    const pmat = new StandardMaterial("pmat", scene);
    pmat.diffuseColor = new Color3(0.8, 0.88, 0.95);
    player.material = pmat;

    // Follow camera (third-person)
    const cam = new FollowCamera("cam", new Vector3(0, 2.2, -6.5), scene);
    cam.radius = 6.5;
    cam.heightOffset = 2.1;
    cam.rotationOffset = 180;
    cam.cameraAcceleration = 0.05;
    cam.maxCameraSpeed = 10;
    cam.lockedTarget = player;

    scene.activeCamera = cam;
    cam.attachControl(true);

    const keys = new Set<string>();
    const onKeyDown = (e: KeyboardEvent) => keys.add(e.code);
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Pointer-based terrain sculpting (mouse)
    let sculpt = false;
    let sculptSign = 1;
    const onPointerDown = (e: PointerEvent) => {
      sculpt = true;
      sculptSign = e.button === 2 ? -1 : 1;
    };
    const onPointerUp = () => {
      sculpt = false;
    };
    const onContext = (e: Event) => e.preventDefault();
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("contextmenu", onContext);

    // Main loop (character controller)
    let yaw = 0;
    const vel = new Vector3(0, 0, 0);

    engine.runRenderLoop(() => {
      const dt = engine.getDeltaTime() / 1000;
      const input = pollInput(keys);

      // camera look with right stick (adjust follow camera rotation offset)
      cam.rotationOffset += input.lookX * 110 * dt;
      cam.heightOffset = clamp(cam.heightOffset + input.lookY * 2.2 * dt, 1.2, 3.2);

      // move relative to camera forward
      const ang = (cam.rotationOffset * Math.PI) / 180;
      const fwd = new Vector3(Math.sin(ang), 0, Math.cos(ang));
      const right = new Vector3(fwd.z, 0, -fwd.x);

      const desired = right.scale(input.moveX).add(fwd.scale(input.moveY));
      const sp = input.alt ? 8.5 : 5.5;

      // smooth
      const accel = 18;
      vel.x += (desired.x * sp - vel.x) * clamp(accel * dt, 0, 1);
      vel.z += (desired.z * sp - vel.z) * clamp(accel * dt, 0, 1);

      player.position.x += vel.x * dt;
      player.position.z += vel.z * dt;

      // ground clamp (simple sample from height grid)
      {
        const gx = ((player.position.x / TERR_W) + 0.5) * SUB;
        const gz = ((player.position.z / TERR_H) + 0.5) * SUB;
        const x0 = Math.max(0, Math.min(SUB, Math.floor(gx)));
        const z0 = Math.max(0, Math.min(SUB, Math.floor(gz)));
        const x1 = Math.max(0, Math.min(SUB, x0 + 1));
        const z1 = Math.max(0, Math.min(SUB, z0 + 1));
        const tx = clamp(gx - x0, 0, 1);
        const tz = clamp(gz - z0, 0, 1);
        const h00 = heights[z0 * (SUB + 1) + x0];
        const h10 = heights[z0 * (SUB + 1) + x1];
        const h01 = heights[z1 * (SUB + 1) + x0];
        const h11 = heights[z1 * (SUB + 1) + x1];
        const h0 = h00 + (h10 - h00) * tx;
        const h1 = h01 + (h11 - h01) * tx;
        const hh = h0 + (h1 - h0) * tz;
        player.position.y = hh + 1.2;
      }

      // face movement direction
      const mv = new Vector3(vel.x, 0, vel.z);
      const mvl = mv.length();
      if (mvl > 0.2) {
        yaw = Math.atan2(mv.x, mv.z);
        player.rotationQuaternion = Quaternion.FromEulerAngles(0, yaw, 0);
      }

      // terrain sculpt while holding mouse (LMB raise, RMB lower)
      if (sculpt) {
        const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => m === ground);
        if (hit?.hit && hit.pickedPoint) {
          const rate = 12; // units/sec
          brushAt(hit.pickedPoint.x, hit.pickedPoint.z, sculptSign * rate * dt);
        }
      }

      scene.render();
    });

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("contextmenu", onContext);
      scene.dispose();
      engine.dispose();
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#05070A" }}>
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", touchAction: "none" }} />
      <div
        style={{
          position: "absolute",
          left: 16,
          top: 14,
          color: "rgba(220,240,255,0.75)",
          font: "600 13px system-ui, -apple-system, Segoe UI, Roboto",
          letterSpacing: 0.2,
          userSelect: "none",
          pointerEvents: "none",
        }}
      >
        ELEMENT WEAVER (prototype) — WASD + mouse / gamepad sticks • LT sprint • LMB raise terrain • RMB lower
      </div>
    </div>
  );
}
