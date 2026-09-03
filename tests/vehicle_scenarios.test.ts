/**
 * Vehicle model — executable scenario spec (docs/notes/vehicle.md explains every deviation from
 * the written brief). All runs use dt = SIM_DT, compiled builds and the synthetic roads in
 * src/sim/roads.ts or the built-in tracks. Tyres are pre-warmed to their optimal temperature where
 * a scenario is about grip limits (a cold sport tyre has ~75 % of its grip).
 */
import { describe, expect, it } from 'vitest';
import { compileBuild } from '../src/design/compile';
import { defaultBuild, presetBuilds } from '../src/design/parts';
import { deg2rad, rad2deg } from '../src/sim/math';
import { bowlRoad, flatRoad, rampRoad } from '../src/sim/roads';
import { surfaceProps } from '../src/sim/surface';
import { tirePeakMu } from '../src/sim/tire';
import { compileTrack } from '../src/sim/track';
import type { CompiledTrack } from '../src/sim/track';
import { G } from '../src/sim/types';
import type { DriverInput, RoadQuery, VehicleSpec, VehicleState } from '../src/sim/types';
import { NEUTRAL_INPUT, SIM_DT, createVehicleState, staticAxleLoads, stepVehicle } from '../src/sim/vehicle';
import { BUILTIN_TRACKS } from '../src/tracks';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const spec = compileBuild(defaultBuild());
const presets = presetBuilds().map(compileBuild);
const preset = (name: string): VehicleSpec => {
  const p = presets.find((s) => s.name === name);
  if (!p) throw new Error(`no preset ${name}`);
  return p;
};
const auto = (sp: VehicleSpec): VehicleSpec => ({ ...sp, drivetrain: { ...sp.drivetrain, autoShift: true } });
const withSusp = (sp: VehicleSpec, over: Partial<VehicleSpec['suspension']>): VehicleSpec => ({ ...sp, suspension: { ...sp.suspension, ...over } });
const withBrakes = (sp: VehicleSpec, over: Partial<VehicleSpec['brakes']>): VehicleSpec => ({ ...sp, brakes: { ...sp.brakes, ...over } });
const inp = (o: Partial<DriverInput>): DriverInput => ({ ...NEUTRAL_INPUT, ...o });
const kmh = (v: number): number => v / 3.6;
const ORIGIN = { x: 0, y: 0, heading: 0 };

function warm(s: VehicleState, sp: VehicleSpec): void {
  for (let i = 0; i < 4; i++) s.wheels[i].tire.temp = (i < 2 ? sp.tires.front : sp.tires.rear).optimalTemp;
}
function setSpeed(s: VehicleState, sp: VehicleSpec, v: number): void {
  s.vx = v;
  for (let i = 0; i < 4; i++) s.wheels[i].omega = v / (i < 2 ? sp.tires.front : sp.tires.rear).radius;
}
/** A driver keeping the car straight: a yaw damper plus a little sideslip correction. */
function straightSteer(s: VehicleState): number {
  const beta = s.vx > 3 ? s.vy / s.vx : 0;
  return Math.max(-0.3, Math.min(0.3, -1.5 * s.yawRate - 0.3 * beta));
}
/** A driver following the road centreline (works for bowlRoad and compiled tracks). */
function laneSteer(s: VehicleState, gain = 0.08): number {
  const hErr = Math.atan2(Math.sin(s.road.trackHeading - s.heading), Math.cos(s.road.trackHeading - s.heading));
  return Math.max(-0.6, Math.min(0.6, gain * -s.road.lateral + 1.5 * hErr + 0.35 * s.road.curvature * s.speed));
}
function finite(s: VehicleState): boolean {
  const core = s.x + s.y + s.z + s.vx + s.vy + s.vz + s.heading + s.pitch + s.roll + s.yawRate + s.pitchRate + s.rollRate + s.engineRpm + s.ax + s.ay + s.speed;
  if (!Number.isFinite(core)) return false;
  return s.wheels.every((w) => Number.isFinite(w.load + w.omega + w.fx + w.fy + w.slipAngle + w.slipRatio + w.compression + w.utilisation + w.tire.temp + w.tire.wear + w.brake.temp));
}
function fresh(sp: VehicleSpec, road: RoadQuery, pose = ORIGIN, warmTyres = true): VehicleState {
  const s = createVehicleState(sp, pose, road);
  if (warmTyres) warm(s, sp);
  return s;
}
function run(sp: VehicleSpec, s: VehicleState, road: RoadQuery, seconds: number, driver: (s: VehicleState, t: number) => DriverInput, each?: (s: VehicleState, t: number) => void): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) {
    const t = i * SIM_DT;
    stepVehicle(sp, s, driver(s, t), road, SIM_DT);
    if (each) each(s, t + SIM_DT);
  }
}
const sumLoads = (s: VehicleState): number => s.wheels.reduce((a, w) => a + w.load, 0);
const staticWheel = (sp: VehicleSpec, i: number): number => staticAxleLoads(sp)[i < 2 ? 0 : 1] / 2;

