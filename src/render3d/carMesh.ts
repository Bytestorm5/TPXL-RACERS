/**
 * A car in the scene: procedural boxes + four wheels from `buildCarGeometry(spec)`, posed from the
 * VehicleState every frame (position, heading/pitch/roll via `bodyBasis`, steer, wheel spin from
 * omega, suspension travel from `compression`, brake lights, impact flash).
 *
 * Mesh-local frame: x forward, y up, z right (see coords.ts).
 */
import * as THREE from 'three';
import type { VehicleSpec, VehicleState } from '../sim/types';
import { buildCarGeometry, wheelHubZ, type CarGeometry } from './carGeometry';
import { bodyBasis, bodyLocalToMesh, safeAngle, simToThree } from './coords';

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();

export interface CarVisualFlags {
  player: boolean;
}

/** Shared geometries (unit box / unit cylinder scaled per part). */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const WHEEL_GEOM = new THREE.CylinderGeometry(1, 1, 1, 18, 1);
WHEEL_GEOM.rotateX(Math.PI / 2); // cylinder axis along local z (= the axle, body LEFT/RIGHT)
const RIM_GEOM = new THREE.CylinderGeometry(0.62, 0.62, 1.04, 8, 1);
RIM_GEOM.rotateX(Math.PI / 2);

const TYRE_MAT = new THREE.MeshStandardMaterial({ color: 0x151618, roughness: 0.92, metalness: 0.05 });
const RIM_MAT = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.4, metalness: 0.7 });
const GLASS_MAT = new THREE.MeshStandardMaterial({ color: 0x1a222c, roughness: 0.15, metalness: 0.3 });
const DARK_MAT = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.6, metalness: 0.3 });
const HEAD_ON = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff2c0, emissiveIntensity: 0.9, roughness: 0.4 });

export class CarMesh {
  readonly group = new THREE.Group();
  readonly geometry: CarGeometry;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly tailMat: THREE.MeshStandardMaterial;
  private readonly wheelPivots: THREE.Object3D[] = [];
  private readonly wheelSpin: THREE.Object3D[] = [];
  private readonly spinAngle = [0, 0, 0, 0];
  private readonly bodyParts: THREE.Mesh[] = [];
  private flashUntil = 0;
  private lastImpactSeen = 0;

