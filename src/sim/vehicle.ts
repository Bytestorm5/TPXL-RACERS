/**
 * Vehicle dynamics — the heart of RACERS.
 *
 * The chassis is a 6-DOF rigid body (CG position x, y, z; yaw / pitch / roll; body-frame
 * velocity vx, vy, vz; body rates p = rollRate, q = pitchRate, r = yawRate) resting on four
 * MASSLESS spring/damper struts at the wheel positions. Load transfer, dive/squat, body roll,
 * wheel lift, jumps and rollovers all emerge from that one model — there are no separate
 * quasi-static load-transfer formulas.
 *
 * Conventions (right-hand rule about body axes; body x forward, y LEFT, z up):
 *   pitch > 0 = nose DOWN, roll > 0 = RIGHT side DOWN, yaw CCW positive.
 *   g_body = (+g sin(pitch), −g sin(roll) cos(pitch), −g cos(roll) cos(pitch)).
 *   RoadSample.bankAcross > 0 = RIGHT side of the road higher → a car sitting flat on a +10°
 *   bank has roll = −10°.
 *
 * Per substep (≤ 1/240 s): steering + throttle lag → strut compressions from the body pose and
 * the ground under each corner (incl. surface roughness) → strut forces (spring, damper, ARB,
 * bump stop, jacking) = tyre normal loads → wheel kinematics (slip angle / ratio) → engine,
 * gearbox, differentials, brakes → per-wheel quasi-static torque balance (grip / ABS / locked /
 * wheelspin) → tyre forces (tire.ts) → body forces & moments (tyres, struts, aero, rolling and
 * surface drag, gravity, hull-contact penalties, wheel angular-momentum reaction) → semi-implicit
 * Euler on velocities, Euler-angle kinematics, position → thermal / wear → telemetry.
 * See docs/notes/vehicle.md for the full algorithm, simplifications and telemetry guide.
 */
import { aeroForcesInto } from './aero';
import type { AeroForces } from './aero';
import { brakeTorque, updateBrakeState } from './brakes';
import { autoShiftGear, overallRatio, rpmFromWheelSpeed, splitAxleTorque, wheelOmegaFromRpm, RAD_S_TO_RPM } from './drivetrain';
import { engineTorque } from './engine';
import { clamp, clamp01, smoothstep, wrapAngle } from './math';
import { roughnessHeight } from './roads';
import { createTireOutput, tireForcesInto, tirePeakSlip, tireSlideRatio, updateTireState } from './tire';
import type { TireForcesResult } from './tire';
import { G } from './types';
import type { DriverInput, RoadQuery, RoadSample, SurfaceProps, TireInput, VehicleSpec, VehicleState, WheelState } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Recommended fixed simulation step (s). */
export const SIM_DT = 1 / 120;
/** Internal substep ceiling (s). */
export const MAX_SUBSTEP = 1 / 240;
/** Body tilt (cos) beyond which the struts are disabled and the car is a tumbling box. */
export const TIP_TILT_DEG = 55;
const TIP_COS = Math.cos((TIP_TILT_DEG * Math.PI) / 180);
/** Low-speed regularisation (m/s) shared by slip ratio, slip power and slip-angle fade. */
const V_EPS = 1.5;
/** Tyre-enveloping time constant (s): the damper does not see 0.5 m stones as vertical steps. */
const ROUGHNESS_TAU = 0.012;
/** Hull contact penalty spring (N/m), damper (N·s/m), and Coulomb friction (sliding on the shell / on wheels). */
const HULL_K = 150e3;
const HULL_C = 6e3;
const HULL_MU = 0.6;
const HULL_MU_WHEEL = 0.9;
/** Wrecked when tilted past TIP_TILT_DEG for longer than this (s). */
const WRECK_TILT_TIME = 2;
/** Fraction of the camber-adjusted longitudinal room actually usable before lockup / spin. */
const LONG_ROOM_MARGIN = 0.97;
/** ABS target as a fraction of the peak slip ratio. */
const ABS_SLIP_FRACTION = 0.9;
/** Settle substeps run by createVehicleState / resetVehicleState. */
const SETTLE_SUBSTEPS = 240;
/** Reported engine rpm saturates at limiter × this (the fuel cut). */
const RPM_REPORT_OVERSHOOT = 1.03;
/** Auto-gearbox hysteresis (s): downshift block after an upshift (longer after a wheelspin-induced one), upshift block after a downshift. */
const SHIFT_HOLD_DOWN = 1.5;
const SHIFT_HOLD_DOWN_SPIN = 3;
const SHIFT_HOLD_UP = 0.5;
/** Hull corners closer than this (m) to the local road plane are sampled for penetration. */
const HULL_CHECK_CLEARANCE = 0.08;
/** Beyond halfWidth + this (m) from the centreline the wheels reuse the CG road sample (plane). */
const FAR_OFF_MARGIN = 6;

/** RoadSample for a point offset (dx, dy) from a sampled point on its local plane (same surface). */
function planeExtrapolate(base: RoadSample, gx: number, gy: number, dx: number, dy: number): RoadSample {
  return {
    z: base.z + gx * dx + gy * dy,
    gradeAlong: base.gradeAlong,
    bankAcross: base.bankAcross,
    surface: base.surface,
    onTrack: base.onTrack,
    s: base.s,
    lateral: base.lateral,
    halfWidth: base.halfWidth,
    trackHeading: base.trackHeading,
    curvature: base.curvature,
  };
}

export const NEUTRAL_INPUT: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false };

export interface Pose {
  x: number;
  y: number;
  heading: number;
}

// ---------------------------------------------------------------------------
// Internal (per-state) scratch — not part of the frozen VehicleState contract
// ---------------------------------------------------------------------------

interface WheelScratch {
  /** Body-frame position of the strut top / wheel centre line (x, y); z = 0. */
  x: number;
  y: number;
  /** Strut compression (m, + bump) and its finite-difference rate. */
  delta: number;
  deltaPrev: number;
  rate: number;
  /** Low-pass filtered roughness offset under the wheel (m). */
  rough: number;
  /** Strut force = tyre normal load (N). */
  load: number;
  onGround: boolean;
  /** Body-frame lateral tyre force from the previous substep (jacking). */
  fyBodyPrev: number;
  fyBody: number;
  /** Wheel-frame contact velocities and slips. */
  vwx: number;
  vwy: number;
  vRef: number;
  alpha: number;
  kappa: number;
  camber: number;
  steer: number;
  /** Torques this substep (Nm). */
  tDrive: number;
  tBrake: number;
  tBrakeApplied: number;
  brakePower: number;
  /** Wheel is being integrated explicitly (drive overload). */
  integrating: boolean;
  spinning: boolean;
  locked: boolean;
  diffSpin: boolean;
  /** Reaction torque of the wheel's angular acceleration on the body about y (Nm). */
  reaction: number;
  /** Ground data under the wheel this substep (sample + world gradient dz/dx, dz/dy of the local plane). */
  sample: RoadSample | null;
  surface: SurfaceProps;
  gx: number;
  gy: number;
  /** Tyre model outputs: preliminary (kappa = 0) and final. */
  out0: TireForcesResult;
  out: TireForcesResult;
  peakKappa: number;
  peakAlpha: number;
  /** Capacity (Nm) for the differential, from the preliminary call. */
  capNm: number;
}

interface Internal {
  vzBody: number;
  /** Attitude quaternion body→world (w, x, y, z); the state's Euler angles are derived from it. */
  qw: number;
  qx: number;
  qy: number;
  qz: number;
  /** Euler angles last written to the state (an external edit → rebuild the quaternion). */
  eYaw: number;
  ePitch: number;
  eRoll: number;
  wheels: [WheelScratch, WheelScratch, WheelScratch, WheelScratch];
  rateValid: boolean;
  tiltTime: number;
  prevShiftUp: boolean;
  prevShiftDown: boolean;
  /** TCU hysteresis: seconds during which auto downshifts / (non-limiter) upshifts are blocked. */
  holdDown: number;
  holdUp: number;
  aero: AeroForces;
  tireIn: TireInput;
  /** Hull corners touched the ground this step (telemetry / debugging). */
  hullContacts: number;
}

const INTERNAL = new WeakMap<VehicleState, Internal>();

function makeWheelScratch(x: number, y: number): WheelScratch {
  return {
    x,
    y,
    delta: 0,
    deltaPrev: 0,
    rate: 0,
    rough: 0,
    load: 0,
    onGround: true,
    fyBodyPrev: 0,
    fyBody: 0,
    vwx: 0,
    vwy: 0,
    vRef: V_EPS,
    alpha: 0,
    kappa: 0,
    camber: 0,
    steer: 0,
    tDrive: 0,
    tBrake: 0,
    tBrakeApplied: 0,
    brakePower: 0,
    integrating: false,
    spinning: false,
    locked: false,
    diffSpin: false,
    reaction: 0,
    sample: null,
    surface: { kind: 'asphalt', grip: 1, rollingResistance: 0, roughness: 0, drag: 0, peakSlipScale: 1, slideRetention: 0 },
    gx: 0,
    gy: 0,
    out0: createTireOutput(),
    out: createTireOutput(),
    peakKappa: 0.1,
    peakAlpha: 0.1,
    capNm: 0,
  };
}

