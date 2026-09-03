/**
 * Camera rig for the race: chase (behind the car, heading-up, smoothed), hood (fixed to the body,
 * looking forward), top (north-up overhead, the old 2D view's framing) and tv (trackside, fixed
 * positions along the road that hand over as the car passes). `distance` scales the chase camera
 * (the +/− keys) and the top camera's height.
 *
 * All positions are in the THREE frame; the sim pose is converted with coords.ts.
 */
import * as THREE from 'three';
import type { CompiledTrack } from '../sim/track';
import type { VehicleState } from '../sim/types';
import { bodyBasis, simToThree } from './coords';

export const CAMERA_MODES = ['chase', 'hood', 'top', 'tv'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _target = new THREE.Vector3();

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  /** 1 = default chase distance. */
  distance = 1;
  private readonly smoothPos = new THREE.Vector3();
  private readonly smoothLook = new THREE.Vector3();
  private smoothYaw = 0;
  private init = false;
  /** TV camera: the world position it is anchored at, and the arc-length it was placed for. */
  private tvPos = new THREE.Vector3();
  private tvS = -1e9;

  constructor(
    private readonly track: CompiledTrack,
    aspect: number,
  ) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.3, 2500);
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    this.init = false;
    this.tvS = -1e9;
  }

  cycle(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this.mode;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Frame the start line (no car yet). */
  frameStart(): void {
    const c = this.track.centreAt(this.track.startLine);
    const p = simToThree(c.x, c.y, c.z);
    _fwd.set(Math.cos(c.heading), 0, -Math.sin(c.heading));
    this.camera.position.set(p[0] - _fwd.x * 14, p[1] + 6, p[2] - _fwd.z * 14);
    this.camera.lookAt(p[0] + _fwd.x * 10, p[1] + 1, p[2] + _fwd.z * 10);
  }

  update(st: VehicleState, dt: number): void {
    const p = simToThree(st.x, st.y, st.z);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return;
    const heading = Number.isFinite(st.heading) ? st.heading : 0;
    switch (this.mode) {
      case 'hood': {
        const b = bodyBasis(heading, Number.isFinite(st.pitch) ? st.pitch : 0, Number.isFinite(st.roll) ? st.roll : 0);
        _fwd.set(b.x[0], b.x[1], b.x[2]);
        _up.set(b.y[0], b.y[1], b.y[2]);
        _pos.set(p[0], p[1], p[2]).addScaledVector(_fwd, 0.4).addScaledVector(_up, 0.55);
        this.camera.position.copy(_pos);
        _target.copy(_pos).addScaledVector(_fwd, 30).addScaledVector(_up, -0.4);
        this.camera.up.copy(_up);
        this.camera.lookAt(_target);
        return;
      }
      case 'top': {
        const h = 38 * this.distance;
        const k = this.init ? 1 - Math.exp(-dt * 8) : 1;
        _pos.set(p[0], p[1] + h, p[2]);
        this.smoothPos.lerp(_pos, k);
        this.camera.position.copy(this.smoothPos);
        this.camera.up.set(0, 0, -1); // north (sim +y) is up on screen
        this.camera.lookAt(this.smoothPos.x, p[1], this.smoothPos.z);
        this.init = true;
        return;
      }
      case 'tv': {
        // pick a trackside spot ~80 m ahead when the car has passed the current one
        const s = st.road.s;
        const len = this.track.length;
        const passed = this.track.spec.closed ? ((s - this.tvS) % len + len) % len > 110 || this.tvS < -1e8 : s > this.tvS + 110 || this.tvS < -1e8;
        if (passed) {
          const sCam = this.track.spec.closed ? (s + 70) % len : Math.min(len, s + 70);
          const c = this.track.centreAt(sCam);
          const side = (Math.floor(sCam / 200) % 2 === 0 ? 1 : -1) * (c.width / 2 + 9);
          const pose = this.track.poseAt(sCam, side);
          const q = simToThree(pose.x, pose.y, pose.z + 5);
          this.tvPos.set(q[0], q[1], q[2]);
          this.tvS = sCam - 70; // the s at which it was set
        }
        this.camera.position.copy(this.tvPos);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(p[0], p[1] + 0.6, p[2]);
        return;
      }
      default: {
        // chase: behind and above, following a smoothed yaw so the car can slide without the camera snapping
        const d = 8.5 * this.distance;
        const hgt = 3.0 * this.distance;
        if (!this.init) this.smoothYaw = heading;
        else {
          let diff = heading - this.smoothYaw;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          this.smoothYaw += diff * (1 - Math.exp(-dt * 4.5));
        }
        const yaw = this.smoothYaw;
        _fwd.set(Math.cos(yaw), 0, -Math.sin(yaw));
        _right.set(-_fwd.z, 0, _fwd.x);
        _pos.set(p[0], p[1], p[2]).addScaledVector(_fwd, -d);
        _pos.y += hgt;
        // keep the camera above the road behind the car (crests, banking)
        const behind = this.track.sampleAt(st.x - Math.cos(yaw) * d, st.y - Math.sin(yaw) * d, heading);
        const minY = behind.z + 1.2;
        if (_pos.y < minY) _pos.y = minY;
        const k = this.init ? 1 - Math.exp(-dt * 9) : 1;
        this.smoothPos.lerp(_pos, k);
        _target.set(p[0], p[1] + 0.9, p[2]).addScaledVector(_fwd, 4);
        this.smoothLook.lerp(_target, this.init ? 1 - Math.exp(-dt * 12) : 1);
        this.camera.position.copy(this.smoothPos);
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(this.smoothLook);
        this.init = true;
      }
    }
  }
}
