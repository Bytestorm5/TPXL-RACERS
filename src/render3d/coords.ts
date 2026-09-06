/**
 * Simulation frame ↔ renderer frame.
 *
 * The simulation (src/sim/types.ts) is right-handed with x EAST, y NORTH, z UP and headings measured
 * counter-clockwise from +x. three.js is right-handed with +Y up. The one mapping used everywhere:
 *
 *     three.x =  sim.x
 *     three.y =  sim.z
 *     three.z = -sim.y
 *
 * which is a proper rotation (det +1), so handedness, cross products and orientations carry over
 * unchanged. A sim heading θ (rotation about sim +z) becomes a rotation of +θ about three +Y.
 *
 * Body frame (VehicleState): x forward, y LEFT, z up; pitch > 0 = nose DOWN (right-hand rotation about
 * body +y), roll > 0 = RIGHT side down (right-hand rotation about body +x). The chassis rotation in the
 * sim world frame is therefore  R = Rz(heading) · Ry(pitch) · Rx(roll)  (yaw, then pitch about the yawed
 * left axis, then roll about the body forward axis).
 *
 * Car meshes are built in a LOCAL frame of x forward, y up, z RIGHT (= −left), which is again a proper
 * rotation of the sim body frame, so `bodyBasis` gives the three.js basis vectors directly.
 *
 * Pure functions, no three.js import — tested in node (tests/render3d.test.ts).
 */

export type Vec3 = [number, number, number];

/** sim (x east, y north, z up) → three (x, y up, z). */
export function simToThree(x: number, y: number, z: number): Vec3 {
  return [x, z, -y];
}

/** three → sim. */
export function threeToSim(x: number, y: number, z: number): Vec3 {
  return [x, -z, y];
}

/** Sim heading (CCW from +x) → rotation about three +Y (radians). Identity by construction. */
export function headingToYaw(heading: number): number {
  return heading;
}

export interface BodyBasis {
  /** Body +x (forward) in the sim world frame. */
  forward: Vec3;
  /** Body +y (left) in the sim world frame. */
  left: Vec3;
  /** Body +z (up) in the sim world frame. */
  up: Vec3;
}

/**
 * Chassis orientation in the SIM world frame: R = Rz(heading)·Ry(pitch)·Rx(roll), returned as the
 * three body axes (the columns of R).
 */
export function bodyBasisSim(heading: number, pitch: number, roll: number): BodyBasis {
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  // Rz·Ry·Rx (standard ZYX), columns = images of the body axes.
  const forward: Vec3 = [ch * cp, sh * cp, -sp];
  const left: Vec3 = [ch * sp * sr - sh * cr, sh * sp * sr + ch * cr, cp * sr];
  const up: Vec3 = [ch * sp * cr + sh * sr, sh * sp * cr - ch * sr, cp * cr];
  return { forward, left, up };
}

export interface ThreeBasis {
  /** Mesh-local +x (forward) in three world. */
  x: Vec3;
  /** Mesh-local +y (up) in three world. */
  y: Vec3;
  /** Mesh-local +z (right) in three world. */
  z: Vec3;
}

/**
 * The three.js basis of a car mesh (local x forward, y up, z right) for a sim pose. Feed the three
 * vectors to `Matrix4.makeBasis(x, y, z)`.
 */
export function bodyBasis(heading: number, pitch: number, roll: number): ThreeBasis {
  const b = bodyBasisSim(heading, pitch, roll);
  const x = simToThree(b.forward[0], b.forward[1], b.forward[2]);
  const y = simToThree(b.up[0], b.up[1], b.up[2]);
  const z = simToThree(-b.left[0], -b.left[1], -b.left[2]);
  return { x, y, z };
}

/** Sim body-local point (x forward, y left, z up) → mesh-local (x forward, y up, z right). */
export function bodyLocalToMesh(x: number, y: number, z: number): Vec3 {
  return [x, z, -y];
}

/** Determinant of a 3×3 given as column vectors — used by the tests to prove the mapping is proper. */
export function det3(a: Vec3, b: Vec3, c: Vec3): number {
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
}

/** Sanitise a sim angle for rendering: non-finite → 0, clamped to ±limit. */
export function safeAngle(v: number, limit: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < -limit ? -limit : v > limit ? limit : v;
}
