/**
 * Dust / gravel / snow spray: a fixed pool of point sprites with per-particle size, colour and life,
 * drawn with a small custom shader (PointsMaterial has no per-vertex alpha). Spawned by the scene at
 * wheel contact points on loose surfaces when a wheel slides or spins, or at speed on snow/gravel.
 * Deterministic enough for a visual (uses a tiny LCG, not Math.random, so replays look the same).
 */
import * as THREE from 'three';
import type { SurfaceKind } from '../sim/types';

const VERT = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 color;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = alpha;
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    float soft = smoothstep(0.5, 0.15, r);
    gl_FragColor = vec4(vColor, vAlpha * soft);
  }
`;

export class Particles {
  readonly points: THREE.Points;
  private readonly n: number;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly col: Float32Array;
  private readonly baseSize: Float32Array;
  private head = 0;
  private seed = 12345;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;

  constructor(n = 1500) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n).fill(1);
    this.size = new Float32Array(n);
    this.baseSize = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.col = new Float32Array(n * 3);
    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('size', this.sizeAttr);
    geom.setAttribute('alpha', this.alphaAttr);
    geom.setAttribute('color', this.colAttr);
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false });
    this.points = new THREE.Points(geom, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  private rnd(): number {
    // LCG (Numerical Recipes) — visual only
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  static color(kind: SurfaceKind): [number, number, number] {
    switch (kind) {
      case 'snow':
      case 'ice':
        return [0.92, 0.94, 0.97];
      case 'sand':
        return [0.8, 0.7, 0.48];
      case 'grass':
        return [0.35, 0.42, 0.22];
      case 'gravel':
        return [0.6, 0.53, 0.42];
      case 'dirt':
        return [0.5, 0.4, 0.28];
      default:
        return [0.5, 0.5, 0.5];
    }
  }

  /** Spawn at (x,y,z) with a base velocity (three frame), spread and colour. */
  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, kind: SurfaceKind, count: number, size = 0.5, life = 0.9): void {
    const c = Particles.color(kind);
    for (let k = 0; k < count; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.n;
      this.pos[i * 3] = x + (this.rnd() - 0.5) * 0.3;
      this.pos[i * 3 + 1] = y + 0.05;
      this.pos[i * 3 + 2] = z + (this.rnd() - 0.5) * 0.3;
      this.vel[i * 3] = vx + (this.rnd() - 0.5) * 2.5;
      this.vel[i * 3 + 1] = vy + 1.2 + this.rnd() * 2.2;
      this.vel[i * 3 + 2] = vz + (this.rnd() - 0.5) * 2.5;
      const l = life * (0.6 + 0.8 * this.rnd());
      this.life[i] = l;
      this.maxLife[i] = l;
      this.baseSize[i] = size * (0.6 + 0.8 * this.rnd());
      this.col[i * 3] = c[0];
      this.col[i * 3 + 1] = c[1];
      this.col[i * 3 + 2] = c[2];
    }
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    const g = 2.5; // slow fall (dust hangs)
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.vel[i * 3 + 1] -= g * dt;
      this.vel[i * 3] *= 1 - 1.5 * dt;
      this.vel[i * 3 + 2] *= 1 - 1.5 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = 0.55 * t;
      this.size[i] = this.baseSize[i] * (1.6 - t);
    }
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
    this.size.fill(0);
    this.alphaAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.points.removeFromParent();
  }
}
