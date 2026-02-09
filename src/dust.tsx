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
  VertexBuffer,
  Texture,
  DynamicTexture,
  SceneLoader,
  TransformNode,
  AnimationGroup,
  Skeleton,
  Bone,
  AbstractMesh,
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

  // debug
  gp?: { axes: number[]; id?: string };
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

function snapZero(v: number, eps: number) {
  return Math.abs(v) < eps ? 0 : v;
}

function wrapAngle(a: number) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

let joyState = { mx: 0, my: 0, lx: 0, ly: 0 };
let touchMoveId: number | null = null;
let touchLookId: number | null = null;
let touchMoveStart = { x: 0, y: 0 };
let touchLookStart = { x: 0, y: 0 };
let touchMoveNow = { x: 0, y: 0 };
let touchLookNow = { x: 0, y: 0 };
let pinchStartDist = 0;
let pinchStartRadius = 0;

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
  let gpDbg: InputState["gp"] | undefined;
  if (gp) {
    gpDbg = { axes: Array.from(gp.axes || []), id: gp.id };

    // bigger deadzone to prevent drift (most controllers report slight non-zero)
    const ax0 = deadzone(gp.axes[0] ?? 0, 0.28);
    const ax1 = deadzone(-(gp.axes[1] ?? 0), 0.28);
    const ax2 = deadzone(gp.axes[2] ?? 0, 0.22);
    const ax3 = deadzone(-(gp.axes[3] ?? 0), 0.22);

    mx += ax0;
    my += ax1;
    lx += ax2;
    ly += ax3;

    // A / Cross
    act = act || !!gp.buttons?.[0]?.pressed;
    // LT / L2
    alt = alt || !!gp.buttons?.[6]?.pressed;
  }

  mx = snapZero(mx, 0.05);
  my = snapZero(my, 0.05);
  lx = snapZero(lx, 0.05);
  ly = snapZero(ly, 0.05);

  // If you have no intentional movement, clamp to zero (prevents “ghost walking”).
  if (Math.hypot(mx, my) < 0.08) {
    mx = 0;
    my = 0;
  }

  // mobile virtual joysticks (if present)
  mx += joyState.mx;
  my += joyState.my;
  lx += joyState.lx;
  ly += joyState.ly;

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
    gp: gpDbg,
  };
}

