/**
 * Cross-module integration probes — the game's core promise: design choices show up in racing.
 *
 * Every probe runs REAL simulated races (race.ts + AI drivers + the 6-DOF vehicle model on the
 * compiled built-in tracks) and checks a causal link between a build decision and a race outcome:
 * lap-time ordering of the presets, setup vs auto-tune, surface affinity, jumps and rollovers, brake
 * fade, analysis-vs-simulation agreement, determinism, wear/thermal magnitudes and throughput.
 * Thresholds are deliberately loose (the AI is a heuristic driver); the ORDERINGS are the spec.
 */
import { describe, expect, it } from 'vitest';
import { analyzeBuild, brakeLinePressures as analyzeLinePressures } from '../src/design/analyze';
import { autoTune } from '../src/design/autotune';
import { compileBuild, normalizeBuild } from '../src/design/compile';
import { defaultBuild, presetBuilds } from '../src/design/parts';
import type { CarBuild } from '../src/design/types';
import { estimateLapTime, gripUsageForSkill } from '../src/sim/ai';
import { createRace } from '../src/sim/race';
import type { Race, RaceEntry } from '../src/sim/race';
import { flatRoad } from '../src/sim/roads';
import { compileTrack } from '../src/sim/track';
import type { CompiledTrack } from '../src/sim/track';
import type { VehicleSpec, VehicleState } from '../src/sim/types';
import { NEUTRAL_INPUT, SIM_DT, brakeLinePressures as vehicleLinePressures, createVehicleState, stepVehicle } from '../src/sim/vehicle';
import { BUILTIN_TRACKS } from '../src/tracks/index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fresh compiled track per call: `sampleAt` keeps a hint cache, so replays share nothing. */
const trackOf = (id: string): CompiledTrack => {
  const spec = BUILTIN_TRACKS.find((t) => t.id === id);
  if (!spec) throw new Error(`no built-in track '${id}'`);
  return compileTrack(spec);
};
const PRESETS = presetBuilds();
const presetBuild = (name: string): CarBuild => {
  const b = PRESETS.find((p) => p.name === name);
  if (!b) throw new Error(`no preset '${name}'`);
  return b;
};
const preset = (name: string): VehicleSpec => compileBuild(presetBuild(name));
const DEFAULT = compileBuild(defaultBuild());
const SLOW = 120_000;

interface RunResult {
  lapTimes: number[];
  best: number;
  finished: boolean;
  time: number;
  resets: number;
  wrecks: number;
  nan: boolean;
  maxTireTemp: number;
  minTireTemp: number;
  maxWear: number;
  maxFrontBrake: number;
  /** Laps (0-based lap counter at the time) during which the car was airborne inside `airS`. */
  airLaps: Set<number>;
  fadeFraction: number;
  wall: number;
  simTime: number;
}

interface RunOpts {
  skill?: number;
  seed?: number;
  preheat?: boolean;
  maxTime?: number;
  airS?: [number, number];
  fadeStart?: number;
  onStep?: (race: Race) => void;
}

