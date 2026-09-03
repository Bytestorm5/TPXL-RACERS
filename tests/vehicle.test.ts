/**
 * Vehicle model — unit-level checks: helpers, sign conventions, roads, hostile inputs.
 * The scenario suite (vehicle_scenarios.test.ts) is the behavioural spec.
 */
import { describe, expect, it } from 'vitest';
import { compileBuild } from '../src/design/compile';
import { defaultBuild, presetBuilds } from '../src/design/parts';
import { deg2rad, rad2deg } from '../src/sim/math';
import { bowlRoad, flatRoad, rampRoad, roadNoise, roughnessHeight, valueNoise } from '../src/sim/roads';
import { surfaceProps } from '../src/sim/surface';
import { compileTrack } from '../src/sim/track';
import { G } from '../src/sim/types';
import type { DriverInput, VehicleSpec, VehicleState } from '../src/sim/types';
import {
  NEUTRAL_INPUT,
  SIM_DT,
  bodyInertia,
  brakeLinePressures,
  createVehicleState,
  resetVehicleState,
  staticAxleLoads,
  stepVehicle,
  strutDamping,
} from '../src/sim/vehicle';
import { BUILTIN_TRACKS } from '../src/tracks';

const spec = compileBuild(defaultBuild());
const inp = (o: Partial<DriverInput>): DriverInput => ({ ...NEUTRAL_INPUT, ...o });
const ORIGIN = { x: 0, y: 0, heading: 0 };

function finite(s: VehicleState): boolean {
  const core = s.x + s.y + s.z + s.vx + s.vy + s.vz + s.heading + s.pitch + s.roll + s.yawRate + s.pitchRate + s.rollRate + s.engineRpm + s.ax + s.ay + s.speed + s.odometer + s.time;
  if (!Number.isFinite(core)) return false;
  return s.wheels.every((w) => Number.isFinite(w.load + w.omega + w.fx + w.fy + w.slipAngle + w.slipRatio + w.compression + w.utilisation + w.tire.temp + w.tire.wear + w.brake.temp + w.x + w.y));
}

// ---------------------------------------------------------------------------

describe('static helpers', () => {
  it('staticAxleLoads splits m·g by CG position and sums to the weight', () => {
    const [f, r] = staticAxleLoads(spec);
    expect(f + r).toBeCloseTo(spec.mass * G, 6);
    expect(f / (f + r)).toBeCloseTo(1 - spec.cgToFront / spec.wheelbase, 6);
    expect(f).toBeGreaterThan(r); // the default is front-heavy
  });

  it('brakeLinePressures is a bias bar: the front share equals bias exactly and the stronger side has full pressure', () => {
    for (const [mF, mR] of [[2688, 2520], [1000, 3000], [3000, 1000]]) {
      for (const bias of [0.35, 0.5, 0.64, 0.85]) {
        const p = brakeLinePressures(bias, mF, mR);
        expect(Math.max(p.front, p.rear)).toBeCloseTo(1, 9);
        expect(p.front).toBeGreaterThanOrEqual(0);
        expect(p.rear).toBeGreaterThanOrEqual(0);
        const share = (mF * p.front) / (mF * p.front + mR * p.rear);
        expect(share).toBeCloseTo(bias, 9);
      }
    }
    const neutral = brakeLinePressures(2688 / (2688 + 2520), 2688, 2520);
    expect(neutral.front).toBeCloseTo(1, 9);
    expect(neutral.rear).toBeCloseTo(1, 9);
    expect(Number.isFinite(brakeLinePressures(NaN, 0, 0).front)).toBe(true);
  });

  it('strutDamping converts the damping ratio with the corner mass; bodyInertia applies the documented defaults', () => {
    const [fzF] = staticAxleLoads(spec);
    const cF = strutDamping(spec, true);
    expect(cF).toBeCloseTo(2 * spec.suspension.dampingFront * Math.sqrt((spec.suspension.springRateFront * fzF) / 2 / G), 6);
    const [ix, iy, iz] = bodyInertia(spec);
    expect(iz).toBe(spec.yawInertia);
    expect(iy).toBeCloseTo(0.9 * spec.yawInertia, 9);
    expect(ix).toBeCloseTo(spec.mass * (0.32 * spec.width) ** 2, 9);
    const [ix2, iy2] = bodyInertia({ ...spec, rollInertia: 500, pitchInertia: 1800 });
    expect(ix2).toBe(500);
    expect(iy2).toBe(1800);
  });
});