  constructor(readonly spec: VehicleSpec, readonly flags: CarVisualFlags) {
    this.geometry = buildCarGeometry(spec);
    const color = new THREE.Color(spec.color || '#ff7a1a');
    this.bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.25 });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x5a1414, emissive: 0x3a0000, emissiveIntensity: 0.4, roughness: 0.5 });

    for (const b of this.geometry.boxes) {
      let mat: THREE.Material;
      switch (b.role) {
        case 'cabin':
          mat = GLASS_MAT;
          break;
        case 'wing':
        case 'wingPost':
        case 'splitter':
          mat = DARK_MAT;
          break;
        case 'tailLight':
          mat = this.tailMat;
          break;
        case 'headLight':
          mat = HEAD_ON;
          break;
        default:
          mat = this.bodyMat;
      }
      const mesh = new THREE.Mesh(UNIT_BOX, mat);
      const c = bodyLocalToMesh(b.cx, b.cy, b.cz);
      mesh.position.set(c[0], c[1], c[2]);
      mesh.scale.set(b.sx, b.sz, b.sy); // mesh y = body z (up), mesh z = body y (width)
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      if (b.role === 'body' || b.role === 'nose') this.bodyParts.push(mesh);
    }

    for (const w of this.geometry.wheels) {
      const pivot = new THREE.Object3D(); // steer about local up
      const c = bodyLocalToMesh(w.cx, w.cy, w.cz);
      pivot.position.set(c[0], c[1], c[2]);
      const spin = new THREE.Object3D(); // rolls about the axle (local z)
      const tyre = new THREE.Mesh(WHEEL_GEOM, TYRE_MAT);
      tyre.scale.set(w.radius, w.radius, w.width);
      tyre.castShadow = true;
      const rim = new THREE.Mesh(RIM_GEOM, RIM_MAT);
      rim.scale.set(w.radius, w.radius, w.width);
      spin.add(tyre, rim);
      pivot.add(spin);
      this.group.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelSpin.push(spin);
    }
    if (flags.player) {
      // a thin light bar on the roof so the player's car is easy to find in the pack from the TV/top cameras
      const bar = new THREE.Mesh(UNIT_BOX, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5 }));
      const cab = this.geometry.boxes.find((b) => b.role === 'cabin');
      if (cab) {
        const c = bodyLocalToMesh(cab.cx, cab.cy, cab.cz + cab.sz / 2 + 0.02);
        bar.position.set(c[0], c[1], c[2]);
        bar.scale.set(0.12, 0.03, cab.sy * 0.5);
        this.group.add(bar);
      }
    }
  }

  /** Pose + animate from the sim state. `dt` in seconds (wheel spin integration). */
  update(st: VehicleState, dt: number, lastImpact: number, now: number): void {
    const p = simToThree(st.x, st.y, st.z);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return;
    const basis = bodyBasis(st.heading, safeAngle(st.pitch, 1.4), safeAngle(st.roll, 3.2));
    _x.set(basis.x[0], basis.x[1], basis.x[2]);
    _y.set(basis.y[0], basis.y[1], basis.y[2]);
    _z.set(basis.z[0], basis.z[1], basis.z[2]);
    _m.makeBasis(_x, _y, _z);
    _p.set(p[0], p[1], p[2]);
    _m.setPosition(_p);
    this.group.matrixAutoUpdate = false;
    this.group.matrix.copy(_m);
    this.group.matrixWorldNeedsUpdate = true;

    const travel = this.spec.suspension.travel;
    for (let i = 0; i < 4; i++) {
      const w = st.wheels[i];
      const part = this.geometry.wheels[i];
      const pivot = this.wheelPivots[i];
      pivot.position.y = wheelHubZ(part, w, travel);
      // steer: sim steer > 0 turns LEFT (CCW about body up = mesh +y)
      pivot.rotation.y = part.steerable ? safeAngle(w.steer, 1.2) : 0;
      // spin: forward rolling = rotation about the axle; mesh +z is the RIGHT-pointing axle, a wheel
      // rolling forward rotates negative about +z (right-hand rule: +x → −y).
      const omega = Number.isFinite(w.omega) ? w.omega : 0;
      this.spinAngle[i] = (this.spinAngle[i] - omega * dt) % (Math.PI * 2);
      this.wheelSpin[i].rotation.z = this.spinAngle[i];
    }

    const braking = st.input.brake > 0.05 || st.input.handbrake > 0.5;
    this.tailMat.emissiveIntensity = braking ? 2.2 : 0.4;
    this.tailMat.emissive.setHex(braking ? 0xff2020 : 0x3a0000);

    if (lastImpact > 500 && lastImpact !== this.lastImpactSeen) {
      this.lastImpactSeen = lastImpact;
      this.flashUntil = now + 0.18;
    }
    const flash = now < this.flashUntil;
    const e = this.bodyMat.emissive;
    if (flash) {
      e.setHex(0xffffff);
      this.bodyMat.emissiveIntensity = 0.5;
    } else if (this.bodyMat.emissiveIntensity !== 0) {
      e.setHex(0x000000);
      this.bodyMat.emissiveIntensity = 0;
    }
  }

  /** World position of a wheel contact patch (mesh frame under the hub), for skid marks / dust. */
  contactPoint(i: number, out: THREE.Vector3): THREE.Vector3 {
    const part = this.geometry.wheels[i];
    const pivot = this.wheelPivots[i];
    out.set(pivot.position.x, pivot.position.y - part.radius + 0.02, pivot.position.z);
    return out.applyMatrix4(this.group.matrix);
  }

  dispose(): void {
    this.bodyMat.dispose();
    this.tailMat.dispose();
    this.group.removeFromParent();
  }
}