/** Simulate a race with AI drivers until everyone finishes (or `maxTime`), collecting per-car facts. */
function runRace(specs: VehicleSpec[], track: CompiledTrack, laps: number, opts: RunOpts = {}): RunResult[] {
  const entries: RaceEntry[] = specs.map((spec, i) => ({
    spec,
    driver: { kind: 'ai', skill: opts.skill ?? 0.8, aggression: 0.5, seed: 7 + i },
    name: spec.name,
  }));
  const race = createRace({ track, entries, laps, seed: opts.seed ?? 1, preheatTyres: opts.preheat });
  race.start();
  const res: RunResult[] = specs.map(() => ({
    lapTimes: [],
    best: Infinity,
    finished: false,
    time: 0,
    resets: 0,
    wrecks: 0,
    nan: false,
    maxTireTemp: -Infinity,
    minTireTemp: Infinity,
    maxWear: 0,
    maxFrontBrake: 0,
    airLaps: new Set(),
    fadeFraction: 0,
    wall: 0,
    simTime: 0,
  }));
  const fadeT = specs.map(() => 0);
  const runT = specs.map(() => 0);
  const wreckedPrev = specs.map(() => false);
  const maxTime = opts.maxTime ?? 600;
  const t0 = performance.now();
  let t = 0;
  while (t < maxTime) {
    race.step(SIM_DT);
    t += SIM_DT;
    let allDone = true;
    for (let i = 0; i < race.cars.length; i++) {
      const car = race.cars[i];
      const st = car.state;
      const r = res[i];
      if (!car.timing.finished) allDone = false;
      if (!Number.isFinite(st.x + st.y + st.z + st.vx + st.vy + st.heading + st.roll + st.pitch)) r.nan = true;
      for (const w of st.wheels) {
        if (w.tire.temp > r.maxTireTemp) r.maxTireTemp = w.tire.temp;
        if (w.tire.temp < r.minTireTemp) r.minTireTemp = w.tire.temp;
        if (w.tire.wear > r.maxWear) r.maxWear = w.tire.wear;
      }
      const bf = Math.max(st.wheels[0].brake.temp, st.wheels[1].brake.temp);
      if (bf > r.maxFrontBrake) r.maxFrontBrake = bf;
      if (opts.fadeStart !== undefined && !car.timing.finished) {
        runT[i] += SIM_DT;
        if (bf > opts.fadeStart) fadeT[i] += SIM_DT;
      }
      if (opts.airS && st.airborne && st.road.s >= opts.airS[0] && st.road.s <= opts.airS[1]) r.airLaps.add(car.timing.lap);
      if (st.wrecked && !wreckedPrev[i]) r.wrecks++;
      wreckedPrev[i] = st.wrecked;
    }
    if (opts.onStep) opts.onStep(race);
    if (allDone) break;
  }
  const wall = (performance.now() - t0) / 1000;
  for (let i = 0; i < race.cars.length; i++) {
    const tm = race.cars[i].timing;
    const r = res[i];
    r.lapTimes = tm.lapTimes ?? [];
    r.best = r.lapTimes.length > 0 ? Math.min(...r.lapTimes) : Infinity;
    r.finished = tm.finished;
    r.time = tm.finishTime ?? t;
    r.resets = tm.resets ?? 0;
    r.fadeFraction = runT[i] > 0 ? fadeT[i] / runT[i] : 0;
    r.wall = wall;
    r.simTime = t;
  }
  return res;
}

const lap2 = (r: RunResult): number => r.lapTimes[1] ?? Infinity;

// ---------------------------------------------------------------------------
// Vehicle-only helpers (analysis vs simulation)
// ---------------------------------------------------------------------------

function warmTyres(spec: VehicleSpec, st: VehicleState): void {
  for (let i = 0; i < 4; i++) {
    st.wheels[i].tire.temp = (i < 2 ? spec.tires.front : spec.tires.rear).optimalTemp;
    st.wheels[i].brake.temp = 150;
  }
}

/** Give a settled state a forward speed in a sensible gear (like a rolling start). */
function launchAt(spec: VehicleSpec, st: VehicleState, v: number): void {
  st.vx = v;
  st.speed = v;
  const rR = spec.tires.rear.radius;
  for (let i = 0; i < 4; i++) st.wheels[i].omega = v / (i < 2 ? spec.tires.front.radius : rR);
  const dtr = spec.drivetrain;
  const rpmIn = (g: number): number => ((v / rR) * dtr.gearRatios[g - 1] * dtr.finalDrive * 60) / (2 * Math.PI);
  let gear = dtr.gearRatios.length;
  for (let g = 1; g <= dtr.gearRatios.length; g++) {
    if (rpmIn(g) <= 0.8 * spec.engine.redlineRpm) {
      gear = g;
      break;
    }
  }
  st.gear = gear;
  st.engineRpm = Math.max(spec.engine.idleRpm, rpmIn(gear));
}

/** Steady-state lateral limit: a slow steer sweep at constant speed on flat asphalt; peak |ay| before the body slip runs away. */
function simSkidpadG(spec: VehicleSpec, v = 25): number {
  const road = flatRoad({ surface: 'asphalt' });
  const st = createVehicleState(spec, { x: 0, y: 0, heading: 0 }, road);
  warmTyres(spec, st);
  launchAt(spec, st, v);
  let best = 0;
  const T = 30;
  for (let i = 0; i < T * 120; i++) {
    const steer = Math.min(1, i / 120 / T);
    stepVehicle(spec, st, { ...NEUTRAL_INPUT, steer }, road, SIM_DT);
    st.vx = v; // hold the speed (scenario-style)
    if (Math.abs(Math.atan2(st.vy, st.vx)) > 0.25) break;
    const g = Math.abs(st.ay) / 9.81;
    if (g > best) best = g;
  }
  return best;
}

