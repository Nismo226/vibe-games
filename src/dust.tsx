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

    // Ground
    const ground = MeshBuilder.CreateGround(
      "ground",
      { width: 120, height: 120, subdivisions: 2 },
      scene,
    );
    const gmat = new StandardMaterial("gmat", scene);
    gmat.diffuseColor = new Color3(0.12, 0.14, 0.16);
    gmat.specularColor = new Color3(0.06, 0.06, 0.07);
    ground.material = gmat;

    // Player avatar (placeholder)
    const player = MeshBuilder.CreateCapsule(
      "player",
      { radius: 0.45, height: 1.75, tessellation: 12 },
      scene,
    );
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

      // ground clamp (flat for now)
      player.position.y = 1.2;

      // face movement direction
      const mv = new Vector3(vel.x, 0, vel.z);
      const mvl = mv.length();
      if (mvl > 0.2) {
        yaw = Math.atan2(mv.x, mv.z);
        player.rotationQuaternion = Quaternion.FromEulerAngles(0, yaw, 0);
      }

      scene.render();
    });

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
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
        ELEMENT WEAVER (prototype) — WASD + mouse / gamepad sticks • LT sprint
      </div>
    </div>
  );
}
