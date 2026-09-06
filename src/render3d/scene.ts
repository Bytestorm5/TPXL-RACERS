/**
 * The 3D race scene (three.js): renderer, sky, sun, terrain, track mesh, trackside posts and the
 * start gantry, one CarMesh per RaceCar, skid ribbons, dust particles and the camera rig.
 *
 * `update(race, snap, playerIndex, dt)` poses everything from the sim state; `render()` draws.
 * All sim → three conversion goes through coords.ts. Nothing here reads a CarBuild.
 */
import * as THREE from 'three';
import type { Race, RaceCar, RaceSnapshot } from '../sim/race';
import type { CompiledTrack } from '../sim/track';
import type { SurfaceKind } from '../sim/types';
import { CameraRig, type CameraMode } from './camera';
import { CarMesh } from './carMesh';
import { simToThree } from './coords';
import { Particles } from './particles';
import { SkidMarks } from './skidMarks';
import { buildTerrain } from './terrain';
import { buildTrackMesh, SHOULDER_M, type TrackMeshData } from './trackGeometry';

/** Skid marks / dust are skipped beyond this many cars (same threshold as the 2D view had). */
export const FX_MAX_CARS = 8;

export type Quality = 'high' | 'low';

/**
 * Probe the GPU string with a throwaway context. Software rasterizers (SwiftShader, llvmpipe, Mesa
 * software) get the 'low' preset: no shadow maps, no MSAA, half resolution — still the same scene.
 */
export function detectQuality(): { quality: Quality; gpu: string } {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!gl) return { quality: 'low', gpu: '' };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    const software = /swiftshader|llvmpipe|softpipe|software|mesa offscreen/i.test(gpu);
    return { quality: software ? 'low' : 'high', gpu };
  } catch {
    return { quality: 'high', gpu: '' };
  }
}
const LOOSE: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(['gravel', 'dirt', 'grass', 'sand', 'snow', 'ice']);

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_Position.z = gl_Position.w; // always at the far plane
  }
`;
const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uTop;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSun;
  void main() {
    float h = vDir.y;
    vec3 c = h >= 0.0 ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uGround, clamp(-h * 3.0, 0.0, 1.0));
    float sun = pow(max(dot(vDir, normalize(uSun)), 0.0), 220.0);
    c += vec3(1.0, 0.92, 0.75) * sun * 1.5;
    gl_FragColor = vec4(c, 1.0);
  }
`;

/** Convert pure mesh data (sim frame) into a BufferGeometry in the three frame. */
export function toGeometry(data: { positions: Float32Array; normals: Float32Array; colors: Float32Array; indices: Uint32Array }): THREE.BufferGeometry {
  const n = data.positions.length / 3;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = simToThree(data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]);
    pos[i * 3] = p[0];
    pos[i * 3 + 1] = p[1];
    pos[i * 3 + 2] = p[2];
    const m = simToThree(data.normals[i * 3], data.normals[i * 3 + 1], data.normals[i * 3 + 2]);
    nor[i * 3] = m[0];
    nor[i * 3 + 1] = m[1];
    nor[i * 3 + 2] = m[2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  g.setIndex(new THREE.BufferAttribute(data.indices, 1));
  g.computeBoundingSphere();
  return g;
}

interface Palette {
  top: number;
  horizon: number;
  ground: number;
  fog: number;
  sun: number;
  sunIntensity: number;
  ambient: number;
}

function paletteFor(track: CompiledTrack): Palette {
  const sh = track.spec.defaultShoulder;
  const cold = sh === 'snow' || sh === 'ice';
  const desert = sh === 'sand';
  if (cold) return { top: 0x7fa4c8, horizon: 0xdfe8f0, ground: 0xc9d3dc, fog: 0xd6dfe8, sun: 0xfff4e0, sunIntensity: 2.2, ambient: 0.9 };
  if (desert) return { top: 0x6aa0d8, horizon: 0xf2d9b0, ground: 0xb9a480, fog: 0xe8d4b4, sun: 0xfff0d0, sunIntensity: 3.0, ambient: 0.75 };
  return { top: 0x5b93d6, horizon: 0xcfe0ee, ground: 0x6f7a6a, fog: 0xc7d6e2, sun: 0xfff1d6, sunIntensity: 2.6, ambient: 0.7 };
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);