/** 0–100 km/h with a minimal launch driver (lift to 40 % while a wheel spins, yaw damper, shifts at 96 % of the limiter). */
function simAccel0to100(spec: VehicleSpec): number {
  const road = flatRoad({ surface: 'asphalt' });
  const st = createVehicleState(spec, { x: 0, y: 0, heading: 0 }, road);
  warmTyres(spec, st);
  let t = 0;
  let shiftCd = 0;
  while (t < 40) {
    const spinning = st.wheels.some((w) => w.spinning);
    const steer = Math.max(-1, Math.min(1, -0.5 * st.yawRate - 2 * st.heading));
    let up = false;
    shiftCd -= SIM_DT;
    if (!spec.drivetrain.autoShift && shiftCd <= 0 && st.shiftTimer <= 0 && st.engineRpm >= 0.96 * spec.engine.limiterRpm && st.gear < spec.drivetrain.gearRatios.length) {
      up = true;
      shiftCd = 0.3;
    }
    stepVehicle(spec, st, { ...NEUTRAL_INPUT, throttle: spinning ? 0.4 : 1, steer, shiftUp: up }, road, SIM_DT);
    t += SIM_DT;
    if (st.vx >= 100 / 3.6) return t;
  }
  return NaN;
}

/** Full-pedal stop from 100 km/h (ABS or locked wheels, whatever the spec has). */
function simBrakingDistance(spec: VehicleSpec): number {
  const road = flatRoad({ surface: 'asphalt' });
  const st = createVehicleState(spec, { x: 0, y: 0, heading: 0 }, road);
  warmTyres(spec, st);
  launchAt(spec, st, 100 / 3.6);
  const x0 = st.x;
  const y0 = st.y;
  let t = 0;
  while (t < 15 && st.speed > 0.3) {
    stepVehicle(spec, st, { ...NEUTRAL_INPUT, brake: 1 }, road, SIM_DT);
    t += SIM_DT;
  }
  return Math.hypot(st.x - x0, st.y - y0);
}

interface RollProbe {
  tipped: boolean;
  maxRollDeg: number;
  maxG: number;
  /** Seconds with at least one wheel off the ground. */
  liftTime: number;
}

/** Fishhook (NHTSA-style) at speed v: full lock one way, then the other. */
function simFishhook(spec: VehicleSpec, v: number): RollProbe {
  const road = flatRoad({ surface: 'asphalt' });
  const st = createVehicleState(spec, { x: 0, y: 0, heading: 0 }, road);
  warmTyres(spec, st);
  launchAt(spec, st, v);
  const r: RollProbe = { tipped: false, maxRollDeg: 0, maxG: 0, liftTime: 0 };
  for (let i = 0; i < 120 * 5; i++) {
    const steer = i < 30 ? 0 : i < 90 ? 1 : -1;
    stepVehicle(spec, st, { ...NEUTRAL_INPUT, steer, throttle: 0.3 }, road, SIM_DT);
    r.maxRollDeg = Math.max(r.maxRollDeg, (Math.abs(st.roll) * 180) / Math.PI);
    r.maxG = Math.max(r.maxG, Math.abs(st.ay) / 9.81);
    if (!st.wheels.every((w) => w.onGround)) r.liftTime += SIM_DT;
    if (st.wrecked || Math.abs(st.roll) > 1.0) {
      r.tipped = true;
      break;
    }
  }
  return r;
}

/** Tall / narrow-for-its-height / soft / grippy: a truck at maximum ride height on soft springs and soft slicks (SSF ≈ 1.0). */
function tallRollerBuild(): CarBuild {
  const b = normalizeBuild({ ...defaultBuild('tall_roller'), name: 'Tall Roller' });
  b.chassis.size = 'truck';
  b.suspension.rideHeightFront = 250;
  b.suspension.rideHeightRear = 250;
  b.suspension.springFront = 15;
  b.suspension.springRear = 15;
  b.suspension.arbFront = 0;
  b.suspension.arbRear = 0;
  b.suspension.damperFront = 0.4;
  b.suspension.damperRear = 0.4;
  b.tires.front = { compound: 'slick_soft', width: 305, pressure: 200, camber: -2.5, rim: 18 };
  b.tires.rear = { compound: 'slick_soft', width: 305, pressure: 200, camber: -2.5, rim: 18 };
  b.brakes.discFront = 380;
  b.brakes.discRear = 380;
  b.aero.wing = 0;
  b.aero.splitter = 0;
  b.aero.underbody = 'none';
  return normalizeBuild(b);
}