export function Dust() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const debugRef = useRef<HTMLDivElement | null>(null);

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

    // Procedural sky (no external downloads; iOS/Safari caching + CORS can be flaky)
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.0020;
    scene.fogColor = new Color3(0.55, 0.72, 0.92);
    scene.clearColor = scene.fogColor.toColor4(1);

    const skyTex = new DynamicTexture("skyTex", { width: 512, height: 256 }, scene, false);
    {
      const ctx = skyTex.getContext();
      const w = skyTex.getSize().width;
      const h = skyTex.getSize().height;
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0.0, "#77b7ff");
      g.addColorStop(0.55, "#8fd0ff");
      g.addColorStop(1.0, "#e9f6ff");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // simple sun bloom
      const sx = Math.floor(w * 0.72);
      const sy = Math.floor(h * 0.32);
      const r = Math.floor(h * 0.22);
      const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      rg.addColorStop(0.0, "rgba(255,255,240,0.95)");
      rg.addColorStop(0.25, "rgba(255,250,210,0.55)");
      rg.addColorStop(1.0, "rgba(255,255,255,0.0)");
      ctx.fillStyle = rg;
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
      skyTex.update(false);
    }

    const sky = MeshBuilder.CreateSphere("sky", { diameter: 4000, segments: 16 }, scene);
    sky.isPickable = false;
    const sm = new StandardMaterial("skyMat", scene);
    sm.backFaceCulling = false;
    sm.diffuseTexture = skyTex;
    sm.diffuseTexture.hasAlpha = false;
    sm.emissiveColor = new Color3(1, 1, 1);
    sm.specularColor = new Color3(0, 0, 0);
    sm.disableLighting = true;
    sky.material = sm;

    // Ground (heightmap grid)
    const TERR_W = 420;
    const TERR_H = 420;
    const SUB = 128;
    const ground = MeshBuilder.CreateGround("ground", { width: TERR_W, height: TERR_H, subdivisions: SUB }, scene);
    const gmat = new StandardMaterial("gmat", scene);
    // Lightweight "grass" texture (procedural, no network)
    const grassTex = new DynamicTexture("grassTex", { width: 256, height: 256 }, scene, false);
    {
      const ctx = grassTex.getContext();
      const w = grassTex.getSize().width;
      const h = grassTex.getSize().height;
      ctx.fillStyle = "#2f6b2d";
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) {
        const x = (Math.random() * w) | 0;
        const y = (Math.random() * h) | 0;
        const g = 90 + ((Math.random() * 90) | 0);
        ctx.fillStyle = `rgba(20,${g},20,0.35)`;
        ctx.fillRect(x, y, 1, 1);
      }
      grassTex.update(false);
    }
    grassTex.wrapU = Texture.WRAP_ADDRESSMODE;
    grassTex.wrapV = Texture.WRAP_ADDRESSMODE;
    grassTex.uScale = 18;
    grassTex.vScale = 18;
    (grassTex as any).anisotropicFilteringLevel = 8;
    gmat.diffuseTexture = grassTex;
    gmat.specularColor = new Color3(0.03, 0.03, 0.03);
    gmat.specularPower = 64;
    // StandardMaterial uses vertex colors automatically if present.
    ground.material = gmat;

    // store heights aligned to ground vertices
    const heights = new Float32Array((SUB + 1) * (SUB + 1));

    const applyHeightsToMesh = () => {
      const pos = ground.getVerticesData(VertexBuffer.PositionKind);
      if (!pos) return;
      for (let i = 0; i < heights.length; i++) {
        pos[i * 3 + 1] = heights[i];
      }

      // Vertex colors: grass on flats, rock on steep slopes, sand near sea-level.
      const colors = new Float32Array(heights.length * 4);
      const hAt = (x: number, z: number) => heights[z * (SUB + 1) + x];
      const sea = 0.0;
      for (let z = 0; z <= SUB; z++) {
        for (let x = 0; x <= SUB; x++) {
          const i = z * (SUB + 1) + x;
          const h = heights[i];
          const hx0 = hAt(Math.max(0, x - 1), z);
          const hx1 = hAt(Math.min(SUB, x + 1), z);
          const hz0 = hAt(x, Math.max(0, z - 1));
          const hz1 = hAt(x, Math.min(SUB, z + 1));
          const dx = (hx1 - hx0) * 0.5;
          const dz = (hz1 - hz0) * 0.5;
          const slope = Math.min(1, Math.hypot(dx, dz) * 0.35);

          // sand factor near sea level
          const sand = clamp(1 - Math.abs(h - sea) / 1.8, 0, 1);
          const rock = clamp((slope - 0.35) / 0.45, 0, 1);
          const grass = clamp(1 - rock, 0, 1) * (1 - sand * 0.75);

          // colors (linear-ish)
          const r = 0.10 * grass + 0.40 * rock + 0.18 * sand;
          const g = 0.55 * grass + 0.40 * rock + 0.42 * sand;
          const b = 0.12 * grass + 0.42 * rock + 0.20 * sand;

          colors[i * 4 + 0] = r;
          colors[i * 4 + 1] = g;
          colors[i * 4 + 2] = b;
          colors[i * 4 + 3] = 1;
        }
      }

      ground.updateVerticesData(VertexBuffer.PositionKind, pos);
      ground.setVerticesData(VertexBuffer.ColorKind, colors, true);
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
          heights[idx] = clamp(heights[idx] + delta * k, -8, 22);
        }
      }

      applyHeightsToMesh();
    };

    // initial island (radial falloff + noise + volcano peak)
    {
      const hash = (x: number, y: number) => {
        let n = x * 374761393 + y * 668265263;
        n = (n ^ (n >> 13)) * 1274126177;
        return (n ^ (n >> 16)) >>> 0;
      };
      const noise2 = (x: number, y: number) => (hash(x, y) % 10000) / 10000;
      for (let z = 0; z <= SUB; z++) {
        for (let x = 0; x <= SUB; x++) {
          const u = x / SUB;
          const v = z / SUB;
          const dx = u - 0.5;
          const dz = v - 0.5;
          const r = Math.hypot(dx, dz);
          const fall = clamp(1 - Math.pow(r / 0.52, 2.2), 0, 1);

          // fbm-ish
          let n = 0;
          let amp = 1;
          let freq = 1;
          for (let o = 0; o < 5; o++) {
            const sx = Math.floor((u * 64) * freq);
            const sz = Math.floor((v * 64) * freq);
            n += (noise2(sx + o * 17, sz + o * 31) * 2 - 1) * amp;
            amp *= 0.55;
            freq *= 2;
          }

          // base island height
          let h = fall * (6.5 + 4.5 * n);

          // volcano-ish mountain off-center
          const vx = u - 0.63;
          const vz = v - 0.38;
          const vr = Math.hypot(vx, vz);
          const peak = clamp(1 - vr / 0.18, 0, 1);
          h += Math.pow(peak, 2.2) * 14;

          heights[z * (SUB + 1) + x] = h - 0.8; // sea level ~0
        }
      }
      applyHeightsToMesh();
    }


    // Player root (mesh so FollowCamera typing is happy)
    const playerRoot = MeshBuilder.CreateBox("playerRoot", { size: 0.01 }, scene);
    playerRoot.isVisible = false;
    playerRoot.position = new Vector3(0, 1.2, 0);

    // Placeholder body while GLB loads
    const placeholder = MeshBuilder.CreateCapsule("playerPlaceholder", { radius: 0.45, height: 1.75, tessellation: 12 }, scene);
    placeholder.parent = playerRoot;
    // Keep the placeholder resting on the ground when playerRoot.y == groundHeight
    placeholder.position.y = 1.75 * 0.5;
    const pmat = new StandardMaterial("pmat", scene);
    pmat.diffuseColor = new Color3(0.8, 0.88, 0.95);
    placeholder.material = pmat;

    // Load rigged character + animations (Meshy export)
    let characterRoot: TransformNode | null = null;
    let characterOffset: TransformNode | null = null;
    let skinnedMesh: AbstractMesh | null = null;
    let footL: Bone | null = null;
    let footR: Bone | null = null;
    let walkAG: AnimationGroup | null = null;
    let runAG: AnimationGroup | null = null;

    const base = (import.meta as any).env?.BASE_URL || "/";
    const join = (p: string) => (base.endsWith("/") ? base : base + "/") + p.replace(/^\//, "");

    let rigSkeleton: Skeleton | null = null;

    const stopAllCharacterAnims = () => {
      // Nuke any active animatables (this stops “mystery animations” that aren't in our walk/run groups)
      try {
        scene.stopAllAnimations();
      } catch {}

      try {
        rigSkeleton?.returnToRest();
      } catch {}

      // Also clear bone animation tracks if the GLB embedded them.
      try {
        for (const b of rigSkeleton?.bones || []) b.animations = [];
      } catch {}

      if (walkAG) {
        try {
          walkAG.stop();
          walkAG.goToFrame(0);
        } catch {}
      }
      if (runAG) {
        try {
          runAG.stop();
          runAG.goToFrame(0);
        } catch {}
      }
    };

    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/^mixamorig[:_\-]*/g, "")
        .replace(/[^a-z0-9]+/g, "");

    const findBone = (name: string) => {
      const sk = rigSkeleton;
      if (!sk) return null;
      const direct = sk.bones.find((b) => b.name === name);
      if (direct) return direct;
      const nn = norm(name);
      return sk.bones.find((b) => norm(b.name) === nn) ?? null;
    };

    const retargetGroupToRig = (src: AnimationGroup): AnimationGroup => {
      // Clone the animation group and remap its targets (bones/nodes) to our rig.
      return src.clone(`${src.name}_rt`, (oldTarget: any) => {
        if (!oldTarget) return null;

        // Bone target
        if (oldTarget instanceof Bone) {
          return findBone(oldTarget.name);
        }

        // TransformNode/Mesh target
        const nm = oldTarget.name;
        if (nm) return scene.getNodeByName(nm);
        return null;
      })!;
    };

    const loadCharacter = async () => {
      try {
        const c = await SceneLoader.ImportMeshAsync(null, join("element-weaver/models/"), "character.glb", scene);

        // Some GLBs include a default animation that starts playing immediately.
        // Stop/reset anything that came with the character file.
        for (const ag of c.animationGroups || []) {
          try {
            ag.stop();
            ag.goToFrame(0);
          } catch {}
        }

        rigSkeleton = (c.skeletons && c.skeletons[0]) || null;
        stopAllCharacterAnims();

        characterRoot = new TransformNode("character", scene);
        characterOffset = new TransformNode("characterOffset", scene);
        characterOffset.parent = characterRoot;

        for (const m of c.meshes) {
          if (m === scene.meshes[0]) continue;
          (m as any).parent = characterOffset;
          // Capture a mesh that is skinned to the rig (used for bone absolute positions)
          if (!skinnedMesh && (m as any).skeleton) skinnedMesh = m;
        }

        // Meshy exports tend to be huge in world units. Scale down.
        characterRoot.scaling.setAll(0.18);

        // IMPORTANT: playerRoot.y is treated as *feet height*.
        // Therefore the pivot (characterRoot) stays at (0,0,0) relative to playerRoot,
        // and we offset the imported meshes so their minY lands on local Y=0.
        characterRoot.parent = null;
        characterRoot.position.set(0, 0, 0);
        characterOffset.position.set(0, 0, 0);
        characterRoot.computeWorldMatrix(true);
        const bounds = characterOffset.getHierarchyBoundingVectors(true);
        characterOffset.position.y = -bounds.min.y;

        // Try to find foot bones for robust foot-to-ground alignment.
        footL = findBone("LeftFoot") || findBone("leftfoot") || findBone("mixamorig:LeftFoot") || null;
        footR = findBone("RightFoot") || findBone("rightfoot") || findBone("mixamorig:RightFoot") || null;
        // Now attach to the player root
        characterRoot.parent = playerRoot;
        characterRoot.position.set(0, 0, 0);

        placeholder.setEnabled(false);

        // Load animations from separate GLBs and retarget to the character skeleton.
        // (ImportAnimationsAsync often won't bind correctly across GLBs.)
        const walkC = await SceneLoader.LoadAssetContainerAsync(join("element-weaver/models/"), "walk.glb", scene);
        const runC = await SceneLoader.LoadAssetContainerAsync(join("element-weaver/models/"), "run.glb", scene);

        const walkSrc = walkC.animationGroups?.[0];
        const runSrc = runC.animationGroups?.[0];

        if (walkSrc) walkAG = retargetGroupToRig(walkSrc);
        if (runSrc) runAG = retargetGroupToRig(runSrc);

        // clean up loaded containers (we only needed their animation data)
        walkC.dispose();
        runC.dispose();

        // Start in idle (no anim). We only play walk/run when there's real movement intent.
        walkAG?.stop();
        runAG?.stop();
        walkAG?.goToFrame(0);
        runAG?.goToFrame(0);
      } catch {
        // keep placeholder
      }
    };
    loadCharacter();

    // Follow camera (third-person)
    const cam = new FollowCamera("cam", new Vector3(0, 2.2, -12.5), scene);
    cam.radius = 12.5;
    cam.heightOffset = 3.1;
    cam.rotationOffset = 180;
    cam.cameraAcceleration = 0.05;
    cam.maxCameraSpeed = 10;
    cam.lockedTarget = playerRoot;

    scene.activeCamera = cam;
    cam.attachControl(true);

    const keys = new Set<string>();
    const onKeyDown = (e: KeyboardEvent) => keys.add(e.code);
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Mobile controls: bottom-half virtual sticks + top-half pinch zoom
    // - bottom-left drag = move
    // - bottom-right drag = camera look
    // - top-half 2-finger pinch = zoom camera radius

    const isTouchDevice = typeof window !== "undefined" && ("ontouchstart" in window || navigator.maxTouchPoints > 0);
    const bottomHalfY = () => window.innerHeight * 0.5;

    const setTouch = (id: number | null, start: any, now: any, x: number, y: number) => {
      if (id == null) {
        start.x = x;
        start.y = y;
      }
      now.x = x;
      now.y = y;
    };

    const onTouchStartGame = (e: TouchEvent) => {
      if (!isTouchDevice) return;

      // Top-half pinch zoom
      if (e.touches.length >= 2) {
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        if (t0.clientY < bottomHalfY() && t1.clientY < bottomHalfY()) {
          pinchStartDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
          pinchStartRadius = cam.radius;
        }
      }

      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.clientY < bottomHalfY()) continue;

        if (t.clientX < window.innerWidth * 0.5 && touchMoveId == null) {
          touchMoveId = t.identifier;
          setTouch(touchMoveId, touchMoveStart, touchMoveNow, t.clientX, t.clientY);
        } else if (t.clientX >= window.innerWidth * 0.5 && touchLookId == null) {
          touchLookId = t.identifier;
          setTouch(touchLookId, touchLookStart, touchLookNow, t.clientX, t.clientY);
        }
      }
    };

    const onTouchMoveGame = (e: TouchEvent) => {
      if (!isTouchDevice) return;

      // pinch zoom update (top half only)
      if (e.touches.length >= 2) {
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        if (t0.clientY < bottomHalfY() && t1.clientY < bottomHalfY()) {
          const d = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
          if (pinchStartDist > 0) {
            const k = d / pinchStartDist;
            cam.radius = clamp(pinchStartRadius / Math.max(0.25, k), 6, 42);
          }
        }
      }

      for (let i = 0; i < e.touches.length; i++) {
        const t = e.touches[i];
        if (t.identifier === touchMoveId) setTouch(touchMoveId, touchMoveStart, touchMoveNow, t.clientX, t.clientY);
        if (t.identifier === touchLookId) setTouch(touchLookId, touchLookStart, touchLookNow, t.clientX, t.clientY);
      }
    };

    const onTouchEndGame = (e: TouchEvent) => {
      if (!isTouchDevice) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        if (t.identifier === touchMoveId) {
          touchMoveId = null;
          joyState.mx = 0;
          joyState.my = 0;
        }
        if (t.identifier === touchLookId) {
          touchLookId = null;
          joyState.lx = 0;
          joyState.ly = 0;
        }
      }

      if (e.touches.length < 2) {
        pinchStartDist = 0;
      }
    };

    if (isTouchDevice) {
      canvas.addEventListener("touchstart", onTouchStartGame, { passive: true });
      canvas.addEventListener("touchmove", onTouchMoveGame, { passive: true });
      canvas.addEventListener("touchend", onTouchEndGame, { passive: true });
      canvas.addEventListener("touchcancel", onTouchEndGame, { passive: true });
    }

    // Pointer-based terrain sculpting
    // Desktop: LMB raise, RMB lower.
    // Mobile: 1 finger = raise, 2 fingers = lower.
    let sculpt = false;
    let sculptSign = 1;

    const sculptAtPointer = (dt: number) => {
      const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => m === ground);
      if (hit?.hit && hit.pickedPoint) {
        const rate = 12; // units/sec
        brushAt(hit.pickedPoint.x, hit.pickedPoint.z, sculptSign * rate * dt);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      sculpt = true;
      // If touch, button is usually 0; use multi-touch heuristic.
      const isTouch = e.pointerType === "touch";
      const touches = (e as any).touches as TouchList | undefined;
      sculptSign = isTouch ? ((touches && touches.length >= 2) ? -1 : 1) : e.button === 2 ? -1 : 1;
      sculptAtPointer(1 / 60);
    };
    const onPointerMove = () => {
      // keep Babylon pointerX/Y updated; sculpt in render loop
    };
    const onPointerUp = () => {
      sculpt = false;
    };
    const onContext = (e: Event) => e.preventDefault();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("contextmenu", onContext);

    // Touch fallback (some browsers don’t deliver pointerType=touch reliably)
    const onTouchStart = (e: TouchEvent) => {
      sculpt = true;
      sculptSign = e.touches.length >= 2 ? -1 : 1;
      sculptAtPointer(1 / 60);
    };
    const onTouchEnd = () => {
      sculpt = false;
    };
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchend", onTouchEnd);
    canvas.addEventListener("touchcancel", onTouchEnd);

    // Main loop (character controller)
    let yaw = 0;
    const vel = new Vector3(0, 0, 0);
    let vy = 0; // vertical velocity
    let grounded = false;
    let lastGroundH = 0;

    let dbgAccum = 0;

    engine.runRenderLoop(() => {
      const dt = engine.getDeltaTime() / 1000;

      // update mobile stick state (bottom half drag)
      const stick = (dx: number, dy: number, denom: number) => {
        // dy: screen coords (down is +). For game controls we want up=+.
        let x = dx / denom;
        let y = -dy / denom;
        const l = Math.hypot(x, y);
        const dead = 0.12;
        if (l < dead) return { x: 0, y: 0 };
        const nl = clamp((l - dead) / (1 - dead), 0, 1);
        x = (x / l) * nl;
        y = (y / l) * nl;
        return { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
      };

      if (touchMoveId != null) {
        const dx = touchMoveNow.x - touchMoveStart.x;
        const dy = touchMoveNow.y - touchMoveStart.y;
        const s = stick(dx, dy, 70);
        joyState.mx = s.x;
        joyState.my = s.y;
      } else {
        joyState.mx = 0;
        joyState.my = 0;
      }

      if (touchLookId != null) {
        const dx = touchLookNow.x - touchLookStart.x;
        const dy = touchLookNow.y - touchLookStart.y;
        const s = stick(dx, dy, 95);
        joyState.lx = s.x;
        joyState.ly = s.y;
      } else {
        joyState.lx = 0;
        joyState.ly = 0;
      }

      const input = pollInput(keys);

      // camera look with right stick / virtual joystick
      cam.rotationOffset += input.lookX * 110 * dt;
      cam.heightOffset = clamp(cam.heightOffset + input.lookY * 2.2 * dt, 1.2, 4.2);

      // move relative to camera forward
      const ang = (cam.rotationOffset * Math.PI) / 180;
      const fwd = new Vector3(Math.sin(ang), 0, Math.cos(ang));
      const right = new Vector3(fwd.z, 0, -fwd.x);

      const desired = right.scale(input.moveX).add(fwd.scale(input.moveY));
      const sp = input.alt ? 8.5 : 5.5;

      // smooth (snappier so it feels like a real controller)
      const accel = desired.length() > 0.001 ? 34 : 26;
      vel.x += (desired.x * sp - vel.x) * clamp(accel * dt, 0, 1);
      vel.z += (desired.z * sp - vel.z) * clamp(accel * dt, 0, 1);

      playerRoot.position.x += vel.x * dt;
      playerRoot.position.z += vel.z * dt;

      // Grounding / collision against the heightmap.
      // We treat playerRoot.y as the *feet* height.
      {
        const sampleHeight = (x: number, z: number) => {
          const gx = ((x / TERR_W) + 0.5) * SUB;
          const gz = ((z / TERR_H) + 0.5) * SUB;
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
          return h0 + (h1 - h0) * tz;
        };

        const eps = 0.04;
        const g = -28; // gravity

        const h = sampleHeight(playerRoot.position.x, playerRoot.position.z);
        lastGroundH = h;

        // integrate vertical
        const floorY = h + eps;
        if (playerRoot.position.y > floorY + 0.001) {
          grounded = false;
          vy += g * dt;
          vy = Math.max(vy, -60);
          playerRoot.position.y += vy * dt;
        }

        // collide with ground
        if (playerRoot.position.y <= floorY) {
          playerRoot.position.y = floorY;
          vy = 0;
          grounded = true;
        }

        // If we're basically on the floor, keep it stable.
        if (Math.abs(playerRoot.position.y - floorY) < 0.002) {
          playerRoot.position.y = floorY;
        }
      }

      // face movement direction (from input intent; feels like a real game)
      const mv = new Vector3(vel.x, 0, vel.z);
      const mvl = mv.length();
      const intent = Math.hypot(input.moveX, input.moveY);
      if (intent > 0.12 && desired.length() > 0.0001) {
        const desiredYaw = Math.atan2(desired.x, desired.z);
        // smooth turn
        const turn = 14;
        const a = clamp(turn * dt, 0, 1);
        yaw = yaw + (wrapAngle(desiredYaw - yaw)) * a;
        playerRoot.rotationQuaternion = Quaternion.FromEulerAngles(0, yaw, 0);
      } else if (mvl > 0.2) {
        yaw = Math.atan2(mv.x, mv.z);
        playerRoot.rotationQuaternion = Quaternion.FromEulerAngles(0, yaw, 0);
      }

      // Re-align the visual mesh so feet actually contact ground.
      // Bounds-based offsets can lie; foot bones are the robust source of truth.
      if (characterOffset && skinnedMesh && (footL || footR)) {
        try {
          const feetY = playerRoot.getAbsolutePosition().y;
          const lpos = footL ? footL.getAbsolutePosition(skinnedMesh) : null;
          const rpos = footR ? footR.getAbsolutePosition(skinnedMesh) : null;
          const fmin = Math.min(lpos?.y ?? Number.POSITIVE_INFINITY, rpos?.y ?? Number.POSITIVE_INFINITY);
          if (Number.isFinite(fmin)) {
            const dy = feetY - fmin;
            // converge quickly without jitter
            characterOffset.position.y += clamp(dy, -0.08, 0.08);
          }
        } catch {}
      }

      // switch animation based on *intent* (so tiny drift doesn't force running forever)
      let anim = "idle";
      {
        const intent = Math.hypot(input.moveX, input.moveY);
        const sp2 = Math.hypot(vel.x, vel.z);
        const running = intent > 0.78 || sp2 > 7.4;
        const moving = intent > 0.14;

        if (walkAG && runAG) {
          if (!moving) {
            // Stop everything every frame to prevent “stuck started” states.
            stopAllCharacterAnims();

            // If we have a walk clip, force the rig into frame-0 pose (better than T-pose).
            if (walkAG && walkAG.targetedAnimations.length > 0) {
              try {
                walkAG.start(false, 1.0);
                walkAG.goToFrame(0);
                walkAG.pause();
              } catch {}
            }

            anim = "idle";
          } else if (running) {
            // ensure no other animations are competing
            try {
              for (const ag of scene.animationGroups) {
                if (ag !== runAG) ag.stop();
              }
            } catch {}
            if (!runAG.isStarted) runAG.start(true, 1.0);
            anim = "run";
          } else {
            try {
              for (const ag of scene.animationGroups) {
                if (ag !== walkAG) ag.stop();
              }
            } catch {}
            if (!walkAG.isStarted) walkAG.start(true, 1.0);
            anim = "walk";
          }

          // drive playback speed a bit
          walkAG.speedRatio = clamp(sp2 / 4.2, 0.6, 1.35);
          runAG.speedRatio = clamp(sp2 / 7.8, 0.8, 1.5);
        }
      }

      // debug HUD (update ~4x/sec)
      dbgAccum += dt;
      if (debugRef.current && dbgAccum > 0.25) {
        dbgAccum = 0;
        const intent = Math.hypot(input.moveX, input.moveY);
        const sp2 = Math.hypot(vel.x, vel.z);
        const ax = input.gp?.axes?.slice(0, 4).map((v) => (Math.round(v * 1000) / 1000).toFixed(3)).join(",") ?? "-";
        const wt = walkAG?.targetedAnimations?.length ?? 0;
        const rt = runAG?.targetedAnimations?.length ?? 0;
        const bones = rigSkeleton?.bones?.length ?? 0;
        debugRef.current.textContent = `anim=${anim} intent=${intent.toFixed(2)} speed=${sp2.toFixed(2)} mx=${input.moveX.toFixed(2)} my=${input.moveY.toFixed(2)} grounded=${grounded ? 1 : 0} y=${playerRoot.position.y.toFixed(2)} gh=${lastGroundH.toFixed(2)} bones=${bones} walkT=${wt} runT=${rt} gpAxes=${ax}`;
      }

      // terrain sculpt while holding input
      if (sculpt) {
        sculptAtPointer(dt);
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
      canvas.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
      // remove mobile listeners (added only on touch devices)
      // (safe even if not registered)
      try {
        canvas.removeEventListener("touchstart", onTouchStartGame as any);
        canvas.removeEventListener("touchmove", onTouchMoveGame as any);
        canvas.removeEventListener("touchend", onTouchEndGame as any);
        canvas.removeEventListener("touchcancel", onTouchEndGame as any);
      } catch {}

      joyState = { mx: 0, my: 0, lx: 0, ly: 0 };
      touchMoveId = null;
      touchLookId = null;
      pinchStartDist = 0;
      pinchStartRadius = 0;
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
          whiteSpace: "pre-line",
        }}
      >
        {`ELEMENT WEAVER (prototype) v${(import.meta as any).env?.VITE_BUILD_ID || "?"}\nmove: WASD / left stick (mobile: left joystick)\ncamera: mouse / right stick (mobile: right joystick)\nsculpt: hold (mouse) or touch • 2-finger touch lowers`}
      </div>

      <div
        ref={(el) => {
          debugRef.current = el;
        }}
        style={{
          position: "absolute",
          left: 16,
          top: 64,
          color: "rgba(180,220,255,0.70)",
          font: "600 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
          userSelect: "none",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}