// ---------------------------------------------------------------------------

describe('roads', () => {
  it('roadNoise is deterministic, bounded in (−1, 1), smooth, and varies at the 0.5 m scale', () => {
    let min = 1;
    let max = -1;
    let prev = roadNoise(0, 0.37);
    let maxJump = 0;
    for (let i = 1; i < 20000; i++) {
      const x = i * 0.005;
      const n = roadNoise(x, 0.37);
      expect(n).toBe(roadNoise(x, 0.37));
      min = Math.min(min, n);
      max = Math.max(max, n);
      maxJump = Math.max(maxJump, Math.abs(n - prev));
      prev = n;
    }
    expect(min).toBeGreaterThan(-1);
    expect(max).toBeLessThan(1);
    expect(max - min).toBeGreaterThan(0.8);
    expect(maxJump).toBeLessThan(0.05); // C¹ interpolation: 5 mm steps move the noise by < 0.05
    expect(valueNoise(NaN, 0, 0.5)).toBe(0);
    expect(valueNoise(1, 1, 0)).toBe(0);
  });

  it('roughnessHeight scales with the surface roughness and is zero on a perfectly smooth surface', () => {
    const gravel = surfaceProps('gravel');
    const asphalt = surfaceProps('asphalt');
    let gMax = 0;
    let aMax = 0;
    for (let i = 0; i < 4000; i++) {
      gMax = Math.max(gMax, Math.abs(roughnessHeight(gravel, i * 0.1, 3)));
      aMax = Math.max(aMax, Math.abs(roughnessHeight(asphalt, i * 0.1, 3)));
    }
    expect(gMax).toBeGreaterThan(0.005);
    expect(gMax).toBeLessThanOrEqual(0.06 * gravel.roughness + 1e-12);
    expect(aMax).toBeLessThanOrEqual(0.06 * asphalt.roughness + 1e-12);
    expect(roughnessHeight({ ...asphalt, roughness: 0 }, 1, 2)).toBe(0);
  });

  it('flatRoad: z = x·tan(grade) − y·tan(bank); gradeAlong / bankAcross follow the query heading like track.ts', () => {
    const r = flatRoad({ grade: deg2rad(5), bank: deg2rad(10), surface: 'gravel' });
    expect(r.sampleAt(10, 0, 0).z).toBeCloseTo(10 * Math.tan(deg2rad(5)), 9);
    expect(r.sampleAt(0, 3, 0).z).toBeCloseTo(-3 * Math.tan(deg2rad(10)), 9); // left side lower for +bank
    const along = r.sampleAt(0, 0, 0);
    expect(along.gradeAlong).toBeCloseTo(deg2rad(5), 9);
    expect(along.bankAcross).toBeCloseTo(deg2rad(10), 9);
    const back = r.sampleAt(0, 0, Math.PI);
    expect(back.gradeAlong).toBeCloseTo(-deg2rad(5), 9);
    expect(back.bankAcross).toBeCloseTo(-deg2rad(10), 9);
    const left = r.sampleAt(0, 0, Math.PI / 2); // facing +y: the bank becomes a (down) grade, the grade a bank
    expect(left.gradeAlong).toBeCloseTo(-deg2rad(10), 9);
    expect(left.bankAcross).toBeCloseTo(deg2rad(5), 9);
    expect(along.surface.kind).toBe('gravel');
    expect(along.onTrack).toBe(true);
    // consistent with a compiled straight track with the same grade and bank
    const t = compileTrack({ format: 1, id: 't', name: 't', closed: false, defaultWidth: 10, defaultSurface: 'asphalt', defaultShoulder: 'grass', segments: [{ length: 200, grade: 100 * Math.tan(deg2rad(5)), bank: 10 }] });
    const ts = t.sampleAt(50, 0, 0.3);
    const fs = r.sampleAt(50, 0, 0.3);
    expect(fs.gradeAlong).toBeCloseTo(ts.gradeAlong, 6);
    expect(fs.bankAcross).toBeCloseTo(ts.bankAcross, 6);
  });

  it('rampRoad: flat, then the ramp, then flat at the new height — or a drop back down when dropGrade is given', () => {
    const plateau = rampRoad({ rampStart: 10, rampLength: 4, rampGrade: 0.25 });
    expect(plateau.sampleAt(5, 0, 0).z).toBe(0);
    expect(plateau.sampleAt(12, 0, 0).z).toBeCloseTo(0.5, 9);
    expect(plateau.sampleAt(12, 0, 0).gradeAlong).toBeCloseTo(Math.atan(0.25), 9);
    expect(plateau.sampleAt(12, 0, Math.PI).gradeAlong).toBeCloseTo(-Math.atan(0.25), 9);
    expect(plateau.sampleAt(100, 0, 0).z).toBeCloseTo(1, 9);
    expect(plateau.sampleAt(100, 0, 0).gradeAlong).toBe(0);
    const jump = rampRoad({ rampStart: 10, rampLength: 4, rampGrade: 0.25, dropGrade: 10 });
    expect(jump.sampleAt(14, 0, 0).z).toBeCloseTo(1, 9);
    expect(jump.sampleAt(14.05, 0, 0).z).toBeCloseTo(0.5, 9);
    expect(jump.sampleAt(14.05, 0, 0).gradeAlong).toBeCloseTo(-Math.atan(10), 9);
    expect(jump.sampleAt(30, 0, 0).z).toBe(0);
    const partial = rampRoad({ rampStart: 0, rampLength: 4, rampGrade: 0.25, dropGrade: 1, dropHeight: 0.4 });
    expect(partial.sampleAt(50, 0, 0).z).toBeCloseTo(0.6, 9);
  });

  it('bowlRoad: constant bank for counter-clockwise travel, lateral positive toward the centre, curvature 1/R', () => {
    const b = bowlRoad({ radius: 50, bank: deg2rad(20) });
    const east = b.sampleAt(50, 0, Math.PI / 2); // on the circle at (R, 0) heading north = CCW
    expect(east.bankAcross).toBeCloseTo(deg2rad(20), 6);
    expect(Math.abs(east.gradeAlong)).toBeLessThan(1e-9);
    expect(east.curvature).toBeCloseTo(1 / 50, 12);
    expect(east.trackHeading).toBeCloseTo(Math.PI / 2, 9);
    expect(east.lateral).toBeCloseTo(0, 9);
    const inside = b.sampleAt(45, 0, Math.PI / 2);
    expect(inside.lateral).toBeCloseTo(5, 9);
    expect(inside.z).toBeLessThan(0); // inside is lower on a +bank
    const north = b.sampleAt(0, 50, Math.PI);
    expect(north.bankAcross).toBeCloseTo(deg2rad(20), 6);
    expect(north.trackHeading).toBeCloseTo(Math.PI, 9);
    expect(north.s).toBeCloseTo((Math.PI / 2) * 50, 6);
  });
});

