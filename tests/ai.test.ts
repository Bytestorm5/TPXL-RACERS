/**
 * AI driver tests — racing line, speed profile and full single-car laps on the built-in tracks
 * with the real 6-DOF vehicle model. The lap tests are the executable spec of the driver:
 * they drive one car with a small loop (createVehicleState at gridSlot(0), drive + stepVehicle
 * at SIM_DT) and detect laps from track.project(...).s wrapping past the start line.
 */
import { describe, expect, it } from 'vitest';
import { compileBuild } from '../src/design/compile';
import { defaultBuild, presetBuilds } from '../src/design/parts';
import {
  AI_V_MAX,
  AI_V_MIN,
  computeRacingLine,
  computeSpeedProfile,
  computeSpeedProfileParts,
  createAiDriver,
  estimateLapTime,
  lineMargin,
  racingLineFor,
} from '../src/sim/ai';
import type { AiDriver } from '../src/sim/ai';
import { compileTrack } from '../src/sim/track';
import type { CompiledTrack } from '../src/sim/track';
import type { TrackSpec } from '../src/sim/trackTypes';
import { G } from '../src/sim/types';
import type { DriverInput, VehicleSpec, VehicleState } from '../src/sim/types';
import { NEUTRAL_INPUT, SIM_DT, createVehicleState, resetVehicleState, stepVehicle } from '../src/sim/vehicle';
import { BUILTIN_TRACKS } from '../src/tracks/index';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TRACKS = new Map<string, CompiledTrack>();
function trackOf(id: string): CompiledTrack {
  let t = TRACKS.get(id);
  if (!t) {
    const spec = BUILTIN_TRACKS.find((x) => x.id === id);
    if (!spec) throw new Error(`no built-in track '${id}'`);
    t = compileTrack(spec);
    TRACKS.set(id, t);
  }
  return t;
}

const PRESETS = presetBuilds().map(compileBuild);
const preset = (name: string): VehicleSpec => {
  const p = PRESETS.find((x) => x.name === name);
  if (!p) throw new Error(`no preset '${name}'`);
  return p;
};
const DEFAULT = compileBuild(defaultBuild());

const segmentStart = (track: CompiledTrack, name: string): number => {
  let s = 0;
  for (const seg of track.spec.segments) {
    if (seg.name === name) return s;
    s += seg.length;
  }
  throw new Error(`segment '${name}' missing`);
};

const sampleIndexAt = (track: CompiledTrack, s: number): number => {
  const n = track.samples.length;
  const step = track.spec.closed ? track.length / n : track.samples[1].s - track.samples[0].s;
  const i = Math.round(s / step);
  return track.spec.closed ? ((i % n) + n) % n : Math.min(Math.max(i, 0), n - 1);
};

const finiteState = (st: VehicleState): boolean =>
  Number.isFinite(st.x + st.y + st.z + st.vx + st.vy + st.heading + st.yawRate + st.roll + st.pitch);

interface LapRun {
  lapTimes: number[];
  finished: boolean;
  time: number;
  wrecks: number;
  stuckResets: number;
  maxOffTrack: number;
  nan: boolean;
  airTime: number;
  maxGear: number;
  maxSpeed: number;
  passedS: (s: number) => boolean;
}

/**
 * Drive one car alone for `laps` laps (circuits) or to the finish (stages). Wrecked cars are
 * re-posed on the centreline (counted); cars the driver reports as hopelessly stuck for > 10 s are
 * re-posed too (counted separately) — that is what race.ts does for wrecks.
 */