/** A heavy large-chassis build (200 kg ballast, full tank, 5 L V8) with either the worst or the best brake package. */
function heavyBrakeBuild(good: boolean): CarBuild {
  const b = normalizeBuild({ ...defaultBuild(good ? 'heavy_good' : 'heavy_bad'), name: good ? 'Heavy (race brakes)' : 'Heavy (street brakes)' });
  b.chassis.size = 'large';
  b.chassis.ballastMass = 200;
  b.chassis.fuel = 80;
  b.engine.displacement = 5.0;
  b.engine.cylinders = 8;
  b.tires.front = { compound: 'semi_slick', width: 255, pressure: 220, camber: -2, rim: 20 };
  b.tires.rear = { compound: 'semi_slick', width: 275, pressure: 220, camber: -1.5, rim: 20 };
  b.brakes.discFront = good ? 420 : 240;
  b.brakes.discRear = good ? 420 : 240;
  b.brakes.pads = good ? 'race' : 'street';
  b.brakes.ducts = good ? 1 : 0;
  return normalizeBuild(b);
}

// ---------------------------------------------------------------------------
// a. Lap-time causality
// ---------------------------------------------------------------------------

describe('a. lap-time causality on clubsprint (one AI car, 2 laps, lap 2)', () => {
  const club = trackOf('clubsprint');
  const laps = new Map<string, RunResult>();
  const lapOf = (name: string): RunResult => {
    let r = laps.get(name);
    if (!r) {
      r = runRace([preset(name)], club, 2, { maxTime: 400 })[0];
      laps.set(name, r);
    }
    return r;
  };

  it('Track Weapon laps faster than Muscle; Club Hatch faster than Kei Racer', { timeout: SLOW }, () => {
    const tw = lapOf('Track Weapon');
    const muscle = lapOf('Muscle');
    const hatch = lapOf('Club Hatch');
    const kei = lapOf('Kei Racer');
    for (const r of [tw, muscle, hatch, kei]) {
      expect(r.nan).toBe(false);
      expect(r.lapTimes.length).toBe(2);
    }
    console.log(`clubsprint lap 2: Track Weapon ${lap2(tw).toFixed(1)} s, Muscle ${lap2(muscle).toFixed(1)} s, Club Hatch ${lap2(hatch).toFixed(1)} s, Kei Racer ${lap2(kei).toFixed(1)} s`);
    expect(lap2(tw)).toBeLessThan(lap2(muscle));
    expect(lap2(hatch)).toBeLessThan(lap2(kei));
  });

  it('estimateLapTime (ai.ts) is within 25 % of the simulated lap 2 for those four presets', { timeout: SLOW }, () => {
    for (const name of ['Track Weapon', 'Muscle', 'Club Hatch', 'Kei Racer']) {
      const est = estimateLapTime(preset(name), club, gripUsageForSkill(0.8));
      const sim = lap2(lapOf(name));
      const ratio = sim / est;
      console.log(`${name}: estimate ${est.toFixed(1)} s vs simulated ${sim.toFixed(1)} s (×${ratio.toFixed(2)})`);
      expect(ratio, name).toBeGreaterThan(0.75);
      expect(ratio, name).toBeLessThan(1.25);
    }
  });
});

// ---------------------------------------------------------------------------
// b. Setup causality
// ---------------------------------------------------------------------------

describe('b. setup causality: auto-tune shows up in lap times', () => {
  const club = trackOf('clubsprint');

  it("defaultBuild + autoTune('all') laps no slower than 102 % of the untuned default", { timeout: SLOW }, () => {
    const base = defaultBuild();
    const tuned = autoTune(base, 'all').build;
    const [r0] = runRace([compileBuild(base)], club, 2, { maxTime: 400 });
    const [r1] = runRace([compileBuild(tuned)], club, 2, { maxTime: 400 });
    console.log(`default best ${r0.best.toFixed(1)} s, auto-tuned best ${r1.best.toFixed(1)} s`);
    expect(r0.nan || r1.nan).toBe(false);
    expect(r1.best).toBeLessThanOrEqual(1.02 * r0.best);
  });

  it('a deliberately broken build (bias 0.9, 320 kPa, wing 0 / splitter 1, all gears equal) is slower than its auto-tuned version', { timeout: SLOW }, () => {
    const broken = normalizeBuild({ ...defaultBuild('broken'), name: 'Broken' });
    broken.brakes.bias = 0.9;
    broken.tires.front.pressure = 320;
    broken.tires.rear.pressure = 320;
    broken.aero.wing = 0;
    broken.aero.splitter = 1;
    broken.drivetrain.gearRatios = new Array(broken.drivetrain.gears).fill(1.0); // first gear = top gear
    const fixed = autoTune(broken, 'all').build;
    expect(fixed.brakes.bias).toBeLessThan(0.8);
    expect(fixed.tires.front.pressure).toBeLessThan(300);
    const [rb] = runRace([compileBuild(broken)], club, 2, { maxTime: 400 });
    const [rf] = runRace([compileBuild(fixed)], club, 2, { maxTime: 400 });
    console.log(`broken best ${rb.best.toFixed(1)} s, auto-tuned best ${rf.best.toFixed(1)} s`);
    expect(rb.nan || rf.nan).toBe(false);
    expect(rf.best).toBeLessThan(rb.best);
  });
});