function cornerPositions(spec: VehicleSpec): Array<[number, number]> {
  const a = spec.cgToFront;
  const b = spec.wheelbase - a;
  const tf = spec.trackFront / 2;
  const tr = spec.trackRear / 2;
  return [
    [a, tf],
    [a, -tf],
    [-b, tr],
    [-b, -tr],
  ];
}

function makeInternal(spec: VehicleSpec): Internal {
  const c = cornerPositions(spec);
  const surface: SurfaceProps = { kind: 'asphalt', grip: 1, rollingResistance: 0, roughness: 0, drag: 0, peakSlipScale: 1, slideRetention: 0 };
  return {
    vzBody: 0,
    qw: 1,
    qx: 0,
    qy: 0,
    qz: 0,
    eYaw: NaN,
    ePitch: NaN,
    eRoll: NaN,
    wheels: [makeWheelScratch(c[0][0], c[0][1]), makeWheelScratch(c[1][0], c[1][1]), makeWheelScratch(c[2][0], c[2][1]), makeWheelScratch(c[3][0], c[3][1])],
    rateValid: false,
    tiltTime: 0,
    prevShiftUp: false,
    prevShiftDown: false,
    holdDown: 0,
    holdUp: 0,
    aero: { drag: 0, downFront: 0, downRear: 0 },
    tireIn: { load: 0, slipAngle: 0, slipRatio: 0, camber: 0, surface, temp: 20, wear: 0, speed: V_EPS },
    hullContacts: 0,
  };
}

/** Internal record for a state; (re)created lazily so cloned/deserialised states still step. */
function internalOf(spec: VehicleSpec, state: VehicleState): Internal {
  let it = INTERNAL.get(state);
  if (!it) {
    it = makeInternal(spec);
    // Recover the body-frame vertical velocity from the world one as well as we can.
    const cp = Math.cos(state.pitch);
    const cr = Math.cos(state.roll);
    it.vzBody = state.vz * cp * cr;
    it.rateValid = false;
    for (let i = 0; i < 4; i++) {
      it.wheels[i].delta = state.wheels[i].compression;
      it.wheels[i].deltaPrev = state.wheels[i].compression;
    }
    INTERNAL.set(state, it);
  } else {
    const c = cornerPositions(spec);
    for (let i = 0; i < 4; i++) {
      it.wheels[i].x = c[i][0];
      it.wheels[i].y = c[i][1];
    }
  }
  return it;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Static axle loads (N) on level ground, no aero: [front, rear]. */
export function staticAxleLoads(spec: VehicleSpec): [number, number] {
  const L = spec.wheelbase > 0 ? spec.wheelbase : 1;
  const a = clamp(spec.cgToFront, 0, L);
  const W = spec.mass * G;
  return [(W * (L - a)) / L, (W * a) / L];
}

/**
 * Bias-bar brake proportioning: `bias` is the fraction of total brake torque delivered to the
 * front axle. The stronger side always receives full pedal pressure; the other side is scaled so
 * that mF·pF / (mF·pF + mR·pR) = bias exactly.
 */
export function brakeLinePressures(bias: number, maxTorqueFront: number, maxTorqueRear: number): { front: number; rear: number } {
  const mF = maxTorqueFront > 0 ? maxTorqueFront : 1e-9;
  const mR = maxTorqueRear > 0 ? maxTorqueRear : 1e-9;
  const b = bias === bias ? clamp(bias, 1e-6, 1 - 1e-6) : 0.5;
  const neutral = mF / (mF + mR);
  if (b >= neutral) return { front: 1, rear: clamp01(((1 - b) / b) * (mF / mR)) };
  return { front: clamp01((b / (1 - b)) * (mR / mF)), rear: 1 };
}

/** Effective per-axle damper coefficient (N·s/m) from the damping ratio and the corner mass. */
export function strutDamping(spec: VehicleSpec, front: boolean): number {
  const [fzF, fzR] = staticAxleLoads(spec);
  const f0 = (front ? fzF : fzR) / 2;
  const k = front ? spec.suspension.springRateFront : spec.suspension.springRateRear;
  const zeta = front ? spec.suspension.dampingFront : spec.suspension.dampingRear;
  return 2 * zeta * Math.sqrt(Math.max(k, 0) * Math.max(f0, 1) / G);
}

/** Body inertia tensor (diagonal, body axes): roll, pitch, yaw. */
export function bodyInertia(spec: VehicleSpec): [number, number, number] {
  const iz = spec.yawInertia > 0 ? spec.yawInertia : spec.mass * 1.5;
  const ix = spec.rollInertia !== undefined && spec.rollInertia > 0 ? spec.rollInertia : spec.mass * (0.32 * spec.width) * (0.32 * spec.width);
  const iy = spec.pitchInertia !== undefined && spec.pitchInertia > 0 ? spec.pitchInertia : 0.9 * iz;
  return [ix, iy, iz];
}

// ---------------------------------------------------------------------------
// State creation / reset
// ---------------------------------------------------------------------------

function makeWheelState(ambient: number, surface: SurfaceProps): WheelState {
  return {
    omega: 0,
    load: 0,
    slipAngle: 0,
    slipRatio: 0,
    fx: 0,
    fy: 0,
    steer: 0,
    tire: { temp: ambient, wear: 0 },
    brake: { temp: ambient },
    locked: false,
    spinning: false,
    utilisation: 0,
    compression: 0,
    onGround: true,
    surface: surface.kind,
    x: 0,
    y: 0,
    brakeTorque: 0,
    driveTorque: 0,
  };
}

/** Place the body upright and at rest on the road at `pose` with all struts at Δ = 0 (before settling). */
function placeOnRoad(spec: VehicleSpec, state: VehicleState, pose: Pose, road: RoadQuery): RoadSample {
  const sample = road.sampleAt(pose.x, pose.y, pose.heading);
  state.x = pose.x;
  state.y = pose.y;
  state.heading = wrapAngle(pose.heading);
  state.pitch = -sample.gradeAlong;
  state.roll = -sample.bankAcross;
  const r22 = Math.max(0.5, Math.cos(state.pitch) * Math.cos(state.roll));
  state.z = sample.z + spec.cgHeight / r22;
  state.vx = 0;
  state.vy = 0;
  state.vz = 0;
  state.yawRate = 0;
  state.pitchRate = 0;
  state.rollRate = 0;
  state.airborne = false;
  state.airTime = 0;
  state.wrecked = false;
  state.ax = 0;
  state.ay = 0;
  state.loadTransferLong = 0;
  state.loadTransferLatFront = 0;
  state.loadTransferLatRear = 0;
  state.engineRpm = spec.engine.idleRpm;
  state.throttleEffective = 0;
  state.gear = 1;
  state.shiftTimer = 0;
  state.input = { ...NEUTRAL_INPUT };
  state.speed = 0;
  state.offTrack = !sample.onTrack;
  state.road = sample;
  return sample;
}

/** Run the model with no input, holding the planar velocities at zero, so the struts settle. */
function settle(spec: VehicleSpec, state: VehicleState, road: RoadQuery): void {
  const it = internalOf(spec, state);
  it.vzBody = 0;
  it.rateValid = false;
  it.tiltTime = 0;
  for (const w of it.wheels) {
    w.rough = 0;
    w.fyBody = 0;
    w.fyBodyPrev = 0;
    w.integrating = false;
    w.spinning = false;
    w.locked = false;
  }
  const px = state.x;
  const py = state.y;
  const ph = state.heading;
  for (let i = 0; i < SETTLE_SUBSTEPS; i++) substep(spec, state, it, NEUTRAL_INPUT, road, MAX_SUBSTEP, true);
  state.x = px;
  state.y = py;
  state.heading = ph;
  state.vx = 0;
  state.vy = 0;
  state.vz = 0;
  it.vzBody = 0;
  state.yawRate = 0;
  state.pitchRate = 0;
  state.rollRate = 0;
  state.ax = 0;
  state.ay = 0;
  state.speed = 0;
  state.airborne = false;
  state.airTime = 0;
  state.wrecked = false;
  state.odometer = 0;
  state.time = 0;
  for (let i = 0; i < 4; i++) {
    const w = state.wheels[i];
    w.omega = 0;
    w.slipAngle = 0;
    w.slipRatio = 0;
    w.fx = 0;
    w.fy = 0;
    w.locked = false;
    w.spinning = false;
    w.utilisation = 0;
    w.brakeTorque = 0;
    w.driveTorque = 0;
    it.wheels[i].deltaPrev = it.wheels[i].delta;
    it.wheels[i].rate = 0;
  }
}

/** A new vehicle at rest at `pose`, settled to its equilibrium ride height on the local road. */
export function createVehicleState(spec: VehicleSpec, pose: Pose, road: RoadQuery): VehicleState {
  const sample = road.sampleAt(pose.x, pose.y, pose.heading);
  const ambient = Number.isFinite(road.ambientTemp) ? road.ambientTemp : 22;
  const state: VehicleState = {
    x: pose.x,
    y: pose.y,
    z: sample.z + spec.cgHeight,
    heading: pose.heading,
    vx: 0,
    vy: 0,
    yawRate: 0,
    vz: 0,
    pitch: 0,
    roll: 0,
    pitchRate: 0,
    rollRate: 0,
    airborne: false,
    airTime: 0,
    wrecked: false,
    ax: 0,
    ay: 0,
    loadTransferLong: 0,
    loadTransferLatFront: 0,
    loadTransferLatRear: 0,
    wheels: [makeWheelState(ambient, sample.surface), makeWheelState(ambient, sample.surface), makeWheelState(ambient, sample.surface), makeWheelState(ambient, sample.surface)],
    engineRpm: spec.engine.idleRpm,
    throttleEffective: 0,
    gear: 1,
    shiftTimer: 0,
    input: { ...NEUTRAL_INPUT },
    speed: 0,
    offTrack: !sample.onTrack,
    road: sample,
    odometer: 0,
    time: 0,
  };
  INTERNAL.set(state, makeInternal(spec));
  placeOnRoad(spec, state, pose, road);
  settle(spec, state, road);
  return state;
}

/**
 * Re-pose an existing state (race resets): keeps tyre / brake temperatures and wear, zeroes
 * velocities and attitude, clears wrecked / airborne, then settles on the local road.
 */
export function resetVehicleState(spec: VehicleSpec, state: VehicleState, pose: Pose, road: RoadQuery): VehicleState {
  const it = internalOf(spec, state);
  const odo = state.odometer;
  const time = state.time;
  placeOnRoad(spec, state, pose, road);
  it.prevShiftUp = false;
  it.prevShiftDown = false;
  for (const w of it.wheels) {
    w.delta = 0;
    w.deltaPrev = 0;
    w.rate = 0;
    w.rough = 0;
    w.load = 0;
    w.onGround = true;
  }
  settle(spec, state, road);
  state.odometer = odo;
  state.time = time;
  return state;
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

/** Advance one fixed step. Mutates and returns `state`. */
export function stepVehicle(spec: VehicleSpec, state: VehicleState, input: DriverInput, road: RoadQuery, dt: number): VehicleState {
  if (!(dt > 0) || !Number.isFinite(dt)) return state;
  const it = internalOf(spec, state);
  const inp = sanitiseInput(input, state.input === input ? undefined : state.input);
  state.input = inp;

  // --- gear logic (once per step) -------------------------------------------------------
  const n = spec.drivetrain.gearRatios.length;
  if (inp.shiftUp && !it.prevShiftUp) {
    if (state.gear === -1 || state.gear === 0) state.gear = 1;
    else if (state.gear < n) {
      state.gear += 1;
      state.shiftTimer = Math.max(state.shiftTimer, spec.drivetrain.shiftTime);
    }
  }
  if (inp.shiftDown && !it.prevShiftDown) {
    if (state.gear > 1) {
      state.gear -= 1;
      state.shiftTimer = Math.max(state.shiftTimer, spec.drivetrain.shiftTime);
    } else if ((state.gear === 1 || state.gear === 0) && Math.abs(state.vx) < 1) {
      state.gear = -1;
    }
  }
  it.prevShiftUp = inp.shiftUp;
  it.prevShiftDown = inp.shiftDown;
  if (spec.drivetrain.autoShift && state.gear >= 1 && state.shiftTimer <= 0 && n > 0) {
    // Shift on the output-shaft (driven-wheel) rpm like a real TCU — not on the launch clutch's held
    // engine rpm. Wheelspin therefore triggers an upshift, which is what ends a burnout.
    const split = clamp01(spec.drivetrain.frontTorqueSplit);
    let omegaDriven = 0;
    if (split > 1e-6) omegaDriven += split * 0.5 * (state.wheels[0].omega + state.wheels[1].omega);
    if (split < 1 - 1e-6) omegaDriven += (1 - split) * 0.5 * (state.wheels[2].omega + state.wheels[3].omega);
    const shiftRpm = Math.max(spec.engine.idleRpm, rpmFromWheelSpeed(spec.drivetrain, state.gear, omegaDriven));
    const g = autoShiftGear(spec.drivetrain, spec.engine, state.gear, shiftRpm, state.throttleEffective);
    // TCU hysteresis: a wheelspin-induced upshift must not be undone the moment the wheels grip again.
    const atLimiter = shiftRpm >= 0.985 * spec.engine.limiterRpm;
    const allowed = g > state.gear ? it.holdUp <= 0 || atLimiter : it.holdDown <= 0;
    if (g !== state.gear && allowed) {
      const spinning = state.wheels.some((w) => w.spinning);
      if (g > state.gear) it.holdDown = spinning ? SHIFT_HOLD_DOWN_SPIN : SHIFT_HOLD_DOWN;
      else it.holdUp = SHIFT_HOLD_UP;
      state.gear = g;
      state.shiftTimer = spec.drivetrain.shiftTime;
    }
  }
  it.holdDown = Math.max(0, it.holdDown - dt);
  it.holdUp = Math.max(0, it.holdUp - dt);

  // --- substeps ------------------------------------------------------------------------
  const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP - 1e-9));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) substep(spec, state, it, inp, road, h, false);
  return state;
}