export class RaceScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly trackMesh: THREE.Mesh;
  readonly terrainMesh: THREE.Mesh;
  readonly meshData: TrackMeshData;
  private readonly sun: THREE.DirectionalLight;
  private readonly sunTarget = new THREE.Object3D();
  private readonly skids = new SkidMarks();
  private readonly dust = new Particles();
  private cars: CarMesh[] = [];
  private prevContact = new Float32Array(0);
  private prevValid = new Uint8Array(0);
  private dustAcc = 0;
  private disposed = false;
  /** Draw calls / triangles of the last frame (debug). */
  stats = { calls: 0, triangles: 0 };
  readonly quality: Quality;
  /** Device-pixel-ratio cap for this quality preset. */
  private readonly dprCap: number;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly track: CompiledTrack,
    opts: { quality?: Quality } = {},
  ) {
    this.quality = opts.quality ?? detectQuality().quality;
    const low = this.quality === 'low';
    this.dprCap = low ? 0.5 : 1.5;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !low, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = !low;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const pal = paletteFor(track);
    this.scene.fog = new THREE.Fog(pal.fog, 250, 1400);

    // sky dome
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uTop: { value: new THREE.Color(pal.top) },
        uHorizon: { value: new THREE.Color(pal.horizon) },
        uGround: { value: new THREE.Color(pal.ground) },
        uSun: { value: new THREE.Vector3(0.45, 0.5, -0.35) },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), skyMat);
    sky.scale.setScalar(2000);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.scene.add(sky);

    // lights
    const hemi = new THREE.HemisphereLight(pal.horizon, pal.ground, pal.ambient);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(pal.sun, pal.sunIntensity);
    this.sun.position.set(90, 120, -70);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 20;
    this.sun.shadow.camera.far = 400;
    this.sun.shadow.camera.left = -45;
    this.sun.shadow.camera.right = 45;
    this.sun.shadow.camera.top = 45;
    this.sun.shadow.camera.bottom = -45;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.05;
    this.sun.target = this.sunTarget;
    this.scene.add(this.sun, this.sunTarget);

    // terrain + road
    const terrain = buildTerrain(track);
    this.terrainMesh = new THREE.Mesh(toGeometry(terrain), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
    this.terrainMesh.receiveShadow = true;
    this.scene.add(this.terrainMesh);

    this.meshData = buildTrackMesh(track);
    this.trackMesh = new THREE.Mesh(toGeometry(this.meshData), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    this.trackMesh.receiveShadow = true;
    this.scene.add(this.trackMesh);

    this.buildDecor();
    this.scene.add(this.skids.mesh, this.dust.points);

    this.rig = new CameraRig(track, 16 / 9);
    this.rig.frameStart();
  }

  // ---------------------------------------------------------------- decor

  /** Marker posts along both shoulders every 25 m, a start/finish gantry and distance boards. */
  private buildDecor(): void {
    const track = this.track;
    const spacing = 25;
    const count = Math.max(1, Math.floor(track.length / spacing));
    const postGeom = new THREE.BoxGeometry(0.12, 1.1, 0.12);
    postGeom.translate(0, 0.55, 0);
    const posts = new THREE.InstancedMesh(postGeom, new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.7 }), count * 2);
    const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.22, 0.14), new THREE.MeshStandardMaterial({ color: 0xff3b2f, roughness: 0.6 }), count * 2);
    let k = 0;
    for (let i = 0; i < count; i++) {
      const s = i * spacing;
      const c = track.centreAt(s);
      const edge = c.width / 2 + SHOULDER_M - 1.5;
      for (const side of [edge, -edge]) {
        const pose = track.poseAt(s, side);
        const z = c.z - side * Math.tan(c.bank);
        const p = simToThree(pose.x, pose.y, z);
        _q.setFromAxisAngle(_v.set(0, 1, 0), pose.heading);
        _m.compose(_w.set(p[0], p[1], p[2]), _q, _s);
        posts.setMatrixAt(k, _m);
        _m.compose(_w.set(p[0], p[1] + 1.1, p[2]), _q, _s);
        caps.setMatrixAt(k, _m);
        k++;
      }
    }
    posts.count = k;
    caps.count = k;
    posts.castShadow = true;
    this.scene.add(posts, caps);

    // start/finish gantry
    const c = track.centreAt(track.startLine);
    const hw = c.width / 2 + 1.2;
    const postMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6, metalness: 0.5 });
    const beamMat = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5, metalness: 0.2 });
    const gantry = new THREE.Group();
    for (const side of [hw, -hw]) {
      const pose = track.poseAt(track.startLine, side);
      const z = c.z - side * Math.tan(c.bank);
      const p = simToThree(pose.x, pose.y, z);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6, 0.3), postMat);
      post.position.set(p[0], p[1] + 3, p[2]);
      post.castShadow = true;
      gantry.add(post);
    }
    const centre = simToThree(c.x, c.y, c.z);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, hw * 2 + 0.3), beamMat);
    beam.position.set(centre[0], centre[1] + 6.2, centre[2]);
    beam.rotation.y = c.heading;
    beam.castShadow = true;
    gantry.add(beam);
    this.scene.add(gantry);
  }

  // ----------------------------------------------------------------- cars

  setCars(cars: RaceCar[], playerIndex: number): void {
    for (const c of this.cars) c.dispose();
    this.cars = cars.map((c) => new CarMesh(c.entry.spec, { player: c.index === playerIndex }));
    for (const c of this.cars) this.scene.add(c.group);
    this.prevContact = new Float32Array(cars.length * 4 * 3);
    this.prevValid = new Uint8Array(cars.length * 4);
    this.skids.clear();
    this.dust.clear();
    this.rig.setMode(this.rig.mode);
  }

  setCameraMode(mode: CameraMode): void {
    this.rig.setMode(mode);
  }

  resize(width: number, height: number, dpr: number): void {
    this.renderer.setPixelRatio(Math.min(dpr, this.dprCap));
    this.renderer.setSize(width, height, false);
    this.rig.resize(width / Math.max(1, height));
  }

  /** Pose cars, camera, FX from the sim. `dt` = frame seconds (0 while paused). */
  update(race: Race, snap: RaceSnapshot, playerIndex: number, dt: number, now: number): void {
    const cars = race.cars;
    for (let i = 0; i < cars.length && i < this.cars.length; i++) {
      this.cars[i].update(cars[i].state, dt, cars[i].lastImpact, now);
    }
    const focusIndex = playerIndex >= 0 ? playerIndex : snap.order.length > 0 ? snap.order[0] : 0;
    const focus = cars[focusIndex];
    if (focus) {
      this.rig.update(focus.state, dt);
      // shadow frustum follows the focus car
      const p = simToThree(focus.state.x, focus.state.y, focus.state.z);
      this.sunTarget.position.set(p[0], p[1], p[2]);
      this.sun.position.set(p[0] + 90, p[1] + 120, p[2] - 70);
      this.sunTarget.updateMatrixWorld();
    }
    if (dt > 0 && cars.length <= FX_MAX_CARS) this.updateFx(cars, dt);
    this.dust.update(dt);
  }

  private updateFx(cars: RaceCar[], dt: number): void {
    this.dustAcc += dt;
    const spawnTick = this.dustAcc >= 1 / 30;
    if (spawnTick) this.dustAcc = 0;
    for (let i = 0; i < cars.length && i < this.cars.length; i++) {
      const st = cars[i].state;
      const mesh = this.cars[i];
      const moving = st.speed > 1.5;
      for (let w = 0; w < 4; w++) {
        const ws = st.wheels[w];
        const idx = i * 4 + w;
        mesh.contactPoint(w, _v);
        const px = this.prevContact[idx * 3];
        const py = this.prevContact[idx * 3 + 1];
        const pz = this.prevContact[idx * 3 + 2];
        const sliding = moving && ws.onGround && (ws.locked || ws.spinning || ws.utilisation > 0.98);
        if (sliding && this.prevValid[idx] === 1) this.skids.add(px, py, pz, _v.x, _v.y, _v.z, ws.surface);
        if (spawnTick && ws.onGround && LOOSE.has(ws.surface)) {
          const strong = ws.locked || ws.spinning || ws.utilisation > 0.9;
          if (strong || st.speed > 12) {
            // fling roughly backwards along the car's motion
            _prev.set(_v.x - px, _v.y - py, _v.z - pz);
            const inv = dt > 0 ? 1 / dt : 0;
            const n = strong ? 3 : 1;
            this.dust.spawn(_v.x, _v.y, _v.z, -_prev.x * inv * 0.25, 0.2, -_prev.z * inv * 0.25, ws.surface, n, strong ? 0.7 : 0.45, strong ? 1.1 : 0.7);
          }
        }
        this.prevContact[idx * 3] = _v.x;
        this.prevContact[idx * 3 + 1] = _v.y;
        this.prevContact[idx * 3 + 2] = _v.z;
        this.prevValid[idx] = 1;
      }
    }
    this.skids.flush();
  }

  /** Unmasked GPU renderer string (for perf logs: software rasterizers are far slower). */
  gpuName(): string {
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    } catch {
      return '';
    }
  }

  render(): void {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.rig.camera);
    this.stats.calls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.cars) c.dispose();
    this.cars = [];
    this.skids.dispose();
    this.dust.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