function runLaps(spec: VehicleSpec, trackId: string, laps: number, skill: number, maxTime: number, seed = 7): LapRun {
  const track = trackOf(trackId);
  const driver = createAiDriver(spec, track, { skill, aggression: 0.5, seed });
  const slot = track.gridSlot(0);
  const state = createVehicleState(spec, { x: slot.x, y: slot.y, heading: slot.heading }, track);
  let prevS = track.project(state.x, state.y).s;
  const L = track.length;
  const sl = track.startLine;
  let crossings = 0;
  let lastCross = 0;
  const lapTimes: number[] = [];
  let t = 0;
  let offT = 0;
  const run: LapRun = {
    lapTimes,
    finished: false,
    time: 0,
    wrecks: 0,
    stuckResets: 0,
    maxOffTrack: 0,
    nan: false,
    airTime: 0,
    maxGear: 0,
    maxSpeed: 0,
    passedS: () => false,
  };
  const passed = new Set<number>();
  while (t < maxTime) {
    const input = driver.drive(state, [], SIM_DT);
    stepVehicle(spec, state, input, track, SIM_DT);
    t += SIM_DT;
    if (!finiteState(state)) {
      run.nan = true;
      break;
    }
    const p = track.project(state.x, state.y, prevS);
    const s = p.s;
    if (track.spec.closed) {
      const crossed = (prevS < sl && s >= sl) || (prevS - s > L / 2 && (sl >= prevS || sl <= s));
      if (crossed) {
        crossings++;
        if (crossings > 1) lapTimes.push(t - lastCross);
        lastCross = t;
        if (crossings > laps) {
          run.finished = true;
          break;
        }
      }
    } else if (s >= L - 1) {
      lapTimes.push(t);
      run.finished = true;
      break;
    }
    // remember which 10 m bins the car has been through (for feature checks)
    passed.add(Math.floor(s / 10));
    prevS = s;
    if (state.offTrack) {
      offT += SIM_DT;
      if (offT > run.maxOffTrack) run.maxOffTrack = offT;
    } else offT = 0;
    if (state.airborne) run.airTime += SIM_DT;
    if (state.gear > run.maxGear) run.maxGear = state.gear;
    if (state.speed > run.maxSpeed) run.maxSpeed = state.speed;
    if (state.wrecked || (driver.stuckFor ?? 0) > 10) {
      if (state.wrecked) run.wrecks++;
      else run.stuckResets++;
      const pose = track.poseAt(s, 0);
      resetVehicleState(spec, state, { x: pose.x, y: pose.y, heading: pose.heading }, track);
      driver.reset?.();
      offT = 0;
    }
  }
  run.time = t;
  run.passedS = (sq: number) => passed.has(Math.floor(sq / 10));
  return run;
}

// ---------------------------------------------------------------------------
// Racing line
// ---------------------------------------------------------------------------

describe('racing line', () => {
  it('stays inside the track width minus the car margin on every built-in track', () => {
    for (const spec of BUILTIN_TRACKS) {
      const track = trackOf(spec.id);
      const margin = lineMargin(DEFAULT);
      const line = computeRacingLine(track, margin);
      expect(line.offset.length).toBe(track.samples.length);
      for (let i = 0; i < track.samples.length; i++) {
        const bound = Math.max(0, track.samples[i].width / 2 - margin);
        expect(Math.abs(line.offset[i]), `${spec.id} s=${track.samples[i].s}`).toBeLessThanOrEqual(bound + 1e-3);
        expect(Number.isFinite(line.curvature[i]) && Number.isFinite(line.heading[i]) && line.ds[i] > 0).toBe(true);
      }
    }
  });

  it('uses the width: the line has less total curvature than the centreline and reaches the edges in corners', () => {
    const track = trackOf('clubsprint');
    const line = computeRacingLine(track, lineMargin(DEFAULT));
    let kc = 0;
    let kl = 0;
    let maxOff = 0;
    for (let i = 0; i < track.samples.length; i++) {
      kc += track.samples[i].curvature ** 2;
      kl += line.curvature[i] ** 2;
      maxOff = Math.max(maxOff, Math.abs(line.offset[i]));
    }
    expect(kl).toBeLessThan(0.9 * kc);
    expect(maxOff).toBeGreaterThan(2.5); // 10 m wide track, margin 1.425 → up to 3.575 m available
  });

  it('keeps offset 0 at both ends of a stage and is cached per track/margin', () => {
    const track = trackOf('pinecone-stage');
    const line = computeRacingLine(track, lineMargin(DEFAULT));
    expect(line.offset[0]).toBe(0);
    expect(line.offset[line.offset.length - 1]).toBe(0);
    expect(racingLineFor(track, lineMargin(DEFAULT))).toBe(racingLineFor(track, lineMargin(DEFAULT)));
  });
});

// ---------------------------------------------------------------------------
// Speed profile
// ---------------------------------------------------------------------------