// ---------------------------------------------------------------------------
// c. Surface causality
// ---------------------------------------------------------------------------

describe('c. surface causality: rally tyres win on gravel, slicks on tarmac', () => {
  it('Gravel Rally beats Track Weapon on pinecone-stage (both finish)', { timeout: 4 * SLOW }, () => {
    const pine = trackOf('pinecone-stage');
    const [gr] = runRace([preset('Gravel Rally')], pine, 1, { maxTime: 600 });
    // slicks on a gravel stage are the wrong tool: the Track Weapon's slicks run cold on gravel (the
    // loose surface absorbs most of the slip energy) and the AI's live grip scale halves its targets,
    // so it crawls the 6.4 km at 3–4× its own estimate — but it must still get to the finish
    const [tw] = runRace([preset('Track Weapon')], trackOf('pinecone-stage'), 1, { maxTime: 1800 });
    console.log(`pinecone: Gravel Rally ${gr.time.toFixed(1)} s (resets ${gr.resets}), Track Weapon ${tw.time.toFixed(1)} s (resets ${tw.resets})`);
    expect(gr.nan || tw.nan).toBe(false);
    expect(gr.finished).toBe(true);
    expect(tw.finished).toBe(true);
    expect(gr.time).toBeLessThan(tw.time);
  });

  it('Track Weapon beats Gravel Rally on ridgeway', { timeout: SLOW }, () => {
    const [tw] = runRace([preset('Track Weapon')], trackOf('ridgeway'), 1, { maxTime: 400 });
    const [gr] = runRace([preset('Gravel Rally')], trackOf('ridgeway'), 1, { maxTime: 400 });
    console.log(`ridgeway: Track Weapon ${tw.time.toFixed(1)} s, Gravel Rally ${gr.time.toFixed(1)} s`);
    expect(tw.finished && gr.finished).toBe(true);
    expect(tw.time).toBeLessThan(gr.time);
  });
});

// ---------------------------------------------------------------------------
// d. Jumps and rollovers in racing
// ---------------------------------------------------------------------------

describe('d. jumps and rollovers in racing', () => {
  it('Gravel Rally flies the dunes tabletop (s ≈ 204) on every lap of a 2-lap race with at most one reset; the Track Weapon finishes too', { timeout: 2 * SLOW }, () => {
    const [gr] = runRace([preset('Gravel Rally')], trackOf('dunes-rallycross'), 2, { maxTime: 500, airS: [190, 270] });
    console.log(`dunes Gravel Rally laps ${gr.lapTimes.map((x) => x.toFixed(1)).join(' / ')} s, airborne at the tabletop on laps ${[...gr.airLaps].join(',')}, resets ${gr.resets}`);
    expect(gr.nan).toBe(false);
    expect(gr.finished).toBe(true);
    expect(gr.resets).toBeLessThanOrEqual(1);
    expect(gr.airLaps.has(0)).toBe(true);
    expect(gr.airLaps.has(1)).toBe(true);
    const [tw] = runRace([preset('Track Weapon')], trackOf('dunes-rallycross'), 2, { maxTime: 600, airS: [190, 270] });
    console.log(`dunes Track Weapon laps ${tw.lapTimes.map((x) => x.toFixed(1)).join(' / ')} s, resets ${tw.resets}`);
    expect(tw.nan).toBe(false);
    expect(tw.finished).toBe(true);
  });

  it('a tall/narrow/soft/grippy car driven by the AI on clubsprint completes the race without NaN (rolls and is reset, or the rollover cap keeps it upright)', { timeout: SLOW }, () => {
    const build = tallRollerBuild();
    const spec = compileBuild(build);
    const an = analyzeBuild(build, spec);
    expect(an.warnings.some((w) => /roll before it slides/i.test(w.message))).toBe(true);
    let maxRoll = 0;
    const [r] = runRace([spec], trackOf('clubsprint'), 2, {
      maxTime: 400,
      onStep: (race) => {
        const roll = Math.abs(race.cars[0].state.roll);
        if (roll > maxRoll) maxRoll = roll;
      },
    });
    const outcome = r.wrecks > 0 ? `rolled ${r.wrecks}× and was reset (${r.resets} resets)` : `stayed upright (max roll ${((maxRoll * 180) / Math.PI).toFixed(1)}°) — the AI's rollover cap held`;
    console.log(`tall roller on clubsprint: ${outcome}; laps ${r.lapTimes.map((x) => x.toFixed(1)).join(' / ')} s`);
    expect(r.nan).toBe(false);
    expect(r.finished).toBe(true);
    if (r.wrecks > 0) expect(r.resets).toBeGreaterThanOrEqual(r.wrecks);
  });
});