// ---------------------------------------------------------------------------

describe('state creation and reset', () => {
  it('createVehicleState settles at Δ ≈ 0 with all wheels grounded, idle rpm, first gear, ambient temperatures', () => {
    const road = flatRoad({ ambientTemp: 31 });
    const s = createVehicleState(spec, { x: 3, y: -2, heading: 0.4 }, road);
    expect(s.x).toBeCloseTo(3, 3);
    expect(s.y).toBeCloseTo(-2, 3);
    expect(s.heading).toBeCloseTo(0.4, 9);
    expect(s.z).toBeCloseTo(spec.cgHeight, 2);
    expect(s.gear).toBe(1);
    expect(s.engineRpm).toBe(spec.engine.idleRpm);
    expect(s.wheels.every((w) => w.onGround && Math.abs(w.compression) < 0.005)).toBe(true);
    expect(s.wheels.every((w) => w.tire.temp === 31 && w.brake.temp === 31)).toBe(true);
    expect(s.airborne).toBe(false);
    expect(s.time).toBe(0);
    expect(s.odometer).toBe(0);
    // wheel world positions sit at the corners
    const a = spec.cgToFront;
    expect(s.wheels[0].x).toBeCloseTo(3 + a * Math.cos(0.4) - (spec.trackFront / 2) * Math.sin(0.4), 3);
    expect(s.wheels[0].y).toBeCloseTo(-2 + a * Math.sin(0.4) + (spec.trackFront / 2) * Math.cos(0.4), 3);
  });

  it('on a slope the body is created parallel to the road (pitch = −gradeAlong)', () => {
    const road = flatRoad({ grade: deg2rad(6) });
    const s = createVehicleState(spec, ORIGIN, road);
    expect(rad2deg(s.pitch)).toBeCloseTo(-6, 0);
    expect(s.wheels.every((w) => Math.abs(w.compression) < 0.01)).toBe(true);
  });

  it('resetVehicleState re-poses, zeroes motion and attitude, clears wrecked, keeps temperatures and wear, keeps the odometer', () => {
    const road = flatRoad();
    const s = createVehicleState(spec, ORIGIN, road);
    for (let i = 0; i < 240; i++) stepVehicle(spec, s, inp({ throttle: 1 }), road, SIM_DT);
    s.wheels[0].tire.temp = 90;
    s.wheels[0].tire.wear = 0.2;
    s.wheels[1].brake.temp = 300;
    s.wrecked = true;
    const odo = s.odometer;
    expect(odo).toBeGreaterThan(1);
    resetVehicleState(spec, s, { x: 100, y: 50, heading: 1 }, road);
    expect(s.x).toBeCloseTo(100, 3);
    expect(s.y).toBeCloseTo(50, 3);
    expect(s.heading).toBeCloseTo(1, 9);
    expect(s.vx).toBe(0);
    expect(s.vy).toBe(0);
    expect(s.yawRate).toBe(0);
    expect(s.speed).toBe(0);
    expect(Math.abs(s.pitch)).toBeLessThan(0.01);
    expect(Math.abs(s.roll)).toBeLessThan(0.01);
    expect(s.wrecked).toBe(false);
    expect(s.airborne).toBe(false);
    expect(s.wheels[0].tire.temp).toBe(90);
    expect(s.wheels[0].tire.wear).toBe(0.2);
    expect(s.wheels[1].brake.temp).toBe(300);
    expect(s.odometer).toBe(odo);
    expect(s.wheels.every((w) => w.onGround)).toBe(true);
    // and it drives again
    for (let i = 0; i < 120; i++) stepVehicle(spec, s, inp({ throttle: 1 }), road, SIM_DT);
    expect(s.speed).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------

describe('conventions', () => {
  it('steer > 0 is a left turn (yaw rate > 0, heading increases); the inner (left) wheel steers more (Ackermann)', () => {
    const road = flatRoad();
    const s = createVehicleState(spec, ORIGIN, road);
    s.vx = 10;
    for (const w of s.wheels) w.omega = 10 / spec.tires.front.radius;
    for (let i = 0; i < 120; i++) stepVehicle(spec, s, inp({ steer: 0.5 }), road, SIM_DT);
    expect(s.yawRate).toBeGreaterThan(0.1);
    expect(s.heading).toBeGreaterThan(0.05);
    expect(s.wheels[0].steer).toBeGreaterThan(s.wheels[1].steer);
    expect(s.wheels[1].steer).toBeGreaterThan(0);
    expect(s.wheels[2].steer).toBe(0);
    // the mean road-wheel angle is steer × lock × speed-fraction
    const lockFrac = 1 + (spec.steering.highSpeedLockFraction - 1) * Math.min(1, s.speed / spec.steering.fullLockSpeed);
    expect(0.5 * (s.wheels[0].steer + s.wheels[1].steer)).toBeCloseTo(0.5 * spec.steering.maxSteerAngle * lockFrac, 3);
  });

  it('body roll > 0 (right side down) in a left turn; the world vertical velocity is reported in vz', () => {
    const road = flatRoad();
    const s = createVehicleState(spec, ORIGIN, road);
    s.vx = 15;
    for (const w of s.wheels) w.omega = 15 / spec.tires.front.radius;
    for (let i = 0; i < 240; i++) {
      stepVehicle(spec, s, inp({ steer: 0.2 }), road, SIM_DT);
      s.vx = 15;
    }
    expect(s.roll).toBeGreaterThan(0);
    expect(s.wheels[1].load).toBeGreaterThan(s.wheels[0].load);
    expect(Math.abs(s.vz)).toBeLessThan(0.05);
  });

  it('gear shifts are edge-triggered; reverse is reached from 1st at rest and drives backwards', () => {
    const road = flatRoad();
    const sp: VehicleSpec = { ...spec, drivetrain: { ...spec.drivetrain, autoShift: false } };
    const s = createVehicleState(sp, ORIGIN, road);
    stepVehicle(sp, s, inp({ shiftUp: true }), road, SIM_DT);
    expect(s.gear).toBe(2);
    stepVehicle(sp, s, inp({ shiftUp: true }), road, SIM_DT); // held → no second shift
    expect(s.gear).toBe(2);
    stepVehicle(sp, s, inp({ shiftUp: false }), road, SIM_DT);
    stepVehicle(sp, s, inp({ shiftDown: true }), road, SIM_DT);
    expect(s.gear).toBe(1);
    stepVehicle(sp, s, inp({ shiftDown: false }), road, SIM_DT);
    for (let i = 0; i < 30; i++) stepVehicle(sp, s, NEUTRAL_INPUT, road, SIM_DT); // shift timer expires
    stepVehicle(sp, s, inp({ shiftDown: true }), road, SIM_DT);
    expect(s.gear).toBe(-1);
    for (let i = 0; i < 240; i++) stepVehicle(sp, s, inp({ throttle: 0.5 }), road, SIM_DT);
    expect(s.vx).toBeLessThan(-0.5);
    expect(s.x).toBeLessThan(-0.2);
    expect(finite(s)).toBe(true);
  });

  it('telemetry: compression, onGround, loads, load-transfer fields and road sample are populated', () => {
    const road = flatRoad({ surface: 'gravel' });
    const s = createVehicleState(spec, ORIGIN, road);
    for (let i = 0; i < 120; i++) stepVehicle(spec, s, inp({ throttle: 0.5 }), road, SIM_DT);
    expect(s.wheels.every((w) => w.surface === 'gravel')).toBe(true);
    expect(s.road.surface.kind).toBe('gravel');
    expect(s.loadTransferLong).toBeLessThan(0); // accelerating → load leaves the front
    expect(s.wheels[2].compression).toBeGreaterThan(s.wheels[0].compression);
    expect(s.wheels.every((w) => w.load > 0 && w.onGround)).toBe(true);
    expect(s.time).toBeCloseTo(1, 6);
    expect(s.odometer).toBeGreaterThan(0);
    expect(s.input.throttle).toBe(0.5);
    expect(s.wheels[2].driveTorque).toBeGreaterThan(0);
    expect(s.wheels[0].driveTorque).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('hostility and robustness', () => {
  const garbage: DriverInput[] = [
    inp({ throttle: NaN, brake: Infinity, steer: -Infinity, handbrake: NaN }),
    inp({ throttle: 5, brake: -3, steer: 7 }),
    inp({ throttle: 1, brake: 1, steer: 1, handbrake: 1 }),
  ];
  it('never produces NaN for garbage inputs, hostile dt, or a state teleported into the ground / the air / on its roof', () => {
    const road = flatRoad({ surface: 'curb' });
    const s = createVehicleState(spec, ORIGIN, road);
    for (const g of garbage) for (let i = 0; i < 60; i++) stepVehicle(spec, s, g, road, SIM_DT);
    expect(finite(s)).toBe(true);
    for (const dt of [0, -1, NaN, Infinity]) stepVehicle(spec, s, NEUTRAL_INPUT, road, dt);
    expect(finite(s)).toBe(true);
    stepVehicle(spec, s, NEUTRAL_INPUT, road, 0.1); // a long step is subdivided
    expect(finite(s)).toBe(true);
    // buried, thrown, flipped
    s.z = -1;
    for (let i = 0; i < 240; i++) stepVehicle(spec, s, inp({ throttle: 1 }), road, SIM_DT);
    expect(finite(s)).toBe(true);
    s.z = 20;
    s.vx = 30;
    for (let i = 0; i < 600; i++) stepVehicle(spec, s, inp({ brake: 1, steer: 1 }), road, SIM_DT);
    expect(finite(s)).toBe(true);
    s.roll = Math.PI;
    s.z = spec.cgHeight + 1;
    for (let i = 0; i < 600; i++) stepVehicle(spec, s, inp({ throttle: 1, steer: -1 }), road, SIM_DT);
    expect(finite(s)).toBe(true);
    // dropped on its roof from 1 m it either stays there (wrecked) or bounces back onto its wheels and
    // drives off in donuts (full throttle, full lock) — either way the state stays bounded
    expect(Math.abs(s.z)).toBeLessThan(10);
    expect(s.speed).toBeLessThan(100);
    expect(s.wrecked || Math.abs(s.roll) < deg2rad(60)).toBe(true);
    // parked on its roof it is a wreck (tilt > 55°, at rest)
    const roof = createVehicleState(spec, ORIGIN, road);
    roof.roll = Math.PI;
    roof.z = (spec.height ?? 1.3) - spec.cgHeight + 0.02;
    for (let i = 0; i < 360; i++) stepVehicle(spec, roof, NEUTRAL_INPUT, road, SIM_DT);
    expect(finite(roof)).toBe(true);
    expect(roof.wrecked).toBe(true);
    expect(roof.wheels.every((w) => !w.onGround && w.load === 0)).toBe(true);
    s.vx = NaN;
    s.yawRate = Infinity;
    stepVehicle(spec, s, NEUTRAL_INPUT, road, SIM_DT);
    expect(finite(s)).toBe(true);
  });

  it('every preset survives 5 s of chaotic input on every built-in track with finite state', () => {
    const all = [spec, ...presetBuilds().map(compileBuild)];
    for (const t of BUILTIN_TRACKS) {
      const tr = compileTrack(t);
      for (const sp of all) {
        const s = createVehicleState(sp, tr.gridSlot(3), tr);
        for (let i = 0; i < 600; i++) {
          const k = i / 120;
          stepVehicle(sp, s, inp({ throttle: k < 3 ? 1 : 0, brake: k > 3 ? 1 : 0, steer: Math.sin(3 * k), handbrake: k > 4 ? 1 : 0, shiftUp: i % 50 === 0 }), tr, SIM_DT);
        }
        expect(finite(s), `${sp.name} on ${t.id}`).toBe(true);
      }
    }
  });

  it('a state cloned through JSON keeps stepping (internal scratch is re-created lazily)', () => {
    const road = flatRoad();
    const s = createVehicleState(spec, ORIGIN, road);
    for (let i = 0; i < 120; i++) stepVehicle(spec, s, inp({ throttle: 1 }), road, SIM_DT);
    const clone = JSON.parse(JSON.stringify(s)) as VehicleState;
    for (let i = 0; i < 120; i++) stepVehicle(spec, clone, inp({ throttle: 1 }), road, SIM_DT);
    expect(finite(clone)).toBe(true);
    expect(clone.speed).toBeGreaterThan(s.speed);
  });
});