describe('speed profile', () => {
  it('is finite and bounded (5..120 m/s) for every built-in track and every curated car', () => {
    for (const trackSpec of BUILTIN_TRACKS) {
      const track = trackOf(trackSpec.id);
      for (const car of [DEFAULT, ...PRESETS]) {
        const profile = computeSpeedProfile(car, track, 0.9);
        expect(profile.length).toBe(track.samples.length);
        for (let i = 0; i < profile.length; i++) {
          const v = profile[i];
          expect(Number.isFinite(v), `${trackSpec.id}/${car.name} @${i}`).toBe(true);
          expect(v).toBeGreaterThanOrEqual(AI_V_MIN - 1e-6);
          expect(v).toBeLessThanOrEqual(AI_V_MAX + 1e-6);
        }
      }
    }
  }, 60_000);

  it('orders the cars on ridgeway: Track Weapon < Muscle < Kei Racer, and more grip usage is faster', () => {
    const track = trackOf('ridgeway');
    const tw = estimateLapTime(preset('Track Weapon'), track, 0.9);
    const muscle = estimateLapTime(preset('Muscle'), track, 0.9);
    const kei = estimateLapTime(preset('Kei Racer'), track, 0.9);
    expect(tw).toBeLessThan(muscle);
    expect(muscle).toBeLessThan(kei);
    // plausible GP-circuit lap times for road cars
    expect(tw).toBeGreaterThan(90);
    expect(kei).toBeLessThan(260);
    for (const car of [DEFAULT, preset('Track Weapon'), preset('Gravel Rally')]) {
      const slow = estimateLapTime(car, track, 0.8);
      const fast = estimateLapTime(car, track, 0.97);
      expect(fast).toBeLessThan(slow);
    }
  });

  it('brakes to a speed the landing can take BEFORE the jump lips and holds it over the lip', () => {
    // dunes tabletop (lip at the start of 'Tabletop Drop'), pinecone kicker, ridgeway crest
    const cases: Array<[string, string, number]> = [
      ['dunes-rallycross', 'Tabletop Drop', 122 / 3.6],
      ['pinecone-stage', 'Kicker Jump', 128 / 3.6],
      ['ridgeway', 'Crest', 46],
    ];
    for (const [id, lipSegment, maxLipSpeed] of cases) {
      const track = trackOf(id);
      const sLip = segmentStart(track, lipSegment);
      const profile = computeSpeedProfile(preset('Track Weapon'), track, 0.97);
      const atLip = profile[sampleIndexAt(track, sLip)];
      expect(atLip, `${id} lip speed`).toBeLessThanOrEqual(maxLipSpeed);
      // no braking on the last 20 m before the lip: the target is reached before the ramp (the
      // profile may still be rising out of the previous corner, e.g. ridgeway's Climb 3, or sag a
      // little where the car cannot hold speed up the ramp — braking would be ≥ 0.25 m/s per metre)
      for (let s = sLip - 20; s < sLip; s += 1) {
        const a = profile[sampleIndexAt(track, s)];
        const b = profile[sampleIndexAt(track, s + 1)];
        expect(b, `${id} approach s=${s}`).toBeGreaterThanOrEqual(a - 0.1);
      }
      // and over the lip itself the profile does not drop either (steady throttle in the air)
      const lipV = profile[sampleIndexAt(track, sLip)];
      for (let s = sLip; s < sLip + 15; s += 1) expect(profile[sampleIndexAt(track, s)]).toBeGreaterThanOrEqual(lipV - 0.1 * (s - sLip) - 0.05);
    }
  });

  it('folds the bank in with the right sign: helping bank raises the cornering speed, off-camber lowers it', () => {
    const make = (bankDeg: number): CompiledTrack =>
      compileTrack({
        format: 1,
        id: `bank${bankDeg}`,
        name: 'bank',
        closed: false,
        defaultWidth: 10,
        defaultSurface: 'dirt',
        defaultShoulder: 'grass',
        segments: [
          { length: 200 },
          { length: 78.54, radius: 50, turn: 'left', bank: bankDeg },
          { length: 200 },
        ],
      } as TrackSpec);
    const spec = preset('Gravel Rally');
    const mid = 200 + 39;
    const speedAt = (bank: number): number => {
      const track = make(bank);
      return computeSpeedProfile(spec, track, 0.9)[sampleIndexAt(track, mid)];
    };
    const flat = speedAt(0);
    const helping = speedAt(6); // right edge higher helps a LEFT turn
    const offCamber = speedAt(-6);
    expect(helping).toBeGreaterThan(flat * 1.03);
    expect(offCamber).toBeLessThan(flat * 0.97);
    // and the same reading on the real tracks: dunes Turn 2 (left, bank −6) is slower than its
    // mirror-banked twin would be — checked through the synthetic pair above; here just sanity
    const dunes = trackOf('dunes-rallycross');
    const s0 = segmentStart(dunes, 'Turn 2 Off-Camber');
    const v = computeSpeedProfile(spec, dunes, 0.9)[sampleIndexAt(dunes, s0 + 20)];
    expect(v * v / 50).toBeLessThan(0.65 * G); // well under the flat-dirt limit of the rally car
  });

  it('caps the lateral limit at the rollover threshold for a tall car on very grippy tyres', () => {
    const base = preset('Gravel Rally');
    const sticky = (t: VehicleSpec['tires']['front']): VehicleSpec['tires']['front'] => ({
      ...t,
      peakMu: 1.8,
      loadSensitivity: 0,
      underloadPenalty: 0,
      camberGain: 0,
      surfaceAffinity: {},
    });
    const spec: VehicleSpec = { ...base, tires: { front: sticky(base.tires.front), rear: sticky(base.tires.rear) } };
    const R = 40;
    const track = compileTrack({
      format: 1,
      id: 'circle',
      name: 'circle',
      closed: true,
      defaultWidth: 4,
      defaultSurface: 'asphalt',
      defaultShoulder: 'asphalt',
      segments: [{ length: 2 * Math.PI * R, radius: R, turn: 'left' }],
    } as TrackSpec);
    const line = racingLineFor(track, lineMargin(spec));
    const parts = computeSpeedProfileParts(spec, track, line, 1.0);
    const i = Math.floor(track.samples.length / 2);
    const v = parts.lateral[i];
    const ay = (v * v * Math.abs(line.curvature[i])) / G;
    const rollLimit = (0.85 * (Math.min(spec.trackFront, spec.trackRear) / 2)) / spec.cgHeight;
    expect(ay).toBeLessThanOrEqual(rollLimit * 1.03);
    expect(ay).toBeGreaterThan(rollLimit * 0.9); // the cap is what limits it, not the tyres
  });

  it('computes line + profile for the 6.4 km stage and the 4.8 km circuit well within the budget', () => {
    const budgetMs = 250;
    for (const id of ['pinecone-stage', 'ridgeway']) {
      const spec = BUILTIN_TRACKS.find((x) => x.id === id)!;
      let best = Infinity;
      for (let k = 0; k < 2; k++) {
        const fresh = compileTrack(spec); // uncached line
        const t0 = performance.now();
        computeSpeedProfile(DEFAULT, fresh, 0.9);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best, id).toBeLessThan(budgetMs);
    }
  });
});