/** Full stop from v0 with a given pedal; returns distance and what locked. */
function stopFrom(sp: VehicleSpec, v0: number, pedal = 1, s?: VehicleState, road: RoadQuery = flatRoad()) {
  const st = s ?? fresh(sp, road);
  setSpeed(st, sp, v0);
  const x0 = st.x;
  const y0 = st.y;
  let locked = [false, false, false, false];
  let firstLocked = -1;
  let decelSum = 0;
  let decelN = 0;
  let maxPitch = -Infinity;
  let dive = false;
  let n = 0;
  do {
    stepVehicle(sp, st, inp({ brake: pedal, steer: straightSteer(st) }), road, SIM_DT);
    n++;
    st.wheels.forEach((w, i) => {
      if (w.locked) {
        locked[i] = true;
        if (firstLocked < 0) firstLocked = i;
      }
    });
    if (st.speed > 2) {
      decelSum += -st.ax;
      decelN++;
    }
    maxPitch = Math.max(maxPitch, st.pitch);
    if (st.wheels[0].compression > st.wheels[2].compression && st.wheels[1].compression > st.wheels[3].compression) dive = true;
  } while (st.speed > 0.3 && n < 6000);
  return { dist: Math.hypot(st.x - x0, st.y - y0), locked, firstLocked, decelG: decelSum / Math.max(decelN, 1) / G, maxPitch, dive, state: st };
}

// ---------------------------------------------------------------------------
// a. Rest
// ---------------------------------------------------------------------------

describe('a. rest', () => {
  it('sits still on flat asphalt at equilibrium ride height', () => {
    const road = flatRoad();
    const s = fresh(spec, road, ORIGIN, false);
    const z0 = s.z;
    run(spec, s, road, 5, () => NEUTRAL_INPUT);
    expect(Math.hypot(s.x, s.y)).toBeLessThan(0.01);
    expect(Math.abs(s.z - z0)).toBeLessThan(0.01);
    expect(Math.abs(rad2deg(s.pitch))).toBeLessThan(0.5);
    expect(Math.abs(rad2deg(s.roll))).toBeLessThan(0.5);
    expect(Math.abs(s.engineRpm - spec.engine.idleRpm)).toBeLessThan(0.01 * spec.engine.idleRpm + 1);
    expect(Math.abs(sumLoads(s) - spec.mass * G)).toBeLessThan(0.01 * spec.mass * G);
    expect(s.wheels.every((w) => w.onGround)).toBe(true);
    expect(s.airborne).toBe(false);
    expect(s.wrecked).toBe(false);
    // static loads per axle within 2 % of staticAxleLoads
    const [fzF, fzR] = staticAxleLoads(spec);
    expect(Math.abs(s.wheels[0].load + s.wheels[1].load - fzF)).toBeLessThan(0.02 * fzF);
    expect(Math.abs(s.wheels[2].load + s.wheels[3].load - fzR)).toBeLessThan(0.02 * fzR);
  });

  it('on a +10° bank the body rolls to −10° (right side higher) and the struts carry m·g·cos(10°)', () => {
    const road = flatRoad({ bank: deg2rad(10) });
    const s = fresh(spec, road, ORIGIN, false);
    run(spec, s, road, 5, () => NEUTRAL_INPUT);
    expect(rad2deg(s.roll)).toBeGreaterThan(-11);
    expect(rad2deg(s.roll)).toBeLessThan(-9);
    const expected = spec.mass * G * Math.cos(deg2rad(10));
    expect(Math.abs(sumLoads(s) - expected)).toBeLessThan(0.03 * expected);
    expect(Math.hypot(s.x, s.y)).toBeLessThan(0.05);
  });

  it('on an +8° uphill grade with brake + handbrake it holds and sits nose-up (pitch < 0)', () => {
    const road = flatRoad({ grade: deg2rad(8) });
    const s = fresh(spec, road, ORIGIN, false);
    run(spec, s, road, 5, () => inp({ brake: 1, handbrake: 1 }));
    expect(Math.hypot(s.x, s.y)).toBeLessThan(0.5);
    expect(s.pitch).toBeLessThan(0);
    expect(rad2deg(s.pitch)).toBeGreaterThan(-9);
    expect(rad2deg(s.pitch)).toBeLessThan(-7);
  });
});

// ---------------------------------------------------------------------------
// b. Launch
// ---------------------------------------------------------------------------

/**
 * Full-throttle launch with a sensible driver: straight-line steering correction and a lift to 40 %
 * while a driven wheel is spinning (a slick-shod 400 Nm car at literal bang-bang throttle cooks its
 * rear tyres in a gear-shifting burnout — see docs/notes/vehicle.md).
 */
function launch(sp: VehicleSpec, seconds = 20) {
  const road = flatRoad();
  const s = fresh(sp, road);
  let t100 = -1;
  let maxRpm = 0;
  let squat = false;
  let noseUp = false;
  const split = sp.drivetrain.frontTorqueSplit;
  const drivenSpinning = (st: VehicleState): boolean =>
    (split > 0 && (st.wheels[0].spinning || st.wheels[1].spinning)) || (split < 1 && (st.wheels[2].spinning || st.wheels[3].spinning));
  run(sp, s, road, seconds, (st) => inp({ throttle: drivenSpinning(st) ? 0.4 : 1, steer: straightSteer(st) }), (st, t) => {
    maxRpm = Math.max(maxRpm, st.engineRpm);
    if (t100 < 0 && st.speed >= kmh(100)) t100 = t;
    if (t > 0.2 && t < 1) {
      if (st.wheels[2].compression > st.wheels[0].compression && st.wheels[3].compression > st.wheels[1].compression) squat = true;
      if (st.pitch < 0) noseUp = true;
    }
  });
  return { t100, maxRpm, squat, noseUp, state: s };
}

