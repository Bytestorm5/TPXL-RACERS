/**
 * Skid marks as a ring buffer of ribbon quads: one quad per (wheel, frame) segment while the wheel
 * is locked / spinning / at the grip limit on the ground. Oldest segments are overwritten when the
 * buffer is full. Colour by surface (rubber on tarmac, churned dark loose surface, grey on snow).
 */
import * as THREE from 'three';
import type { SurfaceKind } from '../sim/types';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly capacity: number;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private head = 0;
  private count = 0;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private dirtyMin = Infinity;
  private dirtyMax = -Infinity;

  constructor(capacity = 24000, readonly width = 0.24) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 4 * 3);
    this.col = new Float32Array(capacity * 4 * 4);
    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.colAttr = new THREE.BufferAttribute(this.col, 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('color', this.colAttr);
    const idx = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    geom.setDrawRange(0, 0);
    // a huge bounding sphere so the mesh is never culled (segments are anywhere on the track)
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  static color(kind: SurfaceKind): [number, number, number, number] {
    switch (kind) {
      case 'asphalt':
      case 'concrete':
      case 'wet_asphalt':
      case 'curb':
        return [0.03, 0.03, 0.035, 0.55];
      case 'snow':
      case 'ice':
        return [0.45, 0.52, 0.6, 0.45];
      default:
        return [0.2, 0.16, 0.11, 0.5];
    }
  }

  /** Append a segment from world point a to b (three frame). Points must be on the road surface. */
  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, kind: SurfaceKind): void {
    _a.set(ax, ay, az);
    _b.set(bx, by, bz);
    _d.subVectors(_b, _a);
    const len = _d.length();
    if (!(len > 0.01) || len > 4) return;
    _d.divideScalar(len);
    _n.crossVectors(_d, _up).normalize().multiplyScalar(this.width / 2);
    const i = this.head;
    const base = i * 12;
    const p = this.pos;
    const lift = 0.015;
    p[base] = ax - _n.x;
    p[base + 1] = ay + lift;
    p[base + 2] = az - _n.z;
    p[base + 3] = ax + _n.x;
    p[base + 4] = ay + lift;
    p[base + 5] = az + _n.z;
    p[base + 6] = bx + _n.x;
    p[base + 7] = by + lift;
    p[base + 8] = bz + _n.z;
    p[base + 9] = bx - _n.x;
    p[base + 10] = by + lift;
    p[base + 11] = bz - _n.z;
    const c = SkidMarks.color(kind);
    const cb = i * 16;
    for (let k = 0; k < 4; k++) {
      this.col[cb + k * 4] = c[0];
      this.col[cb + k * 4 + 1] = c[1];
      this.col[cb + k * 4 + 2] = c[2];
      this.col[cb + k * 4 + 3] = c[3];
    }
    this.dirtyMin = Math.min(this.dirtyMin, i);
    this.dirtyMax = Math.max(this.dirtyMax, i);
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Upload the changed range. Call once per frame after all `add`s. */
  flush(): void {
    if (this.dirtyMax < this.dirtyMin) return;
    const from = this.dirtyMin;
    const to = this.dirtyMax + 1;
    this.posAttr.addUpdateRange(from * 12, (to - from) * 12);
    this.posAttr.needsUpdate = true;
    this.colAttr.addUpdateRange(from * 16, (to - from) * 16);
    this.colAttr.needsUpdate = true;
    (this.mesh.geometry as THREE.BufferGeometry).setDrawRange(0, this.count * 6);
    this.dirtyMin = Infinity;
    this.dirtyMax = -Infinity;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    (this.mesh.geometry as THREE.BufferGeometry).setDrawRange(0, 0);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}