// ---------------------------------------------------------------------------
// Driver unit behaviour
// ---------------------------------------------------------------------------

describe('driver controller', () => {
  const track = trackOf('clubsprint');

  const rolling = (spec: VehicleSpec, s: number, lateral: number, speed: number): VehicleState => {
    const pose = track.poseAt(s, lateral);
    const st = createVehicleState(spec, { x: pose.x, y: pose.y, heading: pose.heading }, track);
    st.vx = speed;
    st.speed = speed;
    for (const w of st.wheels) w.omega = speed / spec.tires.front.radius;
    return st;
  };

  it('outputs NEUTRAL_INPUT while the car is wrecked and reports the mode', () => {
    const driver = createAiDriver(DEFAULT, track, { skill: 0.8, aggression: 0.5, seed: 1 });
    const st = rolling(DEFAULT, 100, 0, 20);
    st.wrecked = true;
    const out = driver.drive(st, [], SIM_DT);
    expect(out).toEqual(NEUTRAL_INPUT);
    expect(driver.mode).toBe('wrecked');
  });

  it('is deterministic for a seed and varies grip usage / lookahead between seeds', () => {
    const a = createAiDriver(DEFAULT, track, { skill: 0.8, aggression: 0.5, seed: 42 });
    const b = createAiDriver(DEFAULT, track, { skill: 0.8, aggression: 0.5, seed: 42 });
    const c = createAiDriver(DEFAULT, track, { skill: 0.8, aggression: 0.5, seed: 43 });
    expect(a.gripUsage).toBe(b.gripUsage);
    expect(a.gripUsage).not.toBe(c.gripUsage);
    expect(Math.abs((a.gripUsage ?? 0) - (0.8 + 0.17 * 0.8))).toBeLessThan(0.03 * 0.95 + 1e-9);
    const sa = rolling(DEFAULT, 100, 0.5, 20);
    const sb = rolling(DEFAULT, 100, 0.5, 20);
    const outs: Array<[DriverInput, DriverInput]> = [];
    for (let i = 0; i < 120; i++) {
      const ia = a.drive(sa, [], SIM_DT);
      const ib = b.drive(sb, [], SIM_DT);
      outs.push([ia, ib]);
      stepVehicle(DEFAULT, sa, ia, track, SIM_DT);
      stepVehicle(DEFAULT, sb, ib, track, SIM_DT);
    }
    for (const [ia, ib] of outs) expect(ia).toEqual(ib);
    expect(sa.x).toBe(sb.x);
  });

  it('accelerates on the straight, steers toward the line and never applies throttle and brake together', () => {
    const driver = createAiDriver(DEFAULT, track, { skill: 0.8, aggression: 0.5, seed: 3 });
    const st = rolling(DEFAULT, 60, 2.5, 15); // 2.5 m left of the centre on the start straight
    const first = driver.drive(st, [], SIM_DT);
    expect(first.throttle).toBeGreaterThan(0.5);
    expect(first.brake).toBe(0);
    for (let i = 0; i < 240; i++) {
      const inp = driver.drive(st, [], SIM_DT);
      expect(inp.throttle > 0 && inp.brake > 0).toBe(false);
      stepVehicle(DEFAULT, st, inp, track, SIM_DT);
    }
    // two seconds later the car is faster and closer to the line
    expect(st.speed).toBeGreaterThan(18);
    const line = driver.line!;
    const p = track.project(st.x, st.y);
    const target = line.offset[sampleIndexAt(track, p.s)];
    expect(Math.abs(p.lateral - target)).toBeLessThan(2.5);
  });

  it('caps the throttle when closing fast on a car just ahead and offsets its line to pass', () => {
    const driver = createAiDriver(DEFAULT, track, { skill: 0.8, aggression: 0.8, seed: 5 });
    const me = rolling(DEFAULT, 80, 0, 25);
    const other = rolling(DEFAULT, 86, 0, 6); // 6 m ahead (bumper gap ~1.4 m), much slower
    const alone = driver.drive(me, [], SIM_DT);
    const blocked = driver.drive(me, [other], SIM_DT);
    expect(blocked.throttle).toBeLessThan(Math.min(alone.throttle, 0.2) + 1e-9);
    // after a moment the avoidance offset has built up: the steering differs from driving alone
    const solo = createAiDriver(DEFAULT, track, { skill: 0.8, aggression: 0.8, seed: 5 });
    const meSolo = rolling(DEFAULT, 80, 0, 25);
    let steerBlocked = 0;
    let steerSolo = 0;
    for (let i = 0; i < 60; i++) {
      steerBlocked = driver.drive(me, [other], SIM_DT).steer;
      steerSolo = solo.drive(meSolo, [], SIM_DT).steer;
    }
    expect(Math.abs(steerBlocked - steerSolo)).toBeGreaterThan(0.02);
  });

  it('holds the steering and keeps the throttle steady while airborne, and corrects the pitch', () => {
    const driver = createAiDriver(DEFAULT, track, { skill: 0.8, aggression: 0.5, seed: 9 });
    const st = rolling(DEFAULT, 100, 0, 25);
    driver.drive(st, [], SIM_DT);
    st.airborne = true;
    st.pitch = 0;
    const level = driver.drive(st, [], SIM_DT);
    expect(level.steer).toBe(0);
    expect(level.brake).toBe(0);
    expect(level.throttle).toBeGreaterThan(0.25);
    st.pitch = -0.3; // nose up → tap the brake
    const noseUp = driver.drive(st, [], SIM_DT);
    expect(noseUp.brake).toBeGreaterThan(0);
    expect(noseUp.throttle).toBe(0);
    st.pitch = 0.3; // nose down → throttle
    const noseDown = driver.drive(st, [], SIM_DT);
    expect(noseDown.throttle).toBe(1);
    expect(driver.mode).toBe('airborne');
  });

  it('turns around when facing the wrong way (recovery with reverse gear)', () => {
    const stage = trackOf('pinecone-stage');
    const driver = createAiDriver(preset('Gravel Rally'), stage, { skill: 0.8, aggression: 0.5, seed: 11 });
    const spec = preset('Gravel Rally');
    const pose = stage.poseAt(150, 0);
    const st = createVehicleState(spec, { x: pose.x, y: pose.y, heading: pose.heading + Math.PI }, stage);
    let sawReverse = false;
    let t = 0;
    while (t < 25) {
      const inp = driver.drive(st, [], SIM_DT);
      stepVehicle(spec, st, inp, stage, SIM_DT);
      t += SIM_DT;
      if (st.gear === -1) sawReverse = true;
      if (driver.mode === 'normal' && st.speed > 3) break;
    }
    expect(driver.mode).toBe('normal');
    const err = Math.abs(((stage.centreAt(stage.project(st.x, st.y).s).heading - st.heading + Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(err).toBeLessThan(0.6);
    expect(sawReverse || t < 25).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full laps with the vehicle model
// ---------------------------------------------------------------------------

describe('laps with the 6-DOF vehicle model', () => {
  it('default build (skill 0.8) completes 2 laps of clubsprint in plausible times without leaving the track', () => {
    const run = runLaps(DEFAULT, 'clubsprint', 2, 0.8, 400);
    expect(run.nan).toBe(false);
    expect(run.finished).toBe(true);
    expect(run.wrecks).toBe(0);
    expect(run.lapTimes.length).toBe(2);
    for (const lap of run.lapTimes) {
      expect(lap).toBeGreaterThan(50);
      expect(lap).toBeLessThan(140);
    }
    expect(run.maxOffTrack).toBeLessThan(4);
  }, 120_000);

  it('default build completes a lap of ridgeway (90–260 s), never off-track for 4 s, no NaN', () => {
    const run = runLaps(DEFAULT, 'ridgeway', 1, 0.8, 400);
    expect(run.nan).toBe(false);
    expect(run.finished).toBe(true);
    expect(run.wrecks).toBe(0);
    expect(run.lapTimes[0]).toBeGreaterThan(90);
    expect(run.lapTimes[0]).toBeLessThan(260);
    expect(run.maxOffTrack).toBeLessThan(4);
  }, 120_000);

  it('skill 1.0 laps clubsprint faster than skill 0.4', () => {
    const fast = runLaps(DEFAULT, 'clubsprint', 1, 1.0, 300);
    const slow = runLaps(DEFAULT, 'clubsprint', 1, 0.4, 300);
    expect(fast.finished && slow.finished).toBe(true);
    expect(fast.lapTimes[0]).toBeLessThan(slow.lapTimes[0]);
  }, 120_000);

  it('Gravel Rally reaches the end of pinecone-stage, flying the Kicker, shifting its manual box, without a wreck', () => {
    const spec = preset('Gravel Rally');
    const run = runLaps(spec, 'pinecone-stage', 1, 0.8, 700);
    expect(run.nan).toBe(false);
    expect(run.finished).toBe(true);
    expect(run.wrecks).toBe(0);
    expect(run.lapTimes[0]).toBeLessThan(600);
    expect(run.maxGear).toBeGreaterThanOrEqual(3); // manual gearbox shifts happen
    expect(run.airTime).toBeGreaterThan(0.3); // the Kicker jump
    const track = trackOf('pinecone-stage');
    expect(run.passedS(segmentStart(track, 'Kicker Landing') + 20)).toBe(true);
  }, 180_000);

  it('Ice Runner completes a lap of glacier-loop', () => {
    const run = runLaps(preset('Ice Runner'), 'glacier-loop', 1, 0.8, 500);
    expect(run.nan).toBe(false);
    expect(run.finished).toBe(true);
    expect(run.wrecks).toBe(0);
    expect(run.lapTimes[0]).toBeLessThan(400);
  }, 120_000);

  it('Gravel Rally completes 2 laps of dunes-rallycross (tabletop, off-camber, hairpin) with at most one wreck', () => {
    const run = runLaps(preset('Gravel Rally'), 'dunes-rallycross', 2, 0.8, 600);
    expect(run.nan).toBe(false);
    expect(run.finished).toBe(true);
    expect(run.wrecks).toBeLessThanOrEqual(1);
    expect(run.airTime).toBeGreaterThan(0.5); // it leaves the ground on the tabletop
    for (const lap of run.lapTimes) expect(lap).toBeLessThan(200);
  }, 180_000);

  it('Track Weapon (low, stiff, cold slicks) completes 2 laps of dunes-rallycross without NaN', () => {
    const run = runLaps(preset('Track Weapon'), 'dunes-rallycross', 2, 0.8, 900);
    expect(run.nan).toBe(false);
    expect(run.finished).toBe(true);
    expect(run.lapTimes.length).toBe(2);
  }, 300_000);
});