describe('b. launch', () => {
  it('default car reaches 100 km/h in 3..12 s, never over-revs, and squats (nose up) under acceleration', () => {
    const r = launch(spec);
    expect(r.t100).toBeGreaterThan(3);
    expect(r.t100).toBeLessThan(12);
    expect(r.maxRpm).toBeLessThanOrEqual(spec.engine.limiterRpm * 1.05);
    expect(r.squat).toBe(true);
    expect(r.noseUp).toBe(true);
    expect(finite(r.state)).toBe(true);
  });

  it('Track Weapon is quicker to 100 km/h than the Kei Racer', () => {
    const tw = launch(auto(preset('Track Weapon')));
    const kei = launch(auto(preset('Kei Racer')));
    expect(tw.t100).toBeGreaterThan(0);
    expect(kei.t100).toBeGreaterThan(0);
    expect(tw.t100).toBeLessThan(kei.t100);
    expect(tw.maxRpm).toBeLessThanOrEqual(preset('Track Weapon').engine.limiterRpm * 1.05);
  });
});

// ---------------------------------------------------------------------------
// c. Top speed
// ---------------------------------------------------------------------------

describe('c. top speed', () => {
  it('plateaus below 420 km/h and carries more suspension compression at 200+ km/h than at 50 (aero load)', () => {
    const road = flatRoad();
    const s = fresh(spec, road);
    setSpeed(s, spec, kmh(160)); // the drag-limited asymptote is approached slowly: start near it
    let v55 = 0;
    let comp50 = NaN;
    let comp200 = NaN;
    run(spec, s, road, 60, (st) => inp({ throttle: 1, steer: straightSteer(st) }), (st, t) => {
      if (Math.abs(t - 55) < SIM_DT / 2) v55 = st.speed;
      const v = st.speed * 3.6;
      const comp = st.wheels.reduce((a, w) => a + w.compression, 0) / 4;
      if (Number.isNaN(comp50) && v >= 50 && v < 51 && t < 1) comp50 = comp; // starts at 100, so measure 50 on a separate run below
      if (Number.isNaN(comp200) && v >= 200) comp200 = comp;
    });
    expect(s.speed * 3.6).toBeLessThan(420);
    expect(s.speed * 3.6).toBeGreaterThan(150);
    expect(Math.abs(s.speed - v55) * 3.6).toBeLessThan(1);
    // 50 km/h reference compression: hold 50 km/h on the same road
    const s50 = fresh(spec, road);
    setSpeed(s50, spec, kmh(50));
    run(spec, s50, road, 3, (st) => inp({ throttle: 0.15, steer: straightSteer(st) }), (st) => setSpeed(st, spec, kmh(50)));
    comp50 = s50.wheels.reduce((a, w) => a + w.compression, 0) / 4;
    expect(Number.isNaN(comp200)).toBe(false);
    expect(comp200).toBeGreaterThan(comp50 + 0.002);
  });
});

// ---------------------------------------------------------------------------
// d–f. Braking
// ---------------------------------------------------------------------------

describe('d. braking with ABS', () => {
  it('stops from 100 km/h at 0.8..1.4 g in 30..60 m, no wheel locks, the nose dives', () => {
    const r = stopFrom(spec, kmh(100));
    expect(r.decelG).toBeGreaterThan(0.8);
    expect(r.decelG).toBeLessThan(1.4);
    expect(r.dist).toBeGreaterThan(30);
    expect(r.dist).toBeLessThan(60);
    expect(r.locked.some((l) => l)).toBe(false);
    expect(r.maxPitch).toBeGreaterThan(0);
    expect(r.dive).toBe(true);
  });
});

describe('e. braking without ABS', () => {
  it('full pedal locks wheels and stops longer than ABS; 20 % brake torque cannot lock and is longer again', () => {
    const abs = stopFrom(spec, kmh(100));
    const noAbs = stopFrom(withBrakes(spec, { abs: false }), kmh(100));
    const weak = stopFrom(
      withBrakes(spec, {
        abs: false,
        front: { ...spec.brakes.front, maxTorque: spec.brakes.front.maxTorque * 0.2 },
        rear: { ...spec.brakes.rear, maxTorque: spec.brakes.rear.maxTorque * 0.2 },
      }),
      kmh(100),
    );
    expect(noAbs.locked.some((l) => l)).toBe(true);
    expect(noAbs.dist).toBeGreaterThan(abs.dist);
    expect(weak.locked.some((l) => l)).toBe(false);
    expect(weak.dist).toBeGreaterThan(noAbs.dist);
  });
});