/** Clamp / NaN-proof the driver input, writing into `into` (the state's echo object) when given. */
function sanitiseInput(input: DriverInput, into?: DriverInput): DriverInput {
  const f = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? clamp(v, lo, hi) : 0);
  const out: DriverInput = into ?? { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false };
  out.throttle = f(input.throttle, 0, 1);
  out.brake = f(input.brake, 0, 1);
  out.steer = f(input.steer, -1, 1);
  out.handbrake = f(input.handbrake, 0, 1);
  out.shiftUp = !!input.shiftUp;
  out.shiftDown = !!input.shiftDown;
  return out;
}

// ---------------------------------------------------------------------------
// Substep helpers
// ---------------------------------------------------------------------------

/** Direction of travel of the contact patch (+1 forward / −1 backward), falling back to wheel spin, then drive torque. */
function dirSign(vwx: number, omega: number, tDrive: number): number {
  if (vwx > 1e-3) return 1;
  if (vwx < -1e-3) return -1;
  if (omega > 1e-2) return 1;
  if (omega < -1e-2) return -1;
  return tDrive < 0 ? -1 : 1;
}

function sgn(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Quaternion (body→world) from the ZYX Euler angles used by the state: R = Rz(yaw)·Ry(pitch)·Rx(roll). */
function quatFromEuler(it: Internal, yaw: number, pitch: number, roll: number): void {
  const y = Number.isFinite(yaw) ? yaw : 0;
  const p = Number.isFinite(pitch) ? pitch : 0;
  const r = Number.isFinite(roll) ? roll : 0;
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cp = Math.cos(p / 2);
  const sp = Math.sin(p / 2);
  const cr = Math.cos(r / 2);
  const sr = Math.sin(r / 2);
  it.qw = cr * cp * cy + sr * sp * sy;
  it.qx = sr * cp * cy - cr * sp * sy;
  it.qy = cr * sp * cy + sr * cp * sy;
  it.qz = cr * cp * sy - sr * sp * cy;
  it.eYaw = yaw;
  it.ePitch = pitch;
  it.eRoll = roll;
}

/** Evaluate the tyre model for wheel `w` at its current slips; writes `w.out`. */
function tyreEval(spec: VehicleSpec, it: Internal, ws: WheelState, w: WheelScratch, front: boolean): void {
  const tire = front ? spec.tires.front : spec.tires.rear;
  const inp = it.tireIn;
  inp.load = w.load;
  inp.slipAngle = w.alpha;
  inp.slipRatio = w.kappa;
  inp.camber = w.camber;
  inp.surface = w.surface;
  inp.temp = ws.tire.temp;
  inp.wear = ws.tire.wear;
  inp.speed = w.vRef;
  tireForcesInto(tire, inp, w.out);
}

function zeroOut(out: TireForcesResult): void {
  out.fx = 0;
  out.fy = 0;
  out.utilisation = 0;
  out.slipPower = 0;
  out.slipNorm = 0;
}

/**
 * Grip regime: find the slip ratio at which the tyre delivers the demanded longitudinal force
 * (|fdem| ≤ available room). Starts from the linear estimate fdem / (Cx·N) and refines with a few
 * secant steps on the real (combined-slip) curve so that braking at 90 % of capacity really
 * produces 90 % of the force. Leaves the final evaluation in `w.out`.
 */
function solveGripSlip(spec: VehicleSpec, it: Internal, ws: WheelState, w: WheelScratch, front: boolean, fdem: number, kappaMax: number): void {
  const tire = front ? spec.tires.front : spec.tires.rear;
  const cx = tire.longStiffnessPerLoad * w.load;
  const target = fdem;
  const sign = target < 0 ? -1 : 1;
  const mag = Math.abs(target);
  let k0 = cx > 1e-6 ? clamp(target / cx, -kappaMax, kappaMax) : 0;
  w.kappa = k0;
  tyreEval(spec, it, ws, w, front);
  if (mag < 1e-6 || kappaMax <= 1e-9) return;
  let f0 = Math.abs(w.out.fx);
  // Secant toward the target on |fx|(|kappa|) (monotonic up to kappaMax).
  let k1 = k0;
  let f1 = f0;
  for (let iter = 0; iter < 4; iter++) {
    if (Math.abs(f1 - mag) <= 0.01 * mag) break;
    let kNext: number;
    if (iter === 0 || Math.abs(f1 - f0) < 1e-9) {
      kNext = f1 > 1e-9 ? Math.abs(k1) * (mag / f1) : kappaMax; // secant through the origin
    } else {
      kNext = Math.abs(k1) + ((mag - f1) * (Math.abs(k1) - Math.abs(k0))) / (f1 - f0);
    }
    if (!(kNext > 0)) kNext = 0.5 * Math.abs(k1);
    if (kNext > kappaMax) kNext = kappaMax;
    k0 = k1;
    f0 = f1;
    k1 = sign * kNext;
    w.kappa = k1;
    tyreEval(spec, it, ws, w, front);
    f1 = Math.abs(w.out.fx);
    if (Math.abs(k1) >= kappaMax - 1e-12 && f1 < mag) break; // at the peak: deliver what the tyre has
  }
}

interface Accum {
  fx: number;
  fy: number;
  fz: number;
  mx: number;
  my: number;
  mz: number;
}

// ---------------------------------------------------------------------------
// The substep
// ---------------------------------------------------------------------------

function substep(spec: VehicleSpec, state: VehicleState, it: Internal, input: DriverInput, road: RoadQuery, dt: number, settling: boolean): void {
  const m = spec.mass > 1 ? spec.mass : 1;
  const h = spec.cgHeight;
  const sus = spec.suspension;
  const dtr = spec.drivetrain;
  const eng = spec.engine;
  const br = spec.brakes;
  const wheels = it.wheels;
  const ws = state.wheels;
  const ambient = Number.isFinite(road.ambientTemp) ? road.ambientTemp : 22;
  const a = spec.cgToFront;
  const b = spec.wheelbase - a;
  const x0 = state.x;
  const y0 = state.y;
  const z0 = state.z;

  // --- 1. inputs -----------------------------------------------------------------------
  if (!settling) {
    const resp = eng.throttleResponse > 1e-4 ? eng.throttleResponse : 1e-4;
    state.throttleEffective += (input.throttle - state.throttleEffective) * Math.min(1, dt / resp);
    if (!Number.isFinite(state.throttleEffective)) state.throttleEffective = 0;
  }
  const thr = settling ? 0 : state.throttleEffective;
  const pedal = settling ? 0 : input.brake;
  const handbrake = settling ? 0 : input.handbrake;
  const speedNow = Math.hypot(state.vx, state.vy);
  const stg = spec.steering;
  let lockFrac = 1;
  if (stg.fullLockSpeed > 0) lockFrac = 1 + (stg.highSpeedLockFraction - 1) * clamp01(speedNow / stg.fullLockSpeed);
  const deltaMean = settling ? 0 : input.steer * stg.maxSteerAngle * lockFrac;
  const ackTerm = (stg.ackermann * Math.abs(deltaMean) * spec.trackFront) / (2 * Math.max(spec.wheelbase, 0.1));
  const dInner = deltaMean * (1 + ackTerm);
  const dOuter = deltaMean * (1 - ackTerm);
  wheels[0].steer = deltaMean >= 0 ? dInner : dOuter; // FL is the inner wheel of a left turn
  wheels[1].steer = deltaMean >= 0 ? dOuter : dInner;
  wheels[2].steer = 0;
  wheels[3].steer = 0;

  // --- 2. geometry: rotation, corners, ground, strut compression -------------------------
  // Attitude lives in a quaternion (no gimbal lock while tumbling); the state's Euler angles are
  // derived from it, and an externally edited angle (teleport, reset, clone) rebuilds it.
  if (state.heading !== it.eYaw || state.pitch !== it.ePitch || state.roll !== it.eRoll || !Number.isFinite(it.qw + it.qx + it.qy + it.qz)) {
    quatFromEuler(it, state.heading, state.pitch, state.roll);
  }
  const qw = it.qw;
  const qx = it.qx;
  const qy = it.qy;
  const qz = it.qz;
  const R00 = 1 - 2 * (qy * qy + qz * qz);
  const R01 = 2 * (qx * qy - qz * qw);
  const R02 = 2 * (qx * qz + qy * qw);
  const R10 = 2 * (qx * qy + qz * qw);
  const R11 = 1 - 2 * (qx * qx + qz * qz);
  const R12 = 2 * (qy * qz - qx * qw);
  const R20 = 2 * (qx * qz - qy * qw);
  const R21 = 2 * (qy * qz + qx * qw);
  const R22 = 1 - 2 * (qx * qx + qy * qy);
  const cy = Math.cos(state.heading);
  const sy = Math.sin(state.heading);
  const tilted = R22 <= TIP_COS;

  const cgSample = road.sampleAt(state.x, state.y, state.heading);
  const tgc = Math.tan(cgSample.gradeAlong);
  const tbc = Math.tan(cgSample.bankAcross);
  const gxc = tgc * cy + tbc * sy;
  const gyc = tgc * sy - tbc * cy;

  const roughBlend = Math.min(1, dt / ROUGHNESS_TAU);
  // Far off the track (open run-off) the surface no longer varies across the car: extrapolate the
  // CG sample's plane instead of paying four more (global-search) track queries per substep.
  const farOff = !cgSample.onTrack && Math.abs(cgSample.lateral) > cgSample.halfWidth + FAR_OFF_MARGIN;
  for (let i = 0; i < 4; i++) {
    const w = wheels[i];
    const Xw = state.x + R00 * w.x + R01 * w.y;
    const Yw = state.y + R10 * w.x + R11 * w.y;
    const Zw = state.z + R20 * w.x + R21 * w.y;
    const smp = farOff ? planeExtrapolate(cgSample, gxc, gyc, Xw - state.x, Yw - state.y) : road.sampleAt(Xw, Yw, state.heading);
    w.sample = smp;
    w.surface = smp.surface;
    const roughRaw = roughnessHeight(smp.surface, Xw, Yw);
    w.rough += (roughRaw - w.rough) * roughBlend;
    const zg = smp.z + w.rough;
    const tg = Math.tan(smp.gradeAlong);
    const tb = Math.tan(smp.bankAcross);
    const gx = tg * cy + tb * sy;
    const gy = tg * sy - tb * cy;
    w.gx = gx;
    w.gy = gy;
    // Strut length along body −z to the local road plane; = vertical gap / cos(tilt) on flat ground.
    const denom = Math.max(0.5, R22 - gx * R02 - gy * R12);
    const delta = h - (Zw - zg) / denom;
    w.rate = it.rateValid ? (delta - w.deltaPrev) / dt : 0;
    w.deltaPrev = delta;
    w.delta = delta;
    ws[i].x = Xw;
    ws[i].y = Yw;
  }
  it.rateValid = true;

  // --- 3. strut forces = tyre normal loads ----------------------------------------------
  const [fzF, fzR] = staticAxleLoads(spec);
  const travel = sus.travel > 0.01 ? sus.travel : 0.01;
  const bumpAt = 0.55 * travel;
  const droopAt = -0.45 * travel;
  for (let axle = 0; axle < 2; axle++) {
    const front = axle === 0;
    const iL = front ? 0 : 2;
    const iR = iL + 1;
    const L = wheels[iL];
    const Rw = wheels[iR];
    const f0 = (front ? fzF : fzR) / 2;
    const k = Math.max(front ? sus.springRateFront : sus.springRateRear, 0);
    const c = strutDamping(spec, front);
    const track = Math.max(front ? spec.trackFront : spec.trackRear, 0.5);
    const kArb = Math.max(front ? sus.arbFront : sus.arbRear, 0) / (track * track);
    const rc = front ? sus.rollCentreFront : sus.rollCentreRear;
    const fyAxle = L.fyBodyPrev + Rw.fyBodyPrev;
    const jack = (fyAxle * rc) / track; // left turn (Fy > 0) loads the RIGHT wheel
    for (let side = 0; side < 2; side++) {
      const w = side === 0 ? L : Rw;
      const partner = side === 0 ? Rw : L;
      let F = f0 + k * w.delta + c * w.rate + kArb * (w.delta - partner.delta) + (side === 0 ? -jack : jack);
      const over = w.delta - bumpAt;
      if (over > 0) F += 8 * k * over + 2 * c * w.rate;
      if (!(F > 0) || w.delta < droopAt || tilted) F = 0;
      w.load = F;
      w.onGround = F > 0;
    }
  }
  let anyGround = false;
  let allGround = true;
  for (let i = 0; i < 4; i++) {
    if (wheels[i].onGround) anyGround = true;
    else allGround = false;
  }

  // --- 4. wheel kinematics + preliminary tyre call -----------------------------------------
  const p0 = state.rollRate;
  const q0 = state.pitchRate;
  const r0 = state.yawRate;
  const vx0 = state.vx;
  const vy0 = state.vy;
  const vz0 = it.vzBody;
  for (let i = 0; i < 4; i++) {
    const w = wheels[i];
    const front = i < 2;
    const tire = front ? spec.tires.front : spec.tires.rear;
    const rz = -(h - w.delta);
    const vbx = vx0 + q0 * rz - r0 * w.y;
    const vby = vy0 + r0 * w.x - p0 * rz;
    const cd = Math.cos(w.steer);
    const sd = Math.sin(w.steer);
    w.vwx = cd * vbx + sd * vby;
    w.vwy = -sd * vbx + cd * vby;
    const avx = Math.abs(w.vwx);
    w.vRef = avx > V_EPS ? avx : V_EPS;
    w.alpha = Math.atan2(w.vwy, avx) * smoothstep(0.2, 1.5, avx);
    const bank = w.sample ? w.sample.bankAcross : 0;
    const phiRel = state.roll + bank;
    w.camber = tire.camber + (w.y > 0 ? -phiRel : phiRel);
    const pk = tirePeakSlip(tire, w.surface);
    w.peakKappa = pk.slipRatio;
    w.peakAlpha = pk.slipAngle;
    // preliminary: lateral demand at kappa = 0 → longitudinal room in the ellipse
    const inp = it.tireIn;
    inp.load = w.load;
    inp.slipAngle = w.alpha;
    inp.slipRatio = 0;
    inp.camber = w.camber;
    inp.surface = w.surface;
    inp.temp = ws[i].tire.temp;
    inp.wear = ws[i].tire.wear;
    inp.speed = w.vRef;
    tireForcesInto(tire, inp, w.out0);
    w.capNm = w.onGround ? w.out0.longCapacity * tire.radius : 0;
    w.tDrive = 0;
    w.diffSpin = false;
    w.reaction = 0;
    w.brakePower = 0;
    w.tBrakeApplied = 0;
    w.locked = false;
    w.spinning = false;
  }

  // --- 5. engine, gearbox, differentials -------------------------------------------------
  const split = clamp01(dtr.frontTorqueSplit);
  const driveF = split > 1e-6;
  const driveR = split < 1 - 1e-6;
  const nDriven = (driveF ? 2 : 0) + (driveR ? 2 : 0);
  let omegaDriven = 0;
  if (driveF) omegaDriven += split * 0.5 * (ws[0].omega + ws[1].omega);
  if (driveR) omegaDriven += (1 - split) * 0.5 * (ws[2].omega + ws[3].omega);
  const gear = state.gear;
  const ratio = overallRatio(dtr, gear);
  let rpm = Number.isFinite(state.engineRpm) ? state.engineRpm : eng.idleRpm;
  let tTotal = 0;
  let clutchSlip = true; // engine decoupled (neutral / shifting / slipping launch clutch)
  if (gear !== 0 && ratio !== 0 && state.shiftTimer <= 0) {
    const wheelRpm = rpmFromWheelSpeed(dtr, gear, omegaDriven);
    clutchSlip = false;
    if (Math.abs(vx0) < 4 && thr > 0.05) {
      // Launch clutch (documented simplification): the engine is held at a throttle-dependent rpm
      // and its torque at that rpm is delivered through the slipping clutch.
      const target = eng.idleRpm + thr * Math.max(0, eng.peakTorqueRpm - eng.idleRpm);
      if (wheelRpm < target) {
        rpm = target;
        clutchSlip = true;
      } else rpm = wheelRpm;
    } else if (wheelRpm < eng.idleRpm) {
      rpm = eng.idleRpm; // idle governor; the clutch slips
      clutchSlip = true;
    } else rpm = wheelRpm;
    let tEng = engineTorque(eng, rpm, thr);
    if (clutchSlip && tEng < 0) tEng = 0; // a slipping clutch does not transmit engine braking
    tTotal = tEng * ratio * clamp01(dtr.efficiency);
    // The fuel cut holds a real engine at the limiter; slip-driven kinematic rpm above it is reported clamped.
    if (rpm > eng.limiterRpm * RPM_REPORT_OVERSHOOT) rpm = eng.limiterRpm * RPM_REPORT_OVERSHOOT;
  } else {
    // Neutral or mid-shift: the engine free-spins against its own inertia.
    const tEng = engineTorque(eng, rpm, thr);
    const inertia = eng.inertia > 1e-3 ? eng.inertia : 0.1;
    rpm += (tEng / inertia) * dt * RAD_S_TO_RPM;
    rpm = clamp(rpm, eng.idleRpm, eng.limiterRpm * 1.02);
  }
  if (!Number.isFinite(rpm)) rpm = eng.idleRpm;
  state.engineRpm = rpm;
  if (state.shiftTimer > 0) state.shiftTimer = Math.max(0, state.shiftTimer - dt);
  const omegaCap = gear !== 0 && ratio !== 0 ? Math.abs(wheelOmegaFromRpm(dtr, gear, eng.limiterRpm)) : Infinity;
  // Rotational inertia a driven wheel sees beyond its own: the drivetrain share plus, with the clutch
  // engaged, the engine's inertia reflected through the gearbox (ratio²) — this is what makes a burnout
  // rev up over ~1 s and spin down gradually instead of snapping.
  const engineReflected = clutchSlip ? 0 : Math.max(eng.inertia, 0) * ratio * ratio;
  const iDriveExtra = nDriven > 0 ? (Math.max(dtr.inertia, 0) + engineReflected) / nDriven : 0;
  const iReactExtra = nDriven > 0 ? Math.max(dtr.inertia, 0) / nDriven : 0;
  // The engine is pushing (positive engine torque through the gearbox, in either gear direction) as
  // opposed to engine-braking. Needed by the torque balance: propulsive torque that opposes a slow
  // creep (a hill start: the car rolls back a few cm/s while the driver floors it) must spin the wheel
  // up in the drive direction, whereas engine-braking overload parks the tyre on the ellipse boundary.
  const propulsive = tTotal * ratio > 0;

  const axleLock = [false, false];
  for (let axle = 0; axle < 2; axle++) {
    const front = axle === 0;
    if (front ? !driveF : !driveR) continue;
    const T = tTotal * (front ? split : 1 - split);
    const iL = front ? 0 : 2;
    const L = wheels[iL];
    const Rw = wheels[iL + 1];
    const diff = front ? dtr.frontDiff : dtr.rearDiff;
    const res = splitAxleTorque(diff, T, L.capNm, Rw.capNm, ws[iL].omega, ws[iL + 1].omega);
    L.tDrive = res.left;
    Rw.tDrive = res.right;
    L.diffSpin = res.spinLeft;
    Rw.diffSpin = res.spinRight;
    if (diff.type === 'open' && res.spinLeft !== res.spinRight) {
      // An open diff can give the gripping wheel no more than the spinning wheel's sliding capacity.
      const tire = front ? spec.tires.front : spec.tires.rear;
      const spinW = res.spinLeft ? L : Rw;
      const gripW = res.spinLeft ? Rw : L;
      const cap = tireSlideRatio(tire, spinW.surface) * spinW.capNm;
      if (Math.abs(gripW.tDrive) > cap) gripW.tDrive = sgn(gripW.tDrive) * cap;
    }
    axleLock[axle] = res.lockSpeeds && L.onGround && Rw.onGround;
  }

  // --- 6. brakes (bias bar) ----------------------------------------------------------------
  const lp = brakeLinePressures(br.bias, br.front.maxTorque, br.rear.maxTorque);
  for (let i = 0; i < 4; i++) {
    const front = i < 2;
    const w = wheels[i];
    w.tBrake = brakeTorque(front ? br.front : br.rear, ws[i].brake, pedal * (front ? lp.front : lp.rear));
    if (!front && handbrake > 0) w.tBrake += Math.max(br.handbrakeTorque, 0) * handbrake;
  }

  // --- 7. per-wheel quasi-static torque balance -----------------------------------------------
  const wheelBalance = (i: number): void => {
    const w = wheels[i];
    const front = i < 2;
    const tire = front ? spec.tires.front : spec.tires.rear;
    const rad = tire.radius > 0.05 ? tire.radius : 0.3;
    const driven = front ? driveF : driveR;
    const iWheel = front ? br.wheelInertiaFront : br.wheelInertiaRear;
    const I = Math.max(iWheel + (driven ? iDriveExtra : 0), 0.05);
    const iReact = Math.max(iWheel + (driven ? iReactExtra : 0), 0.05); // engine spin axis is not the wheel axis
    let omega = Number.isFinite(ws[i].omega) ? ws[i].omega : 0;

    if (!w.onGround) {
      // Airborne: the wheel only sees drive and brake torque.
      const tb = w.tBrake * sgn(omega);
      let om2 = omega + ((w.tDrive - tb) / I) * dt;
      if (omega !== 0 && sgn(om2) !== sgn(omega) && w.tBrake > Math.abs(w.tDrive)) om2 = 0;
      if (driven && w.tDrive > 0 && om2 > omegaCap) om2 = omegaCap;
      if (driven && w.tDrive < 0 && om2 < -omegaCap) om2 = -omegaCap;
      w.reaction = (iReact * (om2 - omega)) / dt;
      w.kappa = 0;
      w.alpha = 0;
      zeroOut(w.out);
      w.integrating = false;
      w.tBrakeApplied = omega !== 0 ? w.tBrake : 0;
      ws[i].omega = om2;
      return;
    }

    const s = dirSign(w.vwx, omega, w.tDrive);
    const fdem = (w.tDrive - s * w.tBrake) / rad;
    const out0 = w.out0;
    const latCap = out0.latCapacity > 1e-6 ? out0.latCapacity : 1e-6;
    const ratioLat = clamp(out0.fy / latCap, -1, 1);
    const roomFrac = Math.sqrt(Math.max(0, 1 - ratioLat * ratioLat));
    const room = out0.longCapacity * roomFrac * LONG_ROOM_MARGIN;
    const kappaMax = w.peakKappa * roomFrac;
    const along = fdem * s;
    // Drive torque against the direction of travel and stronger than the brake: the engine is
    // reversing the wheel's motion (hill start while creeping back, or reverse gear while rolling
    // forward) — a drive overload in the other direction, not engine braking. Without this the
    // wheel was clamped to |vwx|/V_EPS of slip and could never spin up (hill-start deadlock).
    const driveReversal = propulsive && w.tDrive * s < 0 && Math.abs(w.tDrive) > w.tBrake;

    if (along < -room && !driveReversal) {
      // Braking overload.
      const brakeDominated = w.tBrake >= Math.abs(w.tDrive) || w.tDrive * s > 0;
      if (br.abs && brakeDominated) {
        w.kappa = -s * Math.min(ABS_SLIP_FRACTION * w.peakKappa, Math.abs(w.vwx) / V_EPS);
        omega = (w.vwx + w.kappa * w.vRef) / rad;
        tyreEval(spec, it, ws[i], w, front);
        w.tBrakeApplied = Math.min(w.tBrake, Math.abs(w.out.fx) * rad);
        w.brakePower = Math.abs(w.out.fx) * Math.abs(w.vwx);
      } else if (!brakeDominated) {
        // Engine braking drags the wheel past what the ellipse leaves: the tyre sits on the ellipse
        // boundary (combined slip = peak), delivering what it can without a lateral cliff.
        w.kappa = -s * Math.min(Math.max(kappaMax, 0.1 * w.peakKappa), Math.abs(w.vwx) / V_EPS);
        omega = (w.vwx + w.kappa * w.vRef) / rad;
        tyreEval(spec, it, ws[i], w, front);
        w.tBrakeApplied = w.tBrake;
        w.brakePower = w.tBrake * Math.abs(omega);
      } else {
        // Locked wheel: omega = 0, the tyre slides (kappa → −1 at speed), lateral authority collapses.
        w.kappa = clamp(-w.vwx / w.vRef, -1, 1);
        omega = 0;
        w.locked = Math.abs(w.vwx) > 0.5;
        tyreEval(spec, it, ws[i], w, front);
        w.tBrakeApplied = Math.abs(w.out.fx) * rad;
        w.brakePower = 0;
      }
      w.integrating = false;
    } else if (w.integrating || w.diffSpin || along > room || driveReversal) {
      // Drive overload: integrate the wheel explicitly (wheelspin).
      w.kappa = clamp((omega * rad - w.vwx) / w.vRef, -1, 3);
      tyreEval(spec, it, ws[i], w, front);
      const tb = w.tBrake * sgn(omega);
      let om2 = omega + ((w.tDrive - w.out.fx * rad - tb) / I) * dt;
      if (driven && w.tDrive > 0 && om2 > omegaCap) om2 = omegaCap;
      if (driven && w.tDrive < 0 && om2 < -omegaCap) om2 = -omegaCap;
      w.reaction = (iReact * (om2 - omega)) / dt;
      w.spinning = Math.abs(w.kappa) > 1.5 * w.peakKappa;
      w.tBrakeApplied = w.tBrake;
      w.brakePower = w.tBrake * Math.abs(omega);
      omega = om2;
      const kNow = (omega * rad - w.vwx) / w.vRef;
      w.integrating = !(Math.abs(kNow) <= w.peakKappa && along <= room && !w.diffSpin);
    } else {
      // Grip regime: the tyre delivers the demanded force.
      solveGripSlip(spec, it, ws[i], w, front, fdem, kappaMax);
      omega = (w.vwx + w.kappa * w.vRef) / rad;
      w.tBrakeApplied = w.tBrake;
      w.brakePower = w.tBrake * Math.abs(omega);
      w.integrating = false;
    }
    ws[i].omega = omega;
  };

  /** Locked differential: both wheels share one angular velocity (this is what makes it push). */
  const lockedAxleBalance = (iL: number): void => {
    const iR = iL + 1;
    const L = wheels[iL];
    const Rw = wheels[iR];
    const front = iL < 2;
    const tire = front ? spec.tires.front : spec.tires.rear;
    const rad = tire.radius > 0.05 ? tire.radius : 0.3;
    const iWheel = front ? br.wheelInertiaFront : br.wheelInertiaRear;
    const I = Math.max(iWheel + iDriveExtra, 0.05);
    const iReact = Math.max(iWheel + iReactExtra, 0.05);
    let om = 0.5 * (ws[iL].omega + ws[iR].omega);
    if (!Number.isFinite(om)) om = 0;
    const T = L.tDrive + Rw.tDrive;
    const s = dirSign(0.5 * (L.vwx + Rw.vwx), om, T);
    const tbSum = L.tBrake + Rw.tBrake;
    const roomOf = (w: WheelScratch): number => {
      const latCap = w.out0.latCapacity > 1e-6 ? w.out0.latCapacity : 1e-6;
      const rl = clamp(w.out0.fy / latCap, -1, 1);
      return w.out0.longCapacity * Math.sqrt(Math.max(0, 1 - rl * rl)) * LONG_ROOM_MARGIN;
    };
    const roomNm = (roomOf(L) + roomOf(Rw)) * rad;
    const along = (T - s * tbSum) * s;
    // See wheelBalance: propulsive torque against a slow creep spins the axle up, it is not braking.
    const driveReversal = propulsive && T * s < 0 && Math.abs(T) > tbSum;
    if (along < -roomNm && !driveReversal) {
      // Braking overload: each wheel locks / ABS-modulates on its own.
      wheelBalance(iL);
      wheelBalance(iR);
      return;
    }
    if (L.integrating || Rw.integrating || L.diffSpin || Rw.diffSpin || along > roomNm || driveReversal) {
      let fxSum = 0;
      for (const w of [L, Rw]) {
        w.kappa = clamp((om * rad - w.vwx) / w.vRef, -1, 3);
        tyreEval(spec, it, ws[w === L ? iL : iR], w, front);
        fxSum += w.out.fx;
        w.spinning = Math.abs(w.kappa) > 1.5 * w.peakKappa;
        w.tBrakeApplied = w.tBrake;
      }
      let om2 = om + ((T - fxSum * rad - tbSum * sgn(om)) / (2 * I)) * dt;
      if (T > 0 && om2 > omegaCap) om2 = omegaCap;
      if (T < 0 && om2 < -omegaCap) om2 = -omegaCap;
      const reaction = (iReact * (om2 - om)) / dt;
      L.reaction = reaction;
      Rw.reaction = reaction;
      L.brakePower = L.tBrake * Math.abs(om2);
      Rw.brakePower = Rw.tBrake * Math.abs(om2);
      const kL = (om2 * rad - L.vwx) / L.vRef;
      const kR = (om2 * rad - Rw.vwx) / Rw.vRef;
      const back = Math.abs(kL) <= L.peakKappa && Math.abs(kR) <= Rw.peakKappa && along <= roomNm && !L.diffSpin && !Rw.diffSpin;
      L.integrating = !back;
      Rw.integrating = !back;
      ws[iL].omega = om2;
      ws[iR].omega = om2;
      return;
    }
    // Grip: each wheel's kinematic omega from its own share, then the common (mean) omega.
    const kin = (w: WheelScratch): number => {
      const cx = tire.longStiffnessPerLoad * w.load;
      const fdem = (w.tDrive - s * w.tBrake) / rad;
      const k = cx > 1e-6 ? clamp(fdem / cx, -w.peakKappa, w.peakKappa) : 0;
      return (w.vwx + k * w.vRef) / rad;
    };
    om = 0.5 * (kin(L) + kin(Rw));
    for (const w of [L, Rw]) {
      w.kappa = clamp((om * rad - w.vwx) / w.vRef, -1, 3);
      tyreEval(spec, it, ws[w === L ? iL : iR], w, front);
      w.tBrakeApplied = w.tBrake;
      w.brakePower = w.tBrake * Math.abs(om);
      w.integrating = false;
    }
    ws[iL].omega = om;
    ws[iR].omega = om;
  };

  for (let axle = 0; axle < 2; axle++) {
    const iL = axle === 0 ? 0 : 2;
    if (axleLock[axle]) lockedAxleBalance(iL);
    else {
      wheelBalance(iL);
      wheelBalance(iL + 1);
    }
  }

  // --- 8. forces & moments on the body (body frame) -------------------------------------------
  const acc: Accum = { fx: 0, fy: 0, fz: 0, mx: 0, my: 0, mz: 0 };
  // gravity: R^T (0, 0, −g) = (+g sin θ, −g sin φ cos θ, −g cos φ cos θ)
  const gbx = -G * R20;
  const gby = -G * R21;
  const gbz = -G * R22;
  acc.fx += m * gbx;
  acc.fy += m * gby;
  acc.fz += m * gbz;

  for (let i = 0; i < 4; i++) {
    const w = wheels[i];
    const front = i < 2;
    const tire = front ? spec.tires.front : spec.tires.rear;
    const rz = -(h - w.delta);
    const rc = front ? sus.rollCentreFront : sus.rollCentreRear;
    if (w.onGround) {
      const rr = -(Math.max(tire.rollingResistance, 0) + Math.max(w.surface.rollingResistance, 0)) * w.load * Math.tanh(w.vwx / 0.5);
      const fxw = w.out.fx + rr;
      const fyw = w.out.fy;
      const cd = Math.cos(w.steer);
      const sd = Math.sin(w.steer);
      // Contact forces live in the ROAD plane: the normal load acts along the road normal, the
      // tyre forces along the wheel heading projected into the plane and its in-plane lateral.
      const nInv = 1 / Math.sqrt(1 + w.gx * w.gx + w.gy * w.gy);
      const nx = -w.gx * nInv;
      const ny = -w.gy * nInv;
      const nz = nInv;
      let ex = R00 * cd + R01 * sd;
      let ey = R10 * cd + R11 * sd;
      let ez = R20 * cd + R21 * sd;
      const en = ex * nx + ey * ny + ez * nz;
      ex -= en * nx;
      ey -= en * ny;
      ez -= en * nz;
      const el = Math.hypot(ex, ey, ez);
      if (el > 1e-6) {
        ex /= el;
        ey /= el;
        ez /= el;
      } else {
        ex = R00;
        ey = R10;
        ez = R20;
      }
      const lx = ny * ez - nz * ey;
      const ly = nz * ex - nx * ez;
      const lz = nx * ey - ny * ex;
      // world → body (R^T) for the three force components
      const Nw = w.load;
      const fLx = fxw * ex, fLy = fxw * ey, fLz = fxw * ez; // longitudinal (world)
      const fTx = fyw * lx, fTy = fyw * ly, fTz = fyw * lz; // lateral (world)
      const fNx = Nw * nx, fNy = Nw * ny, fNz = Nw * nz; // normal (world)
      const bLx = R00 * fLx + R10 * fLy + R20 * fLz;
      const bLy = R01 * fLx + R11 * fLy + R21 * fLz;
      const bLz = R02 * fLx + R12 * fLy + R22 * fLz;
      const bTx = R00 * fTx + R10 * fTy + R20 * fTz;
      const bTy = R01 * fTx + R11 * fTy + R21 * fTz;
      const bTz = R02 * fTx + R12 * fTy + R22 * fTz;
      const bNx = R00 * fNx + R10 * fNy + R20 * fNz;
      const bNy = R01 * fNx + R11 * fNy + R21 * fNz;
      const bNz = R02 * fNx + R12 * fNy + R22 * fNz;
      // Normal + longitudinal act at the contact patch; the lateral force at the roll-centre height
      // (its geometric share of the load transfer is the jacking term in the strut force).
      const px = w.x;
      const py = w.y;
      const pz = rz;
      const qz = rz + rc;
      const cx = bLx + bNx;
      const cyf = bLy + bNy;
      const cz = bLz + bNz;
      acc.fx += cx + bTx;
      acc.fy += cyf + bTy;
      acc.fz += cz + bTz;
      acc.mx += py * cz - pz * cyf + (py * bTz - qz * bTy);
      acc.my += pz * cx - px * cz + (qz * bTx - px * bTz);
      acc.mz += px * cyf - py * cx + (px * bTy - py * bTx);
      w.fyBody = bTy + bLy;
    } else {
      w.fyBody = 0;
    }
    // wheel angular-momentum reaction (braking in the air → nose down, throttle → nose up)
    acc.my -= w.reaction;
  }

  // aero at the current ride heights
  const compF = 0.5 * (wheels[0].delta + wheels[1].delta);
  const compR = 0.5 * (wheels[2].delta + wheels[3].delta);
  aeroForcesInto(spec.aero, vx0, sus.rideHeightFront - compF, sus.rideHeightRear - compR, road.airDensity, it.aero);
  acc.fx -= it.aero.drag * Math.tanh(vx0 / 2);
  acc.fz -= it.aero.downFront + it.aero.downRear;
  acc.my += a * it.aero.downFront - b * it.aero.downRear;
  // surface drag (loose surfaces)
  acc.fx -= m * Math.max(cgSample.surface.drag, 0) * vx0;

  // hull contact (box corners; plus the wheels as shell points once tipped past 55°)
  it.hullContacts = 0;
  let deepestPen = 0;
  {
    const rideMin = Math.max(Math.min(sus.rideHeightFront, sus.rideHeightRear), 0);
    const zBot = -(h - rideMin);
    const zTop = (spec.height !== undefined && spec.height > 0 ? spec.height : 1.3) - h;
    const hx = spec.length / 2;
    const hy = spec.width / 2;
    const contact = (bx: number, by: number, bz: number, mu: number): void => {
      const Px = x0 + R00 * bx + R01 * by + R02 * bz;
      const Py = y0 + R10 * bx + R11 * by + R12 * bz;
      const Pz = z0 + R20 * bx + R21 * by + R22 * bz;
      if (!tilted) {
        // Cheap pre-check against the local road plane: only sample corners that could be touching.
        const zPlane = cgSample.z + gxc * (Px - x0) + gyc * (Py - y0);
        if (Pz - zPlane > HULL_CHECK_CLEARANCE) return;
      }
      const smp = road.sampleAt(Px, Py, state.heading);
      const pen = smp.z - Pz;
      if (!(pen > 0)) return;
      if (pen > deepestPen) deepestPen = pen;
      // corner velocity in the world frame
      const vbx = vx0 + q0 * bz - r0 * by;
      const vby = vy0 + r0 * bx - p0 * bz;
      const vbz = vz0 + p0 * by - q0 * bx;
      const vwx = R00 * vbx + R01 * vby + R02 * vbz;
      const vwy = R10 * vbx + R11 * vby + R12 * vbz;
      const vwz = R20 * vbx + R21 * vby + R22 * vbz;
      const Fn = HULL_K * pen + (vwz < 0 ? -HULL_C * vwz : 0);
      const vh = Math.hypot(vwx, vwy);
      const fric = (mu * Fn) / (vh > 0.3 ? vh : 0.3);
      const Fwx = -fric * vwx;
      const Fwy = -fric * vwy;
      const Fwz = Fn;
      const fbx = R00 * Fwx + R10 * Fwy + R20 * Fwz;
      const fby = R01 * Fwx + R11 * Fwy + R21 * Fwz;
      const fbz = R02 * Fwx + R12 * Fwy + R22 * Fwz;
      acc.fx += fbx;
      acc.fy += fby;
      acc.fz += fbz;
      acc.mx += by * fbz - bz * fby;
      acc.my += bz * fbx - bx * fbz;
      acc.mz += bx * fby - by * fbx;
      it.hullContacts++;
    };
    contact(hx, hy, zBot, HULL_MU);
    contact(hx, -hy, zBot, HULL_MU);
    contact(-hx, hy, zBot, HULL_MU);
    contact(-hx, -hy, zBot, HULL_MU);
    contact(hx, hy, zTop, HULL_MU);
    contact(hx, -hy, zTop, HULL_MU);
    contact(-hx, hy, zTop, HULL_MU);
    contact(-hx, -hy, zTop, HULL_MU);
    if (tilted) for (let i = 0; i < 4; i++) contact(wheels[i].x, wheels[i].y, -h, HULL_MU_WHEEL);
  }

  // --- 9. equations of motion (semi-implicit Euler) ---------------------------------------------
  const [Ix, Iy, Iz] = bodyInertia(spec);
  state.ax = acc.fx / m;
  state.ay = acc.fy / m;
  let vx = vx0 + (acc.fx / m - (q0 * vz0 - r0 * vy0)) * dt;
  let vy = vy0 + (acc.fy / m - (r0 * vx0 - p0 * vz0)) * dt;
  let vz = vz0 + (acc.fz / m - (p0 * vy0 - q0 * vx0)) * dt;
  let p = p0 + ((acc.mx - q0 * r0 * (Iz - Iy)) / Ix) * dt;
  let q = q0 + ((acc.my - p0 * r0 * (Ix - Iz)) / Iy) * dt;
  let r = r0 + ((acc.mz - p0 * q0 * (Iy - Ix)) / Iz) * dt;

  if (settling) {
    vx = 0;
    vy = 0;
    r = 0;
  } else if (allGround && !tilted) {
    // Low-speed handling: parking-speed manoeuvres and static friction.
    const spd = Math.hypot(vx, vy);
    if (spd < V_EPS) {
      const wgt = smoothstep(V_EPS, 0.3, spd) * Math.min(1, dt / 0.15);
      vy += (0 - vy) * wgt;
      const rKin = (vx * Math.tan(clamp(deltaMean, -1.2, 1.2))) / Math.max(spec.wheelbase, 0.1);
      r += (rKin - r) * wgt;
    }
    if (spd < 0.05 && thr < 0.05) {
      let muN = 0;
      for (let i = 0; i < 4; i++) muN += wheels[i].out0.muPeak * wheels[i].load;
      const held = pedal > 0.05 || handbrake > 0.05 || Math.abs(gbx) < 0.15;
      if (held && m * Math.hypot(gbx, gby) <= muN) {
        vx = 0;
        vy = 0;
        r = 0;
      }
    }
  }

  // attitude: quaternion kinematics q' = ½ q ⊗ (0, p, q, r) with the new rates, renormalised
  const pw = settling ? 0 : p;
  const pq = q;
  const pr = settling ? 0 : r; // settling holds the heading
  let nw = qw + 0.5 * (-qx * pw - qy * pq - qz * pr) * dt;
  let nx = qx + 0.5 * (qw * pw + qy * pr - qz * pq) * dt;
  let ny = qy + 0.5 * (qw * pq - qx * pr + qz * pw) * dt;
  let nz = qz + 0.5 * (qw * pr + qx * pq - qy * pw) * dt;
  const qn = Math.hypot(nw, nx, ny, nz);
  if (qn > 1e-9 && Number.isFinite(qn)) {
    nw /= qn;
    nx /= qn;
    ny /= qn;
    nz /= qn;
  } else {
    nw = 1;
    nx = 0;
    ny = 0;
    nz = 0;
  }
  // Euler angles from the new quaternion (ZYX): pitch = −asin(R20), roll = atan2(R21, R22), yaw = atan2(R10, R00)
  const nR20 = 2 * (nx * nz - ny * nw);
  const nR21 = 2 * (ny * nz + nx * nw);
  const nR22 = 1 - 2 * (nx * nx + ny * ny);
  const nR10 = 2 * (nx * ny + nz * nw);
  const nR00 = 1 - 2 * (ny * ny + nz * nz);
  let pitch = -Math.asin(clamp(nR20, -1, 1));
  let roll = Math.atan2(nR21, nR22);
  let yaw = Math.atan2(nR10, nR00);

  // position (world velocity of the CG through the current rotation)
  const wvx = R00 * vx + R01 * vy + R02 * vz;
  const wvy = R10 * vx + R11 * vy + R12 * vz;
  const wvz = R20 * vx + R21 * vy + R22 * vz;
  let x = x0 + wvx * dt;
  let y = y0 + wvy * dt;
  let z = z0 + wvz * dt;

  // Teleported deep into the ground (a hostile edit, not physics): correct the position instead of
  // letting the penalty spring launch the car into orbit.
  if (deepestPen > 0.5) {
    z += deepestPen - 0.25;
    vz = 0;
    vx *= 0.5;
    vy *= 0.5;
  }

  // NaN guard: never let a bad step poison the state (positions keep their last good value).
  if (!Number.isFinite(x + y + z + vx + vy + vz + p + q + r + roll + pitch + yaw)) {
    x = x0;
    y = y0;
    z = z0;
    vx = 0;
    vy = 0;
    vz = 0;
    p = 0;
    q = 0;
    r = 0;
    roll = Number.isFinite(state.roll) ? state.roll : 0;
    pitch = Number.isFinite(state.pitch) ? state.pitch : 0;
    yaw = Number.isFinite(state.heading) ? state.heading : 0;
    quatFromEuler(it, yaw, pitch, roll);
  } else {
    it.qw = nw;
    it.qx = nx;
    it.qy = ny;
    it.qz = nz;
    it.eYaw = yaw;
    it.ePitch = pitch;
    it.eRoll = roll;
  }

  state.x = x;
  state.y = y;
  state.z = z;
  state.vx = vx;
  state.vy = vy;
  it.vzBody = vz;
  state.vz = R20 * vx + R21 * vy + R22 * vz;
  state.rollRate = p;
  state.pitchRate = q;
  state.yawRate = r;
  state.roll = roll;
  state.pitch = pitch;
  state.heading = yaw;
  state.speed = Math.hypot(R00 * vx + R01 * vy + R02 * vz, R10 * vx + R11 * vy + R12 * vz);

  // --- 10. airborne / rollover bookkeeping ---------------------------------------------------------
  state.airborne = !anyGround;
  if (!settling) {
    state.airTime = state.airborne ? state.airTime + dt : 0;
    if (tilted) it.tiltTime += dt;
    else it.tiltTime = 0;
    const angVel = Math.hypot(p, q, r);
    if (tilted && ((angVel < 0.5 && state.speed < 1) || it.tiltTime > WRECK_TILT_TIME)) state.wrecked = true;
    state.odometer += state.speed * dt;
    state.time += dt;
  }

  // --- 11. thermal & wear, telemetry -------------------------------------------------------------
  let offTrack = false;
  const [sfF, sfR] = [fzF, fzR];
  for (let i = 0; i < 4; i++) {
    const w = wheels[i];
    const front = i < 2;
    const wsI = ws[i];
    if (!settling) {
      updateTireState(front ? spec.tires.front : spec.tires.rear, wsI.tire, w.out, w.load, Math.abs(w.vwx), ambient, dt);
      updateBrakeState(front ? br.front : br.rear, wsI.brake, w.brakePower, state.speed, ambient, dt);
    }
    wsI.load = w.load;
    wsI.slipAngle = w.alpha;
    wsI.slipRatio = w.kappa;
    wsI.fx = w.out.fx;
    wsI.fy = w.out.fy;
    wsI.steer = w.steer;
    wsI.locked = w.locked;
    wsI.spinning = w.spinning;
    wsI.utilisation = w.out.utilisation;
    wsI.compression = w.delta;
    wsI.onGround = w.onGround;
    wsI.surface = w.surface.kind;
    wsI.brakeTorque = w.tBrakeApplied;
    wsI.driveTorque = w.tDrive;
    if (w.onGround && w.sample && !w.sample.onTrack) offTrack = true;
    w.fyBodyPrev = w.fyBody;
  }
  state.offTrack = offTrack;
  state.road = cgSample;
  state.loadTransferLong = wheels[0].load + wheels[1].load - sfF;
  state.loadTransferLatFront = 0.5 * (wheels[1].load - wheels[0].load);
  state.loadTransferLatRear = 0.5 * (wheels[3].load - wheels[2].load);
  void sfR;
}