// ---------------------------------------------------------------------------
// e. Brake fade in racing
// ---------------------------------------------------------------------------

describe('e. brake fade shows up in racing (clubsprint, 3 laps, heavy large-chassis build)', () => {
  it('minimum street discs, street pads, no ducts: the front discs pass fadeStartTemp; race pads + max discs + max ducts stay below it', { timeout: 2 * SLOW }, () => {
    const bad = compileBuild(heavyBrakeBuild(false));
    const good = compileBuild(heavyBrakeBuild(true));
    expect(bad.mass).toBeGreaterThan(1800);
    const [rb] = runRace([bad], trackOf('clubsprint'), 3, { maxTime: 500, fadeStart: bad.brakes.front.fadeStartTemp });
    const [rg] = runRace([good], trackOf('clubsprint'), 3, { maxTime: 500, fadeStart: good.brakes.front.fadeStartTemp });
    console.log(`street brakes: max front disc ${rb.maxFrontBrake.toFixed(0)} °C (fade from ${bad.brakes.front.fadeStartTemp}), ${(100 * rb.fadeFraction).toFixed(0)} % of the race faded; race brakes: max ${rg.maxFrontBrake.toFixed(0)} °C (fade from ${good.brakes.front.fadeStartTemp}), ${(100 * rg.fadeFraction).toFixed(0)} % faded`);
    expect(rb.nan || rg.nan).toBe(false);
    expect(rb.lapTimes.length).toBe(3);
    expect(rg.lapTimes.length).toBe(3);
    expect(rb.maxFrontBrake).toBeGreaterThan(bad.brakes.front.fadeStartTemp);
    expect(rg.maxFrontBrake).toBeLessThan(good.brakes.front.fadeStartTemp);
    expect(rg.fadeFraction).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// f. Analysis vs simulation
// ---------------------------------------------------------------------------

describe('f. design/analyze agrees with the simulation', () => {
  const cars: Array<[string, CarBuild]> = [
    ['Roadster S', defaultBuild()],
    ['Track Weapon', presetBuild('Track Weapon')],
    ['Club Hatch', presetBuild('Club Hatch')],
  ];

  it('skidpadG within 0.3 g of a simulated steady-state steer sweep', () => {
    for (const [name, b] of cars) {
      const spec = compileBuild(b);
      const an = analyzeBuild(b, spec).metrics.skidpadG;
      const sim = simSkidpadG(spec);
      console.log(`${name}: skidpad analysis ${an.toFixed(2)} g vs simulated ${sim.toFixed(2)} g`);
      expect(Math.abs(an - sim), name).toBeLessThan(0.3);
    }
  });

  it('accel0to100s within 25 % of a simulated launch', () => {
    for (const [name, b] of cars) {
      const spec = compileBuild(b);
      const an = analyzeBuild(b, spec).metrics.accel0to100s;
      const sim = simAccel0to100(spec);
      console.log(`${name}: 0–100 analysis ${an.toFixed(1)} s vs simulated ${sim.toFixed(1)} s`);
      expect(Number.isFinite(sim), name).toBe(true);
      expect(Math.abs(an - sim) / sim, name).toBeLessThan(0.25);
    }
  });

  it('brakingDistance100m within 30 % of a simulated full-pedal stop (ABS or locked wheels)', () => {
    for (const [name, b] of cars) {
      const spec = compileBuild(b);
      const an = analyzeBuild(b, spec).metrics.brakingDistance100m;
      const sim = simBrakingDistance(spec);
      console.log(`${name}: 100–0 analysis ${an.toFixed(1)} m vs simulated ${sim.toFixed(1)} m (${spec.brakes.abs ? 'ABS' : 'no ABS'})`);
      expect(Math.abs(an - sim) / sim, name).toBeLessThan(0.3);
    }
  });

  it('rolloverG is consistent with the step-steer: the tall car lifts its inner wheels around its rollover threshold, the default car never does', () => {
    const tallB = tallRollerBuild();
    const tall = compileBuild(tallB);
    const anTall = analyzeBuild(tallB, tall).metrics;
    const anDefault = analyzeBuild(defaultBuild(), DEFAULT).metrics;
    const probeTall = simFishhook(tall, 25);
    const probeDefault = simFishhook(DEFAULT, 25);
    console.log(`tall roller: analysis rollover ${anTall.rolloverG!.toFixed(2)} g (skidpad ${anTall.skidpadG.toFixed(2)} g); fishhook reached ${probeTall.maxG.toFixed(2)} g, wheels off the ground for ${probeTall.liftTime.toFixed(2)} s, tipped ${probeTall.tipped}`);
    console.log(`default: analysis rollover ${anDefault.rolloverG!.toFixed(2)} g (skidpad ${anDefault.skidpadG.toFixed(2)} g); fishhook reached ${probeDefault.maxG.toFixed(2)} g, lift ${probeDefault.liftTime.toFixed(2)} s`);
    // analysis: the tall car is flagged, the default is not
    expect(anTall.skidpadG).toBeGreaterThan(0.9 * anTall.rolloverG!);
    expect(anDefault.rolloverG!).toBeGreaterThan(anDefault.skidpadG / 0.9);
    // simulation: the tall car lifts wheels (or tips) at a lateral g close to the analysed threshold
    // (the analysis is quasi-static; the fishhook's transient peak with the inner wheels in the air
    // may overshoot it by a few tenths of a g before the car settles or tips) …
    expect(probeTall.liftTime > 0.2 || probeTall.tipped).toBe(true);
    expect(probeTall.maxG).toBeGreaterThan(0.7 * anTall.rolloverG!);
    expect(probeTall.maxG).toBeLessThan(1.5 * anTall.rolloverG!);
    // … while the default car, well below its threshold, keeps all four wheels down
    expect(probeDefault.tipped).toBe(false);
    expect(probeDefault.liftTime).toBe(0);
    expect(probeDefault.maxG).toBeLessThan(anDefault.rolloverG!);
  });

  it('brakeLinePressures: the design-side and sim-side copies are identical over a bias / torque grid', () => {
    for (let bias = 0.5; bias <= 0.9001; bias += 0.025) {
      for (const mF of [1500, 2688, 3800, 5000]) {
        for (const mR of [1200, 2520, 3600, 5000]) {
          const a = analyzeLinePressures(bias, mF, mR);
          const v = vehicleLinePressures(bias, mF, mR);
          expect(a.front).toBeCloseTo(v.front, 12);
          expect(a.rear).toBeCloseTo(v.rear, 12);
          // and the rule itself: the front share of the total torque is the bias, the stronger side sees full pressure
          const share = (mF * a.front) / (mF * a.front + mR * a.rear);
          expect(share).toBeCloseTo(bias, 9);
          expect(Math.max(a.front, a.rear)).toBe(1);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// g. Determinism
// ---------------------------------------------------------------------------

describe('g. determinism', () => {
  it('a full 3-car race run twice with the same seed gives identical finishing times', { timeout: SLOW }, () => {
    const specs = (): VehicleSpec[] => [compileBuild(defaultBuild()), preset('Club Hatch'), preset('Muscle')];
    const a = runRace(specs(), trackOf('clubsprint'), 1, { seed: 42, maxTime: 300 });
    const b = runRace(specs(), trackOf('clubsprint'), 1, { seed: 42, maxTime: 300 });
    expect(a.every((r) => r.finished)).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(a[i].time).toBe(b[i].time);
      expect(a[i].lapTimes).toEqual(b[i].lapTimes);
      expect(a[i].maxTireTemp).toBe(b[i].maxTireTemp);
    }
  });
});

// ---------------------------------------------------------------------------
// h. Wear / thermal magnitudes
// ---------------------------------------------------------------------------

describe('h. wear and thermal magnitudes after a 5-lap clubsprint race', () => {
  const withCompound = (compound: CarBuild['tires']['front']['compound']): VehicleSpec => {
    const b = normalizeBuild({ ...defaultBuild(`wear_${compound}`), name: `Roadster on ${compound}` });
    b.tires.front.compound = compound;
    b.tires.rear.compound = compound;
    return compileBuild(b);
  };

  it('slick_soft: wear in (0.02, 0.9), temperatures between ambient and 200 °C; street tyres wear < 0.15', { timeout: 2 * SLOW }, () => {
    const club = trackOf('clubsprint');
    const [soft] = runRace([withCompound('slick_soft')], club, 5, { maxTime: 700 });
    const [street] = runRace([withCompound('street')], trackOf('clubsprint'), 5, { maxTime: 700 });
    console.log(`slick_soft: wear ${soft.maxWear.toFixed(3)}, temps ${soft.minTireTemp.toFixed(0)}–${soft.maxTireTemp.toFixed(0)} °C, laps ${soft.lapTimes.map((x) => x.toFixed(1)).join(' / ')}; street: wear ${street.maxWear.toFixed(3)}, temps ${street.minTireTemp.toFixed(0)}–${street.maxTireTemp.toFixed(0)} °C`);
    expect(soft.nan || street.nan).toBe(false);
    expect(soft.lapTimes.length).toBe(5);
    expect(street.lapTimes.length).toBe(5);
    expect(soft.maxWear).toBeGreaterThan(0.02);
    expect(soft.maxWear).toBeLessThan(0.9);
    expect(soft.minTireTemp).toBeGreaterThanOrEqual(club.ambientTemp - 5);
    expect(soft.maxTireTemp).toBeLessThan(200);
    expect(street.maxWear).toBeLessThan(0.15);
    expect(street.maxTireTemp).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// i. Performance
// ---------------------------------------------------------------------------

describe('i. performance', () => {
  it('an 8-car AI race on ridgeway simulates at ≥ 5× realtime', { timeout: 3 * SLOW }, () => {
    const specs = [compileBuild(defaultBuild()), ...PRESETS.map(compileBuild)];
    expect(specs.length).toBe(8);
    const rs = runRace(specs, trackOf('ridgeway'), 1, { maxTime: 120 });
    const factor = rs[0].simTime / rs[0].wall;
    console.log(`8 cars on ridgeway: ${rs[0].simTime.toFixed(0)} s simulated in ${rs[0].wall.toFixed(1)} s → ${factor.toFixed(1)}× realtime`);
    expect(rs.every((r) => !r.nan)).toBe(true);
    expect(factor).toBeGreaterThan(5);
  });
});

// ---------------------------------------------------------------------------
// Hill start (vehicle.ts deadlock regression)
// ---------------------------------------------------------------------------

describe('hill start on grass at +8 % (vehicle.ts torque-balance regression)', () => {
  const road = flatRoad({ surface: 'grass', grade: 0.08 });
  const hillStart = (spec: VehicleSpec, warm: boolean): { x: number; minX: number; rearOmega: number } => {
    const st = createVehicleState(spec, { x: 0, y: 0, heading: 0 }, road);
    if (warm) for (let i = 0; i < 4; i++) st.wheels[i].tire.temp = (i < 2 ? spec.tires.front : spec.tires.rear).optimalTemp - 15;
    let minX = 0;
    for (let i = 0; i < 6 * 120; i++) {
      stepVehicle(spec, st, { ...NEUTRAL_INPUT, throttle: 1 }, road, SIM_DT);
      if (st.x < minX) minX = st.x;
      expect(Number.isFinite(st.x + st.vx + st.wheels[2].omega)).toBe(true);
    }
    return { x: st.x, minX, rearOmega: Math.max(st.wheels[2].omega, st.wheels[3].omega) };
  };

  it('Drift Missile (locked rear diff, the original repro) at ambient: moves off > 5 m in 6 s instead of creeping back', () => {
    const r = hillStart(preset('Drift Missile'), false);
    expect(r.x).toBeGreaterThan(5);
    expect(r.minX).toBeGreaterThan(-0.05);
  });

  it('every preset and the default with tyres at working temperature moves forward (> 5 m; the slick-shod Track Weapon > 2 m — slicks keep only 55 % of their grip on grass, barely above grade + rolling resistance)', () => {
    for (const spec of [DEFAULT, ...PRESETS.map(compileBuild)]) {
      const r = hillStart(spec, true);
      const slicks = spec.tires.rear.surfaceAffinity.grass !== undefined && spec.tires.rear.surfaceAffinity.grass < 0.6;
      expect(r.x, spec.name).toBeGreaterThan(slicks ? 2 : 5);
      expect(r.minX, spec.name).toBeGreaterThan(-0.05);
    }
  });
});