describe('f. brake bias', () => {
  const firstToLock = (bias: number): number => {
    const sp = withBrakes(spec, { abs: false, bias });
    const road = flatRoad();
    const s = fresh(sp, road);
    setSpeed(s, sp, kmh(100));
    let first = -1;
    run(sp, s, road, 5, (st, t) => inp({ brake: Math.min(1, t / 3), steer: straightSteer(st) }), (st) => {
      if (first < 0) st.wheels.forEach((w, i) => { if (w.locked && first < 0) first = i; });
    });
    return first;
  };
  it('bias 0.85 locks a front wheel first, bias 0.35 a rear wheel first (pedal ramp)', () => {
    const f = firstToLock(0.85);
    const r = firstToLock(0.35);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(2);
    expect(r).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// g. Fade
// ---------------------------------------------------------------------------

describe('g. brake fade', () => {
  const tenStops = (cooling: number) => {
    const sp = withBrakes(spec, {
      front: { ...spec.brakes.front, coolingCoeff: cooling, heatCapacity: 900 },
      rear: { ...spec.brakes.rear, coolingCoeff: cooling, heatCapacity: 800 },
    });
    const road = flatRoad();
    const s = fresh(sp, road);
    const dists: number[] = [];
    let maxTemp = 0;
    for (let k = 0; k < 10; k++) {
      dists.push(stopFrom(sp, kmh(150), 1, s, road).dist);
      run(sp, s, road, 8, (st) => inp({ throttle: 0.3, steer: straightSteer(st) }), (st) => setSpeed(st, sp, 40));
      maxTemp = Math.max(maxTemp, s.wheels[0].brake.temp);
      warm(s, sp);
    }
    return { dists, maxTemp, fadeStart: sp.brakes.front.fadeStartTemp };
  };
  it('poorly cooled brakes exceed fadeStartTemp and the 10th stop is longer; 6× cooling keeps the 10th within 10 % of the 1st', () => {
    const hot = tenStops(10);
    expect(hot.maxTemp).toBeGreaterThan(hot.fadeStart);
    expect(hot.dists[9]).toBeGreaterThan(hot.dists[0] * 1.05);
    const cool = tenStops(60);
    expect(cool.dists[9]).toBeLessThan(cool.dists[0] * 1.1);
    expect(cool.dists[9]).toBeGreaterThan(cool.dists[0] * 0.9);
  });
});

// ---------------------------------------------------------------------------
// h. Steady cornering
// ---------------------------------------------------------------------------

/** Hold speed (vx is re-imposed every step) with a fixed steer; returns the settled state. */
function heldCorner(sp: VehicleSpec, v: number, steer: number, road: RoadQuery = flatRoad(), seconds = 4, throttle = 0): VehicleState {
  const s = fresh(sp, road);
  setSpeed(s, sp, v);
  run(sp, s, road, seconds, () => inp({ steer, throttle }), (st) => { st.vx = v; });
  return s;
}

describe('h. steady cornering', () => {
  it('steer 0.3 at a held 60 km/h turns left, rolls right-side-down, loads the right wheels, stays under 1.6 g', () => {
    const s = heldCorner(spec, kmh(60), 0.3);
    expect(s.yawRate).toBeGreaterThan(0.1);
    expect(Math.abs(s.ay)).toBeLessThan(1.6 * G);
    expect(s.roll).toBeGreaterThan(deg2rad(0.5));
    expect(s.wheels[1].load).toBeGreaterThan(s.wheels[0].load * 1.3);
    expect(s.wheels[3].load).toBeGreaterThan(s.wheels[2].load * 1.3);
    expect(Math.abs(sumLoads(s) - spec.mass * G)).toBeLessThan(0.05 * spec.mass * G);
    expect(finite(s)).toBe(true);
  });

  it('halving springs and anti-roll bars gives more roll for the same manoeuvre', () => {
    const soft = withSusp(spec, {
      springRateFront: spec.suspension.springRateFront / 2,
      springRateRear: spec.suspension.springRateRear / 2,
      arbFront: spec.suspension.arbFront / 2,
      arbRear: spec.suspension.arbRear / 2,
    });
    const a = heldCorner(spec, kmh(60), 0.3);
    const b = heldCorner(soft, kmh(60), 0.3);
    expect(b.roll).toBeGreaterThan(a.roll * 1.3);
  });
});

// ---------------------------------------------------------------------------
// i. Balance responds to setup
// ---------------------------------------------------------------------------

describe('i. balance', () => {
  const maxYawInSweep = (sp: VehicleSpec, v: number): number => {
    const road = flatRoad();
    const s = fresh(sp, road);
    setSpeed(s, sp, v);
    let maxR = 0;
    run(sp, s, road, 8, (_st, t) => inp({ steer: Math.min(1, t / 8) }), (st) => {
      st.vx = v;
      maxR = Math.max(maxR, st.yawRate);
    });
    return maxR;
  };
  it('tripling the front ARB lowers the peak steady yaw rate (understeer); tripling the rear ARB raises it', () => {
    const base = maxYawInSweep(spec, kmh(60));
    const frontStiff = maxYawInSweep(withSusp(spec, { arbFront: spec.suspension.arbFront * 3 }), kmh(60));
    const rearStiff = maxYawInSweep(withSusp(spec, { arbRear: spec.suspension.arbRear * 3 }), kmh(60));
    expect(frontStiff).toBeLessThan(base);
    expect(rearStiff).toBeGreaterThan(base);
    expect(frontStiff).toBeLessThan(rearStiff * 0.95);
  });
});

// ---------------------------------------------------------------------------
// j. Banking
// ---------------------------------------------------------------------------

describe('j. banking', () => {
  const bowlUtil = (bankDeg: number): { util: number; loads: number } => {
    const R = 60;
    const v = kmh(50);
    const road = bowlRoad({ radius: R, bank: deg2rad(bankDeg) });
    const s = fresh(spec, road, { x: R, y: 0, heading: Math.PI / 2 });
    setSpeed(s, spec, v);
    let util = 0;
    let loads = 0;
    let n = 0;
    run(spec, s, road, 5, (st) => inp({ steer: laneSteer(st) }), (st, t) => {
      st.vx = v;
      if (t > 3) {
        util += st.wheels.reduce((a, w) => a + w.utilisation, 0) / 4;
        loads += sumLoads(st);
        n++;
      }
    });
    expect(Math.abs(s.road.lateral)).toBeLessThan(3);
    return { util: util / n, loads: loads / n };
  };
  it('a +15° bank lowers tyre utilisation and raises the normal load; −15° (off-camber) raises utilisation', () => {
    const flat = bowlUtil(0);
    const banked = bowlUtil(15);
    const off = bowlUtil(-15);
    expect(banked.util).toBeLessThan(flat.util * 0.8);
    expect(off.util).toBeGreaterThan(flat.util * 1.2);
    expect(banked.loads).toBeGreaterThan(flat.loads);
  });
});

// ---------------------------------------------------------------------------
// k. Grade
// ---------------------------------------------------------------------------

describe('k. grade', () => {
  it('6 s of full throttle covers less distance up a 12° grade; in neutral the car rolls back', () => {
    const dist = (grade: number): number => {
      const road = flatRoad({ grade });
      const s = fresh(spec, road);
      run(spec, s, road, 6, (st) => inp({ throttle: 1, steer: straightSteer(st) }));
      return Math.hypot(s.x, s.y);
    };
    expect(dist(deg2rad(12))).toBeLessThan(dist(0) * 0.8);
    const road = flatRoad({ grade: deg2rad(12) });
    const s = fresh(spec, road, ORIGIN, false);
    s.gear = 0;
    run(spec, s, road, 3, () => NEUTRAL_INPUT);
    expect(s.vx).toBeLessThan(-1);
    expect(s.gear).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// l. Wheelspin
// ---------------------------------------------------------------------------

describe('l. wheelspin', () => {
  const spinRun = (sp: VehicleSpec) => {
    const road = flatRoad();
    const s = fresh(sp, road);
    const f0 = s.wheels[0].tire.temp;
    const r0 = s.wheels[2].tire.temp;
    let firstSpin = -1;
    let spinTime = 0;
    let lastSpin = -1;
    let dF = 0;
    let dR = 0;
    run(sp, s, road, 4, (st, t) => inp({ throttle: t < 2 ? 1 : 0, steer: straightSteer(st) }), (st, t) => {
      const spin = st.wheels[2].spinning || st.wheels[3].spinning;
      if (spin && firstSpin < 0) firstSpin = t;
      if (spin && t <= 2) spinTime += SIM_DT;
      if (spin && t > 2) lastSpin = t;
      if (Math.abs(t - 2) < SIM_DT / 2) {
        dF = st.wheels[0].tire.temp - f0;
        dR = st.wheels[2].tire.temp - r0;
      }
    });
    return { firstSpin, spinTime, lastSpin, dF, dR, state: s };
  };
  it('the Muscle spins its rears within 1 s, heats the rears faster than the fronts, and stops spinning within 1 s of lifting', () => {
    const m = spinRun(auto(preset('Muscle')));
    expect(m.firstSpin).toBeGreaterThanOrEqual(0);
    expect(m.firstSpin).toBeLessThan(1);
    expect(m.dR).toBeGreaterThan(m.dF + 1);
    expect(m.lastSpin).toBeLessThan(3);
    expect(finite(m.state)).toBe(true);
    const rally = spinRun(auto(preset('Gravel Rally')));
    expect(rally.spinTime).toBeLessThan(m.spinTime);
  });
});

// ---------------------------------------------------------------------------
// m. Surfaces and roughness
// ---------------------------------------------------------------------------

describe('m. surfaces', () => {
  it('the same manoeuvre uses more of the tyre on gravel than on asphalt, and ice cannot exceed ~0.25 g', () => {
    const utilOn = (kind: 'asphalt' | 'gravel' | 'ice') => {
      const s = heldCorner(spec, kmh(40), 0.3, flatRoad({ surface: kind }), 3);
      return { util: Math.max(...s.wheels.map((w) => w.utilisation)), ay: Math.abs(s.ay) / G };
    };
    const asphalt = utilOn('asphalt');
    const gravel = utilOn('gravel');
    const ice = utilOn('ice');
    expect(gravel.util).toBeGreaterThan(asphalt.util);
    expect(ice.ay).toBeLessThan(0.25);
  });

  it('gravel roughness makes the wheel loads fluctuate by more than 2 % of their mean at 20 m/s', () => {
    const road = flatRoad({ surface: 'gravel' });
    const s = fresh(spec, road);
    setSpeed(s, spec, 20);
    const loads: number[] = [];
    run(spec, s, road, 3, (st) => inp({ throttle: 0.25, steer: straightSteer(st) }), (st, t) => {
      st.vx = 20;
      if (t > 1) loads.push(st.wheels[0].load);
    });
    const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
    const sd = Math.sqrt(loads.reduce((a, b) => a + (b - mean) ** 2, 0) / loads.length);
    expect(sd / mean).toBeGreaterThan(0.02);
    expect(s.wheels.every((w) => w.onGround)).toBe(true);
    expect(finite(s)).toBe(true);
  });

  it('more damping settles the body faster after a step (massless struts: see notes for why the 40 Hz load scatter itself is not the measure)', () => {
    const settleRms = (damping: number): number => {
      const sp = withSusp(spec, { dampingFront: damping, dampingRear: damping });
      const road = rampRoad({ rampStart: 20, rampLength: 0.5, rampGrade: -0.1 }); // 5 cm step down
      const s = fresh(sp, road);
      setSpeed(s, sp, 15);
      const rates: number[] = [];
      run(sp, s, road, 4, (st) => inp({ steer: straightSteer(st) }), (st) => {
        st.vx = 15;
        if (st.x > 21 + 15 * 0.5 && st.x < 21 + 15 * 1.5) rates.push(st.pitchRate);
      });
      return Math.sqrt(rates.reduce((a, b) => a + b * b, 0) / rates.length);
    };
    expect(settleRms(0.9)).toBeLessThan(settleRms(0.3) * 0.6);
  });
});

// ---------------------------------------------------------------------------
// n. Locked differential pushes
// ---------------------------------------------------------------------------

describe('n. locked diff', () => {
  const meanYaw = (type: 'open' | 'locked'): number => {
    const sp: VehicleSpec = { ...spec, drivetrain: { ...spec.drivetrain, rearDiff: { type, powerLock: 1, coastLock: 1 } } };
    const road = flatRoad();
    const s = fresh(sp, road);
    setSpeed(s, sp, kmh(40));
    let sum = 0;
    let n = 0;
    run(sp, s, road, 4, () => inp({ steer: 0.5, throttle: 0.25 }), (st, t) => {
      if (t > 2) {
        sum += st.yawRate;
        n++;
      }
    });
    return sum / n;
  };
  it('a locked rear diff yields a smaller yaw rate than an open one (40 km/h, steer 0.5, light throttle)', () => {
    const open = meanYaw('open');
    const locked = meanYaw('locked');
    expect(open).toBeGreaterThan(0.2);
    expect(locked).toBeLessThan(open * 0.9);
  });
});

// ---------------------------------------------------------------------------
// o. Load sensitivity
// ---------------------------------------------------------------------------

describe('o. load sensitivity', () => {
  it('front tyres with optimalLoad = 3× the static wheel load are under-worked in a gentle sweep; braking load brings them closer to optimum', () => {
    const stat = staticWheel(spec, 0);
    const heavyOpt: VehicleSpec = { ...spec, tires: { ...spec.tires, front: { ...spec.tires.front, optimalLoad: 3 * stat } } };
    const gentleFrontUtil = (sp: VehicleSpec): number => {
      const road = flatRoad();
      const s = fresh(sp, road);
      setSpeed(s, sp, kmh(60));
      let u = 0;
      let n = 0;
      run(sp, s, road, 3, () => inp({ steer: 0.1 }), (st, t) => {
        st.vx = kmh(60);
        if (t > 2) {
          u += 0.5 * (st.wheels[0].utilisation + st.wheels[1].utilisation);
          n++;
        }
      });
      return u / n;
    };
    expect(gentleFrontUtil(heavyOpt)).toBeGreaterThan(gentleFrontUtil(spec) * 1.02);
    // trail-braking load on the front (≈1.6× static) is closer to the raised optimum → higher mu
    const asphalt = surfaceProps('asphalt');
    const t = heavyOpt.tires.front;
    expect(tirePeakMu(t, 1.6 * stat, t.optimalTemp, 0, 0, asphalt)).toBeGreaterThan(tirePeakMu(t, stat, t.optimalTemp, 0, 0, asphalt));
  });
});

// ---------------------------------------------------------------------------
// p. Jump
// ---------------------------------------------------------------------------

const JUMP = { rampStart: 40, rampLength: 6, rampGrade: 0.25, dropGrade: 10 };

function jump(sp: VehicleSpec, airInput: Partial<DriverInput> = {}) {
  const road = rampRoad(JUMP);
  const s = fresh(sp, road);
  setSpeed(s, sp, kmh(80));
  const stat = staticWheel(sp, 0);
  let maxAirTime = 0;
  let maxZ = -Infinity;
  let loadsInAir = 0;
  let landT = -1;
  let maxLoadRatio = 0;
  let maxComp = -Infinity;
  let pitchInFlight = NaN;
  let speedAfter = -1;
  let ok = true;
  let wasAir = false;
  run(sp, s, road, 8, (st) => (st.airborne ? inp({ ...airInput, steer: 0 }) : inp({ throttle: st.x < 38 ? 0.3 : 0, steer: straightSteer(st) })), (st, t) => {
    if (!finite(st)) ok = false;
    if (st.airborne) {
      maxAirTime = Math.max(maxAirTime, st.airTime);
      maxZ = Math.max(maxZ, st.z);
      for (const w of st.wheels) loadsInAir = Math.max(loadsInAir, w.load);
      if (Number.isNaN(pitchInFlight) && st.airTime >= 0.6) pitchInFlight = st.pitch;
    }
    if (wasAir && !st.airborne && landT < 0) landT = t;
    wasAir = st.airborne;
    for (const w of st.wheels) {
      maxLoadRatio = Math.max(maxLoadRatio, w.load / stat);
      maxComp = Math.max(maxComp, w.compression);
    }
    if (landT > 0 && speedAfter < 0 && t >= landT + 2) speedAfter = st.speed;
  });
  return { maxAirTime, maxZ, loadsInAir, landT, maxLoadRatio, maxComp, pitchInFlight, speedAfter, ok, state: s };
}

describe('p. jump', () => {
  const rally = auto(preset('Gravel Rally'));
  it('the Gravel Rally flies off a 25 % ramp at 80 km/h, lands with a load spike and drives on', () => {
    const r = jump(rally);
    expect(r.ok).toBe(true);
    expect(r.maxAirTime).toBeGreaterThan(0.3);
    expect(r.loadsInAir).toBe(0);
    expect(r.maxZ).toBeGreaterThan(JUMP.rampLength * JUMP.rampGrade + rally.cgHeight + 0.3);
    expect(r.landT).toBeGreaterThan(0);
    expect(r.state.z).toBeLessThan(rally.cgHeight + 0.2);
    expect(r.maxLoadRatio).toBeGreaterThan(2.5);
    expect(r.state.wrecked).toBe(false);
    expect(r.speedAfter * 3.6).toBeGreaterThan(40);
  });

  it('braking in the air pitches the nose down, throttle pitches it up (wheel angular momentum)', () => {
    const none = jump(rally).pitchInFlight;
    const brake = jump(rally, { brake: 1 }).pitchInFlight;
    const throttle = jump(rally, { throttle: 1 }).pitchInFlight;
    expect(brake).toBeGreaterThan(none + deg2rad(1));
    expect(throttle).toBeLessThan(none - deg2rad(1));
  });

  it('the low, stiff Track Weapon hits its bump stops and takes a harder hit than the long-travel rally car', () => {
    const tw = auto(preset('Track Weapon'));
    const a = jump(tw);
    const b = jump(rally);
    expect(a.ok).toBe(true);
    expect(a.maxComp > 0.55 * tw.suspension.travel || a.maxLoadRatio > 5).toBe(true);
    expect(a.maxLoadRatio).toBeGreaterThan(b.maxLoadRatio);
  });
});

// ---------------------------------------------------------------------------
// q. Rollover
// ---------------------------------------------------------------------------

function tallCar(over: Partial<VehicleSpec> = {}, mu = 1.6): VehicleSpec {
  return {
    ...spec,
    // The inertial fixture is pinned (a 1.6 t body) rather than inherited from the default build: the
    // bank comparison below rides its outer wheels for most of the run, i.e. it sits on the tipping edge,
    // and the 20 % lighter default body of the 2026-09-03 chassis re-mass goes over on the bowl.
    mass: 1600,
    yawInertia: 2130,
    cgToFront: 1.25,
    cgHeight: 0.85,
    trackFront: 1.3,
    trackRear: 1.3,
    width: 1.6,
    height: 1.9,
    suspension: { ...spec.suspension, springRateFront: 25000, springRateRear: 25000, arbFront: 5000, arbRear: 5000, travel: 0.16, rideHeightFront: 0.2, rideHeightRear: 0.2 },
    tires: { front: { ...spec.tires.front, peakMu: mu }, rear: { ...spec.tires.rear, peakMu: mu } },
    ...over,
  };
}

function rollRun(sp: VehicleSpec, road: RoadQuery, save: boolean, seconds = 8) {
  const s = fresh(sp, road);
  setSpeed(s, sp, kmh(70));
  let liftT = -1;
  let rollOver55T = -1;
  let maxRoll = 0;
  let maxRollDuringSave = 0;
  let backOnFourT = -1;
  let ok = true;
  let saveUntil = -1;
  run(sp, s, road, seconds, (st, t) => {
    const leftLift = !st.wheels[0].onGround && !st.wheels[2].onGround;
    if (leftLift && liftT < 0) {
      liftT = t;
      if (save) saveUntil = t + 1;
    }
    const steer = save && liftT >= 0 ? (t < saveUntil ? -0.1 : 0) : 0.8;
    return inp({ steer });
  }, (st, t) => {
    if (!finite(st)) ok = false;
    maxRoll = Math.max(maxRoll, Math.abs(st.roll));
    if (save && liftT >= 0) maxRollDuringSave = Math.max(maxRollDuringSave, Math.abs(st.roll));
    if (Math.abs(st.roll) > deg2rad(55) && rollOver55T < 0) rollOver55T = t;
    if (liftT >= 0 && t > liftT + 0.05 && backOnFourT < 0 && st.wheels.every((w) => w.onGround)) backOnFourT = t;
  });
  return { liftT, rollOver55T, maxRoll, maxRollDuringSave, backOnFourT, ok, state: s };
}

describe('q. rollover', () => {
  it('a tall, narrow, soft, grippy car lifts its inner wheels, rolls past 55° and ends up wrecked without NaN', () => {
    const r = rollRun(tallCar(), flatRoad(), false);
    expect(r.ok).toBe(true);
    expect(r.liftT).toBeGreaterThanOrEqual(0);
    expect(r.liftT).toBeLessThan(1.5);
    expect(r.rollOver55T).toBeGreaterThan(0);
    expect(r.rollOver55T).toBeLessThan(4);
    expect(r.state.wrecked).toBe(true);
    expect(Number.isFinite(r.state.speed)).toBe(true);
    expect(r.state.speed).toBeLessThan(2);
  });

  it('counter-steering the instant the inner wheels lift saves it: back on four wheels within 2 s, roll under 40°', () => {
    const r = rollRun(tallCar(), flatRoad(), true);
    expect(r.ok).toBe(true);
    expect(r.liftT).toBeGreaterThanOrEqual(0);
    expect(r.backOnFourT).toBeGreaterThan(0);
    expect(r.backOnFourT - r.liftT).toBeLessThan(2);
    expect(r.maxRollDuringSave).toBeLessThan(deg2rad(40));
    expect(r.state.wrecked).toBe(false);
  });

  it('a wider track or a lower CG keeps the same manoeuvre on its wheels (no rollover)', () => {
    // 1.8 m at cgHeight 0.85 is SSF 1.06 — still a rollover risk with μ 1.6 tyres; 2.2 m (SSF 1.29) is not.
    const wide = rollRun(tallCar({ trackFront: 2.2, trackRear: 2.2, width: 2.3 }), flatRoad(), false, 5);
    const low = rollRun(tallCar({ cgHeight: 0.5 }), flatRoad(), false, 5);
    for (const r of [wide, low]) {
      expect(r.ok).toBe(true);
      expect(r.state.wrecked).toBe(false);
      expect(r.maxRoll).toBeLessThan(deg2rad(20));
    }
  });

  it('a +15° bank makes the same left-turn manoeuvre safer than flat ground', () => {
    // With μ 1.6 the bank raises the tipping threshold to ~1.3 g yet the tyres still deliver more; with
    // μ 1.0 the flat car tips (threshold 0.77 g) while the banked one cannot. The banked road is a bowl
    // (a fixed inclined plane turns into a grade as the car turns).
    const flat = rollRun(tallCar({}, 1.0), flatRoad(), false, 5);
    const R = 40;
    const bowl = bowlRoad({ radius: R, bank: deg2rad(15) });
    const s = fresh(tallCar({}, 1.0), bowl, { x: R, y: 0, heading: Math.PI / 2 });
    setSpeed(s, tallCar({}, 1.0), kmh(70));
    let maxRelRoll = 0;
    let ok = true;
    run(tallCar({}, 1.0), s, bowl, 5, () => inp({ steer: 0.8 }), (st) => {
      if (!finite(st)) ok = false;
      maxRelRoll = Math.max(maxRelRoll, Math.abs(st.roll + st.road.bankAcross)); // roll relative to the road
    });
    expect(ok).toBe(true);
    expect(flat.maxRoll).toBeGreaterThan(deg2rad(55));
    expect(flat.state.wrecked).toBe(true);
    expect(maxRelRoll).toBeLessThan(flat.maxRoll * 0.3);
    expect(s.wrecked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// r. Tripping
// ---------------------------------------------------------------------------

describe('r. tripping', () => {
  it('a sideways slide (vy = −8, vx = 5) settles without rolling over, on asphalt and on curbs', () => {
    for (const surface of ['asphalt', 'curb'] as const) {
      const road = flatRoad({ surface });
      const s = fresh(spec, road);
      s.vx = 5;
      s.vy = -8;
      let ok = true;
      let maxRoll = 0;
      run(spec, s, road, 5, () => NEUTRAL_INPUT, (st) => {
        if (!finite(st)) ok = false;
        maxRoll = Math.max(maxRoll, Math.abs(st.roll));
      });
      expect(ok).toBe(true);
      expect(s.wrecked).toBe(false);
      expect(maxRoll).toBeLessThan(deg2rad(30));
      expect(Math.abs(s.vy)).toBeLessThan(0.5); // the slide is scrubbed off (it may still roll forward)
      expect(s.wheels.every((w) => w.onGround)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// s. On track
// ---------------------------------------------------------------------------

const tracks = new Map<string, CompiledTrack>(BUILTIN_TRACKS.map((t) => [t.id, compileTrack(t)]));
const track = (id: string): CompiledTrack => {
  const t = tracks.get(id);
  if (!t) throw new Error(`no track ${id}`);
  return t;
};

describe('s. on track', () => {
  it('clubsprint: 30 % throttle for 3 s from pole stays on track, s increases, z follows the road', () => {
    const tr = track('clubsprint');
    const s = fresh(spec, tr, tr.gridSlot(0));
    const s0 = s.road.s;
    let ok = true;
    let maxDz = 0;
    run(spec, s, tr, 3, (st) => inp({ throttle: 0.3, steer: laneSteer(st) }), (st) => {
      if (!finite(st)) ok = false;
      maxDz = Math.max(maxDz, Math.abs(st.z - st.road.z - spec.cgHeight));
    });
    expect(ok).toBe(true);
    expect(s.offTrack).toBe(false);
    const ds = ((s.road.s - s0) % tr.length + tr.length) % tr.length;
    expect(ds).toBeGreaterThan(3);
    expect(ds).toBeLessThan(200);
    expect(maxDz).toBeLessThan(0.1);
    expect(s.speed).toBeGreaterThan(2);
  });

  it('speedbowl: at rest on the 24° banking the body rolls to −bank and the struts carry m·g·cos(bank)', () => {
    const tr = track('speedbowl');
    const sm = tr.samples.find((x) => x.bank > deg2rad(23));
    expect(sm).toBeDefined();
    if (!sm) return;
    const s = fresh(spec, tr, { x: sm.x, y: sm.y, heading: sm.heading }, false);
    run(spec, s, tr, 2, () => NEUTRAL_INPUT);
    expect(Math.abs(s.roll + s.road.bankAcross)).toBeLessThan(deg2rad(1));
    const expected = spec.mass * G * Math.cos(s.road.bankAcross);
    expect(Math.abs(sumLoads(s) - expected)).toBeLessThan(0.05 * expected);
  });

  it('pinecone-stage: Gravel Rally, 8 s scripted full throttle from the start — finite, not wrecked', () => {
    const tr = track('pinecone-stage');
    const sp = auto(preset('Gravel Rally'));
    const s = fresh(sp, tr, tr.gridSlot(0));
    let ok = true;
    let airborneMoments = 0;
    run(sp, s, tr, 8, (st) => inp({ throttle: 1, steer: laneSteer(st, 0.05) }), (st) => {
      if (!finite(st)) ok = false;
      if (st.airborne) airborneMoments++;
    });
    expect(ok).toBe(true);
    expect(s.wrecked).toBe(false);
    expect(s.speed).toBeGreaterThan(5);
    // Airborne moments are not required (depends on the stage) — reported for information.
    expect(airborneMoments).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// t. Determinism, u. Performance
// ---------------------------------------------------------------------------

describe('t. determinism', () => {
  const scripted = (): string => {
    const tr = track('clubsprint');
    const sp = spec;
    const s = createVehicleState(sp, tr.gridSlot(0), tr);
    run(sp, s, tr, 10, (st, t) => inp({ throttle: 0.4 + 0.3 * Math.sin(t), brake: t > 6 && t < 7 ? 0.5 : 0, steer: 0.2 * Math.sin(0.7 * t) + laneSteer(st) }));
    return JSON.stringify(s);
  };
  it('two identical 10 s scripted runs are bit-identical', () => {
    const a = scripted();
    const b = scripted();
    expect(a).toBe(b);
  });
});

describe('u. performance', () => {
  it('one car × 12000 steps runs under 2 s', () => {
    const road = flatRoad();
    const s = fresh(spec, road);
    const t0 = performance.now();
    for (let i = 0; i < 12000; i++) stepVehicle(spec, s, inp({ throttle: 0.5, steer: 0.05 * Math.sin(i / 200) }), road, SIM_DT);
    const ms = performance.now() - t0;
    expect(finite(s)).toBe(true);
    expect(ms).toBeLessThan(2000);
  });
});
