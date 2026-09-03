/**
 * Race manager tests (src/sim/race.ts).
 *
 * The AI module is written concurrently, so every driven car here uses `RaceEntry.controller`, a
 * small scripted pure-pursuit driver that follows a lane on the centreline at modest speed with a
 * curvature-based speed target, crude traction control and course-based counter-steering. The
 * scenarios exercise the race manager itself: grid placement, countdown, player input, fixed-step
 * loop, lap / sector timing and its guards, ordering, collisions, resets, stages, determinism and
 * throughput.
 */
import { describe, expect, it } from 'vitest';
import { compileBuild } from '../src/design/compile';
import { defaultBuild, presetBuilds } from '../src/design/parts';
import { clamp, wrapAngle } from '../src/sim/math';
import {
  applyWorldImpulse,
  COLLISION_RADIUS_MARGIN,
  createRace,
  deriveAiSeed,
  OFF_WORLD_DELAY,
  raceSummary,
  WRECK_RESET_DELAY,
} from '../src/sim/race';
import type { CarController, Race, RaceEntry, RaceSnapshot } from '../src/sim/race';
import { compileTrack } from '../src/sim/track';
import type { CompiledTrack } from '../src/sim/track';
import type { DriverInput, VehicleSpec, VehicleState } from '../src/sim/types';
import { NEUTRAL_INPUT, SIM_DT } from '../src/sim/vehicle';
import { BUILTIN_TRACKS } from '../src/tracks/index';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const trackSpec = (id: string) => {
  const t = BUILTIN_TRACKS.find((x) => x.id === id);
  if (!t) throw new Error(`missing built-in track ${id}`);
  return t;
};
/** Fresh compile per race: the compiled track keeps a query cache, so replays share no state. */
const club = (): CompiledTrack => compileTrack(trackSpec('clubsprint'));

const withAuto = (s: VehicleSpec): VehicleSpec => ({ ...s, drivetrain: { ...s.drivetrain, autoShift: true } });
const SPECS: VehicleSpec[] = [compileBuild(defaultBuild('race_default')), ...presetBuilds().map(compileBuild)].map(withAuto);
const spec = (name: string): VehicleSpec => {
  const s = SPECS.find((x) => x.name === name);
  if (!s) throw new Error(`missing preset ${name}`);
  return s;
};

interface PursuitOptions {
  vMax: number;
  ayMax: number;
  aBrake: number;
  lane: number;
}

/**
 * Scripted driver: pure pursuit on the centreline (offset by `lane`), steering on the course so a
 * sliding rear is counter-steered, speed target from the curvature ahead with a braking allowance,
 * a gentle launch and crude traction control for cold tyres.
 */
function pursuit(track: CompiledTrack, sp: VehicleSpec, opts: PursuitOptions): CarController {
  let hint: number | undefined;
  const out: DriverInput = { ...NEUTRAL_INPUT };
  return (st: VehicleState): DriverInput => {
    const proj = track.project(st.x, st.y, hint);
    hint = proj.s;
    const v = st.speed;
    const la = clamp(4 + 0.55 * v, 6, 40);
    const tgt = track.poseAt(proj.s + la, opts.lane);
    const dx = tgt.x - st.x;
    const dy = tgt.y - st.y;
    const dist = Math.max(Math.hypot(dx, dy), 1);
    const slip = v > 1 ? Math.atan2(st.vy, Math.abs(st.vx)) : 0;
    const ang = wrapAngle(Math.atan2(dy, dx) - (st.heading + slip));
    const stg = sp.steering;
    let delta = Math.abs(ang) > Math.PI / 2 ? Math.sign(ang) * stg.maxSteerAngle : Math.atan((sp.wheelbase * 2 * Math.sin(ang)) / dist);
    delta -= 0.06 * st.yawRate;
    const lockFrac = stg.fullLockSpeed > 0 ? 1 + (stg.highSpeedLockFraction - 1) * clamp(v / stg.fullLockSpeed, 0, 1) : 1;
    out.steer = clamp(delta / (stg.maxSteerAngle * lockFrac), -1, 1);
    let vT = opts.vMax;
    if (Math.abs(proj.lateral) > track.centreAt(proj.s).width / 2) vT = Math.min(vT, 8);
    for (let d = 0; d <= 150; d += 5) {
      const c = track.centreAt(proj.s + d);
      const vc = Math.sqrt(opts.ayMax / Math.max(Math.abs(c.curvature), 1e-4));
      const allowed = Math.sqrt(vc * vc + 2 * opts.aBrake * Math.max(d - 5, 0));
      if (allowed < vT) vT = allowed;
    }
    const err = vT - v;
    let thr = clamp(err * 0.4, 0, 1);
    thr = Math.min(thr, 0.35 + 0.65 * clamp(v / 12, 0, 1));
    if (st.wheels.some((w) => w.spinning)) thr *= 0.3;
    if (Math.abs(slip) > 0.15) thr *= 0.3;
    out.throttle = thr;
    out.brake = clamp(-err * 0.35, 0, 1);
    return out;
  };
}

const ROAD: PursuitOptions = { vMax: 40, ayMax: 4.5, aBrake: 4, lane: 0 };

function scriptedEntries(track: CompiledTrack, names: string[], opts: PursuitOptions = ROAD): RaceEntry[] {
  return names.map((n, i) => {
    const sp = spec(n);
    const lane = (i % 2 === 0 ? 1 : -1) * 2;
    return { spec: sp, driver: { kind: 'player' }, name: n, controller: pursuit(track, sp, { ...opts, lane }) };
  });
}

function playerEntry(name: string): RaceEntry {
  return { spec: spec(name), driver: { kind: 'player' }, name };
}

const input = (o: Partial<DriverInput>): DriverInput => ({ ...NEUTRAL_INPUT, ...o });

/** Advance the race by `seconds` in fixed SIM_DT steps. */
function run(race: Race, seconds: number, dt = SIM_DT): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) race.step(dt);
}

/** Recursively assert every number in an object is finite. */
function expectFinite(value: unknown, path: string): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} = ${value}`).toBe(true);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => expectFinite(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) expectFinite(v, `${path}.${k}`);
}

function expectOrderConsistent(race: Race, snap: RaceSnapshot): void {
  const cars = race.cars;
  expect([...snap.order].sort((a, b) => a - b)).toEqual(cars.map((c) => c.index));
  for (let r = 1; r < snap.order.length; r++) {
    const a = cars[snap.order[r - 1]].timing;
    const b = cars[snap.order[r]].timing;
    if (a.finished && b.finished) expect(a.finishTime!).toBeLessThanOrEqual(b.finishTime!);
    else if (a.finished !== b.finished) expect(a.finished).toBe(true);
    else expect(a.progress).toBeGreaterThanOrEqual(b.progress);
  }
}

/** Teleport a car's body to a track pose (keeps velocities; the model re-samples the ground). */
function teleport(state: VehicleState, track: CompiledTrack, s: number, lateral = 0): void {
  const p = track.poseAt(s, lateral);
  state.x = p.x;
  state.y = p.y;
  state.heading = p.heading;
}

// ---------------------------------------------------------------------------

describe('race: three scripted cars, one lap of clubsprint', () => {
  const track = club();
  const race = createRace({ track, entries: scriptedEntries(track, ['Roadster S', 'Club Hatch', 'Muscle']), laps: 1, seed: 7, collisions: true });

  it('places the field on the grid behind the line in entry order', () => {
    const snap = race.snapshot();
    expect(snap.started).toBe(false);
    expect(snap.countdown).toBeCloseTo(3, 9);
    expect(snap.time).toBe(0);
    expect(snap.order).toEqual([0, 1, 2]);
    for (const car of race.cars) {
      const p = track.project(car.state.x, car.state.y);
      const slot = track.gridSlot(car.index);
      expect(Math.hypot(car.state.x - slot.x, car.state.y - slot.y)).toBeLessThan(0.05);
      expect(Math.abs(p.lateral)).toBeLessThan(track.centreAt(p.s).width / 2);
      // behind the line: progress slightly negative (lap 1 starts at the first crossing)
      expect(car.timing.progress).toBeLessThan(0);
      expect(car.timing.progress).toBeGreaterThan(-0.05);
      expect(car.timing.lap).toBe(0);
      expect(car.state.speed).toBeLessThan(0.01);
    }
  });

  it('everyone finishes with plausible lap times, consistent order and no NaN', () => {
    race.start();
    expect(race.snapshot().started).toBe(true);
    let steps = 0;
    while (!race.snapshot().finished && race.time < 200) {
      race.step(SIM_DT);
      steps++;
      if (steps % 600 === 0) expectOrderConsistent(race, race.snapshot());
    }
    const snap = race.snapshot();
    expect(snap.finished).toBe(true);
    expect(race.time).toBeLessThan(200);
    expectOrderConsistent(race, snap);
    for (const car of race.cars) {
      const tm = car.timing;
      expect(tm.finished).toBe(true);
      expect(tm.lap).toBe(1);
      expect(tm.finishTime).not.toBeNull();
      expect(tm.lastLapTime).not.toBeNull();
      expect(tm.bestLapTime).toBe(tm.lastLapTime);
      expect(tm.lapTimes).toEqual([tm.lastLapTime]);
      // clubsprint (1.67 km) at a modest scripted pace
      expect(tm.lastLapTime!).toBeGreaterThan(50);
      expect(tm.lastLapTime!).toBeLessThan(140);
      // the finish time includes the run from the grid to the line
      expect(tm.finishTime!).toBeGreaterThan(tm.lastLapTime!);
      expect(tm.progress).toBe(1);
      // three sectors that add up to the lap
      expect(tm.lastLapSectors).toHaveLength(3);
      const sum = tm.lastLapSectors!.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(tm.lastLapTime!, 6);
      for (const s of tm.lastLapSectors!) expect(s).toBeGreaterThan(5);
      expect(tm.sectors).toEqual([]);
      expectFinite(car.state, `car${car.index}.state`);
      expectFinite(tm, `car${car.index}.timing`);
    }
    // order = finish order
    const times = snap.order.map((i) => race.cars[i].timing.finishTime!);
    for (let r = 1; r < times.length; r++) expect(times[r]).toBeGreaterThanOrEqual(times[r - 1]);
    // the clock keeps running after the finish, positions stay frozen
    const before = snap.order.slice();
    run(race, 1);
    expect(race.snapshot().order).toEqual(before);
    expect(race.snapshot().finished).toBe(true);
  });

  it('raceSummary produces the results table', () => {
    const rows = raceSummary(race);
    expect(rows).toHaveLength(3);
    rows.forEach((row, r) => {
      expect(row.position).toBe(r + 1);
      expect(row.finished).toBe(true);
      expect(row.laps).toBe(1);
      expect(row.name).toBe(race.cars[row.index].entry.name);
      expect(row.color).toBe(race.cars[row.index].entry.spec.color);
      expect(row.bestLapTime).toBe(race.cars[row.index].timing.bestLapTime);
      expect(row.resets).toBe(race.cars[row.index].timing.resets ?? 0);
      if (r === 0) {
        expect(row.gap).toBe(0);
        expect(row.total).toMatch(/^\d+:\d\d\.\d{3}$/);
      } else {
        expect(row.gap!).toBeGreaterThanOrEqual(rows[r - 1].gap!);
        expect(row.total).toBe(`+${row.gap!.toFixed(3)}`);
      }
    });
  });
});

// ---------------------------------------------------------------------------

describe('race: countdown, player input and start()', () => {
  it('holds the cars during the 3 s countdown, ignores inputs, then goes green', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S')], laps: 2, seed: 1 });
    race.setPlayerInput(input({ throttle: 1 }));
    run(race, 2);
    let snap = race.snapshot();
    expect(snap.started).toBe(false);
    expect(snap.countdown).toBeCloseTo(1, 6);
    expect(snap.time).toBe(0);
    expect(race.cars[0].state.speed).toBeLessThan(0.05);
    expect(race.cars[0].state.input.brake).toBe(1); // held on the brake
    run(race, 1.2);
    snap = race.snapshot();
    expect(snap.started).toBe(true);
    expect(snap.countdown).toBe(0);
    expect(snap.time).toBeGreaterThan(0.15);
    expect(snap.time).toBeLessThan(0.25);
    expect(race.cars[0].timing.lapStartTime).toBe(0);
  });

  it('a player car takes setPlayerInput: full throttle moves it, neutral does not', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S')], laps: 1, seed: 1 });
    race.start();
    const car = race.cars[0];
    const x0 = car.state.x;
    const y0 = car.state.y;
    run(race, 1);
    expect(car.state.speed).toBeLessThan(0.3);
    race.setPlayerInput(input({ throttle: 1 }));
    run(race, 3);
    expect(car.input.throttle).toBe(1);
    expect(car.state.input.throttle).toBe(1);
    expect(car.state.speed).toBeGreaterThan(8);
    // a wheelspin launch on cold tyres: ~13 m in 3 s for the default RWD car
    expect(Math.hypot(car.state.x - x0, car.state.y - y0)).toBeGreaterThan(10);
    expect(car.state.odometer).toBeGreaterThan(10);
    // moving forward along the track
    const p = track.project(car.state.x, car.state.y);
    expect(p.s).toBeGreaterThan(track.project(x0, y0).s);
    expect(car.timing.progress).toBeGreaterThan(-0.05);
    expectFinite(car.state, 'state');
  });

  it('step() runs whole SIM_DT substeps, caps the backlog and ignores bad dt', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S')], laps: 1 });
    race.start();
    race.step(SIM_DT * 2.5);
    expect(race.time).toBeCloseTo(2 * SIM_DT, 12);
    race.step(SIM_DT * 0.5); // completes the third substep
    expect(race.time).toBeCloseTo(3 * SIM_DT, 12);
    race.step(1); // 120 substeps requested → capped at 8, backlog dropped
    expect(race.time).toBeCloseTo(11 * SIM_DT, 12);
    race.step(SIM_DT * 0.9); // no backlog left → nothing runs
    expect(race.time).toBeCloseTo(11 * SIM_DT, 12);
    race.step(NaN);
    race.step(-1);
    race.step(0);
    expect(race.time).toBeCloseTo(11 * SIM_DT, 12);
    expect(race.cars[0].state.time).toBeGreaterThan(0);
  });

  it('a rolling start launches the field without a countdown', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S'), playerEntry('Club Hatch')], laps: 1, startSpeed: 20 });
    const snap = race.snapshot();
    expect(snap.started).toBe(true);
    expect(snap.countdown).toBe(0);
    for (const car of race.cars) {
      expect(car.state.speed).toBeCloseTo(20, 6);
      expect(car.state.gear).toBeGreaterThanOrEqual(1);
      expect(car.state.engineRpm).toBeLessThan(car.entry.spec.engine.redlineRpm);
    }
    run(race, 1);
    for (const car of race.cars) expect(car.state.speed).toBeGreaterThan(15);
  });

  it('rejects an empty entry list', () => {
    expect(() => createRace({ track: club(), entries: [], laps: 1 })).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('race: lap timing rules', () => {
  /** Hop a stationary car along the centreline by `ds` metres per step (teleport + step). */
  function hop(race: Race, track: CompiledTrack, from: number, to: number, ds: number): number {
    let s = from;
    while (s < to) {
      s = Math.min(s + ds, to);
      teleport(race.cars[0].state, track, s);
      race.step(SIM_DT);
    }
    return s;
  }

  it('the first crossing starts lap 1, later crossings complete laps, sectors are recorded', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S')], laps: 2, collisions: false });
    race.start();
    const tm = race.cars[0].timing;
    const L = track.length;
    const sl = track.startLine;
    run(race, 0.5);
    // grid → across the line: lap 1 begins, no lap counted
    hop(race, track, sl - 8, sl + 3, 2);
    expect(tm.lap).toBe(0);
    expect(tm.lastLapTime).toBeNull();
    const lapStart = tm.lapStartTime;
    expect(Math.abs(lapStart - race.time)).toBeLessThan(3 * SIM_DT); // crossed a hop or two ago
    expect(tm.progress).toBeGreaterThan(0);
    expect(tm.progress).toBeLessThan(0.01);
    // one lap in 20 m hops
    hop(race, track, sl + 3, sl + L + 3, 20);
    expect(tm.lap).toBe(1);
    expect(tm.lastLapTime).toBeCloseTo(race.time - lapStart, 6);
    expect(tm.bestLapTime).toBe(tm.lastLapTime);
    expect(tm.lastLapSectors).toHaveLength(3);
    expect(tm.lastLapSectors!.reduce((a, b) => a + b, 0)).toBeCloseTo(tm.lastLapTime!, 6);
    expect(tm.sectors).toEqual([]);
    expect(tm.finished).toBe(false);
    expect(tm.progress).toBeGreaterThan(1);
    // second lap finishes the race
    hop(race, track, sl + 3, sl + L + 3, 20);
    expect(tm.lap).toBe(2);
    expect(tm.finished).toBe(true);
    expect(tm.finishTime).toBeCloseTo(race.time, 6);
    expect(tm.progress).toBe(2);
    expect(tm.lapTimes).toHaveLength(2);
    expect(race.snapshot().finished).toBe(true);
  });

  it('reversing over the line undoes the crossing; nothing is counted twice', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S')], laps: 3, collisions: false });
    race.start();
    const tm = race.cars[0].timing;
    const L = track.length;
    const sl = track.startLine;
    // creep back and forth over the line from the grid: lap stays 0, progress flips sign
    hop(race, track, sl - 8, sl + 2, 2);
    expect(tm.lap).toBe(0);
    expect(tm.progress).toBeGreaterThan(0);
    teleport(race.cars[0].state, track, sl - 2);
    race.step(SIM_DT);
    expect(tm.lap).toBe(0);
    expect(tm.progress).toBeLessThan(0);
    hop(race, track, sl - 2, sl + 2, 2);
    expect(tm.lap).toBe(0);
    const start1 = tm.lapStartTime;
    // complete a lap, then roll back over the line: the lap is undone
    hop(race, track, sl + 2, sl + L + 2, 20);
    expect(tm.lap).toBe(1);
    const firstLap = tm.lastLapTime!;
    teleport(race.cars[0].state, track, sl - 2);
    race.step(SIM_DT);
    expect(tm.lap).toBe(0);
    expect(tm.lastLapTime).toBeNull();
    expect(tm.bestLapTime).toBeNull();
    expect(tm.lapTimes).toEqual([]);
    expect(tm.lapStartTime).toBe(start1);
    expect(tm.progress).toBeGreaterThan(0.9); // still on lap 1, just before the line
    // crossing again completes the (longer) lap once
    hop(race, track, sl - 2, sl + 2, 2);
    expect(tm.lap).toBe(1);
    expect(tm.lapTimes).toHaveLength(1);
    expect(tm.lastLapTime!).toBeGreaterThan(firstLap);
    expect(Math.abs(tm.lastLapTime! - (race.time - start1))).toBeLessThan(3 * SIM_DT);
  });

  it('a reset that moves the car back behind the line undoes the crossing too', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S')], laps: 3, collisions: false });
    race.start();
    const tm = race.cars[0].timing;
    const sl = track.startLine;
    hop(race, track, sl - 8, sl + 3, 2);
    hop(race, track, sl + 3, sl + track.length + 3, 20);
    expect(tm.lap).toBe(1);
    // car well off the track (beyond the reset margin, but still nearest to the start straight) just past
    // the line → its projection completes lap 2, the reset falls back to the last on-track s behind the line
    const st = race.cars[0].state;
    hop(race, track, sl + 3, sl + track.length - 3, 20); // lastOnTrackS just before the line, lap still 1
    teleport(st, track, sl + 2, 20);
    race.step(SIM_DT);
    expect(tm.lap).toBe(2);
    expect(st.road.onTrack).toBe(false);
    race.resetCar(0);
    expect(tm.resets).toBe(1);
    expect(tm.lap).toBe(1); // moved back behind the line: the crossing is undone
    const p = track.project(st.x, st.y);
    expect(Math.abs(p.lateral)).toBeLessThan(0.05);
    expect(p.s).toBeLessThan(sl);
    expect(p.s).toBeGreaterThan(sl - 30);
  });
});

// ---------------------------------------------------------------------------

describe('race: collisions', () => {
  it('two overlapping cars separate within 1 s without exploding', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S'), playerEntry('Kei Racer')], laps: 1 });
    race.start();
    const a = race.cars[0].state;
    const b = race.cars[1].state;
    // put B on top of A, 0.6 m to the left and 0.3 m ahead (deep overlap of every circle pair)
    b.x = a.x - 0.6 * Math.sin(a.heading) + 0.3 * Math.cos(a.heading);
    b.y = a.y + 0.6 * Math.cos(a.heading) + 0.3 * Math.sin(a.heading);
    b.heading = a.heading;
    const rSum = race.cars[0].entry.spec.width / 2 + race.cars[1].entry.spec.width / 2 + 2 * COLLISION_RADIUS_MARGIN;
    let maxSpeed = 0;
    for (let i = 0; i < 120; i++) {
      race.step(SIM_DT);
      maxSpeed = Math.max(maxSpeed, a.speed, b.speed);
      expectFinite({ ax: a.x, ay: a.y, bx: b.x, by: b.y, va: a.vx, vb: b.vx }, `step ${i}`);
    }
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    expect(dist).toBeGreaterThanOrEqual(rSum - 0.05);
    expect(dist).toBeLessThan(rSum + 2);
    expect(maxSpeed).toBeLessThan(60);
    expect(a.speed).toBeLessThan(5);
    expect(b.speed).toBeLessThan(5);
    expect(Math.abs(a.roll)).toBeLessThan(0.2);
    expect(Math.abs(b.roll)).toBeLessThan(0.2);
    expect(a.wrecked || b.wrecked).toBe(false);
  });

  it('a rear-end impact transfers momentum with restitution ≈ 0.25 and flashes lastImpact', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S'), playerEntry('Kei Racer')], laps: 1 });
    race.start();
    const A = race.cars[0].state;
    const B = race.cars[1].state;
    const mA = race.cars[0].entry.spec.mass;
    const mB = race.cars[1].entry.spec.mass;
    const pa = track.project(A.x, A.y);
    teleport(B, track, pa.s - 6, pa.lateral);
    B.vx = 10;
    for (const w of B.wheels) w.omega = 10 / race.cars[1].entry.spec.tires.front.radius;
    let peak = 0;
    let hitAt = -1;
    for (let i = 0; i < 240; i++) {
      race.step(SIM_DT);
      if (race.cars[0].lastImpact > peak) peak = race.cars[0].lastImpact;
      if (hitAt < 0 && race.cars[0].lastImpact > 0) hitAt = race.time;
      expect(A.speed).toBeLessThan(60);
      expect(B.speed).toBeLessThan(60);
    }
    expect(hitAt).toBeGreaterThan(0);
    expect(hitAt).toBeLessThan(1);
    // B shoved A forward, B slowed down; relative speed after ≈ 0.25 × 10 m/s (tyres bleed a little)
    expect(A.vx).toBeGreaterThan(2);
    expect(B.vx).toBeLessThan(6);
    // impulse magnitude: J = (1+e) vrel / (1/mA + 1/mB) for a straight central hit
    const expected = (1.25 * 10) / (1 / mA + 1 / mB);
    expect(peak).toBeGreaterThan(0.6 * expected);
    expect(peak).toBeLessThan(1.1 * expected);
    expect(race.cars[1].lastImpact).toBeLessThan(peak * 0.05); // decayed (0.3 s time constant)
    expectFinite(A, 'A');
    expectFinite(B, 'B');
  });

  it('applyWorldImpulse changes body velocity and yaw rate as expected', () => {
    const sp = spec('Roadster S');
    const st = createRace({ track: club(), entries: [playerEntry('Roadster S')], laps: 1 }).cars[0].state;
    st.heading = Math.PI / 2; // facing north: body x = world +y
    st.vx = st.vy = st.yawRate = 0;
    // a 1000 N·s push northwards applied 1 m to the right of the CG (world +x) → forward speed, CCW yaw
    applyWorldImpulse(sp, st, st.x + 1, st.y, 0, 1000);
    expect(st.vx).toBeCloseTo(1000 / sp.mass, 9);
    expect(st.vy).toBeCloseTo(0, 9);
    expect(st.yawRate).toBeCloseTo(1000 / sp.yawInertia, 9);
  });

  it('collisions: false lets cars overlap', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S'), playerEntry('Kei Racer')], laps: 1, collisions: false });
    race.start();
    const a = race.cars[0].state;
    const b = race.cars[1].state;
    b.x = a.x;
    b.y = a.y;
    b.heading = a.heading;
    run(race, 0.5);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------

describe('race: resets', () => {
  it('a wrecked car is put back on the road within 3 s and drives on', () => {
    const track = club();
    const race = createRace({ track, entries: scriptedEntries(track, ['Roadster S']), laps: 1 });
    race.start();
    run(race, 2);
    const car = race.cars[0];
    const st = car.state;
    expect(st.speed).toBeGreaterThan(3);
    const odo = st.odometer;
    st.roll = 1.4;
    st.wrecked = true;
    const tWreck = race.time;
    let resetAt = -1;
    while (race.time - tWreck < 3 && resetAt < 0) {
      race.step(SIM_DT);
      if ((car.timing.resets ?? 0) > 0) resetAt = race.time - tWreck;
    }
    expect(resetAt).toBeGreaterThan(WRECK_RESET_DELAY - 0.1);
    expect(resetAt).toBeLessThan(WRECK_RESET_DELAY + 0.1);
    expect(car.timing.resets).toBe(1);
    expect(st.wrecked).toBe(false);
    expect(Math.abs(st.roll)).toBeLessThan(0.05);
    expect(st.speed).toBeLessThan(0.1);
    expect(st.odometer).toBeGreaterThanOrEqual(odo); // the odometer survives the reset (not zeroed)
    const p = track.project(st.x, st.y);
    expect(Math.abs(p.lateral)).toBeLessThan(0.05); // on the centreline
    expect(Math.abs(wrapAngle(st.heading - track.centreAt(p.s).heading))).toBeLessThan(0.01);
    // drives on
    run(race, 4);
    expect(st.speed).toBeGreaterThan(5);
    expect(st.offTrack).toBe(false);
    expect(st.wrecked).toBe(false);
    expect(car.timing.resets).toBe(1);
    expectFinite(st, 'state');
  });

  it('resetCar keeps tyre and brake temperatures and zeroes the input', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S')], laps: 1 });
    race.start();
    const car = race.cars[0];
    race.setPlayerInput(input({ throttle: 1, steer: 0.5 }));
    run(race, 4);
    car.state.wheels[2].tire.temp = 95;
    car.state.wheels[0].brake.temp = 300;
    race.resetCar(0);
    expect(car.state.wheels[2].tire.temp).toBe(95);
    expect(car.state.wheels[0].brake.temp).toBe(300);
    expect(car.input).toEqual(NEUTRAL_INPUT);
    expect(car.state.speed).toBeLessThan(0.05);
    expect(car.timing.resets).toBe(1);
    expect(race.snapshot().order).toEqual([0]);
  });

  it('a car that leaves the world is put back after OFF_WORLD_DELAY', () => {
    const track = club();
    const race = createRace({ track, entries: [playerEntry('Roadster S')], laps: 1 });
    race.start();
    const st = race.cars[0].state;
    const s0 = track.project(st.x, st.y).s;
    teleport(st, track, s0, 60); // 55 m beyond the edge
    run(race, OFF_WORLD_DELAY - 0.2);
    expect(race.cars[0].timing.resets).toBe(0);
    run(race, 0.4);
    expect(race.cars[0].timing.resets).toBe(1);
    const p = track.project(st.x, st.y);
    expect(Math.abs(p.lateral)).toBeLessThan(0.05);
    expect(Math.abs(p.s - s0)).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------

describe('race: stage (pinecone)', () => {
  it('progress is s/length and the car is marked finished at the end', () => {
    const track = compileTrack(trackSpec('pinecone-stage'));
    const sp = spec('Gravel Rally');
    const race = createRace({
      track,
      entries: [{ spec: sp, driver: { kind: 'player' }, name: 'Rally', controller: pursuit(track, sp, { vMax: 30, ayMax: 4, aBrake: 3.5, lane: 0 }) }],
      laps: 1,
    });
    race.start();
    const car = race.cars[0];
    const tm = car.timing;
    // grid slot 0 sits ahead of the line on this stage (startLine 0): timing runs from the green light
    expect(tm.lapStartTime).toBe(0);
    expect(tm.progress).toBeGreaterThan(0);
    expect(tm.progress).toBeLessThan(0.01);
    run(race, 3);
    expect(tm.progress).toBeCloseTo(track.project(car.state.x, car.state.y).s / track.length, 4);
    expect(tm.lap).toBe(0);
    expect(tm.finished).toBe(false);
    // jump to 80 m before the finish (via the reset path) and drive the rest
    teleport(car.state, track, track.length - 80);
    race.resetCar(0);
    expect(tm.resets).toBe(1);
    expect(tm.progress).toBeCloseTo((track.length - 80) / track.length, 3);
    expect(tm.finished).toBe(false);
    while (!race.snapshot().finished && race.time < 60) race.step(1 / 60);
    expect(race.snapshot().finished).toBe(true);
    expect(tm.finished).toBe(true);
    expect(tm.lap).toBe(1);
    expect(tm.progress).toBe(1);
    expect(Math.abs(tm.finishTime! - race.time)).toBeLessThan(3 * SIM_DT); // finished within the last step
    expect(tm.finishTime!).toBeGreaterThan(3);
    expect(tm.lastLapTime).toBe(tm.finishTime);
    expect(tm.bestLapTime).toBe(tm.finishTime);
    const s = track.project(car.state.x, car.state.y).s;
    expect(s).toBeGreaterThanOrEqual(track.length - 1.5);
    const rows = raceSummary(race);
    expect(rows[0].laps).toBe(1);
    expect(rows[0].finished).toBe(true);
    expect(rows[0].total).toMatch(/^\d+:\d\d\.\d{3}$/);
    expectFinite(car.state, 'state');
  });
});

// ---------------------------------------------------------------------------

describe('race: determinism and throughput', () => {
  it('the same race twice with the same seed is bit-identical', () => {
    const play = (): Race => {
      const track = club();
      const race = createRace({ track, entries: scriptedEntries(track, ['Roadster S', 'Club Hatch', 'Kei Racer']), laps: 3, seed: 99, collisions: true });
      // no start(): countdown included; irregular frame times exercise the accumulator
      for (let i = 0; i < 1500; i++) race.step(i % 3 === 0 ? 1 / 50 : 1 / 60);
      return race;
    };
    const a = play();
    const b = play();
    expect(a.time).toBe(b.time);
    expect(a.snapshot().order).toEqual(b.snapshot().order);
    for (let i = 0; i < a.cars.length; i++) {
      const sa = a.cars[i].state;
      const sb = b.cars[i].state;
      for (const k of ['x', 'y', 'z', 'heading', 'vx', 'vy', 'yawRate', 'roll', 'pitch', 'engineRpm', 'speed', 'odometer'] as const) {
        expect(sa[k], `car ${i} ${k}`).toBe(sb[k]);
      }
      for (let w = 0; w < 4; w++) {
        expect(sa.wheels[w].tire.temp).toBe(sb.wheels[w].tire.temp);
        expect(sa.wheels[w].brake.temp).toBe(sb.wheels[w].brake.temp);
        expect(sa.wheels[w].omega).toBe(sb.wheels[w].omega);
      }
      expect(a.cars[i].timing).toEqual(b.cars[i].timing);
      expect(a.cars[i].lastImpact).toBe(b.cars[i].lastImpact);
    }
    expect(a.cars[0].state.speed).toBeGreaterThan(5); // the cars actually raced
  });

  it('deriveAiSeed is deterministic and separates entries', () => {
    expect(deriveAiSeed(42, 1, 1001)).toBe(deriveAiSeed(42, 1, 1001));
    expect(deriveAiSeed(42, 1, 1001)).not.toBe(deriveAiSeed(42, 2, 1001));
    expect(deriveAiSeed(42, 1, 1001)).not.toBe(deriveAiSeed(43, 1, 1001));
    expect(deriveAiSeed(0, 0, 0)).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(deriveAiSeed(7, 3, 5))).toBe(true);
  });

  it('a 6-car race simulates well above realtime (target ≥ 20×, asserted ≥ 5×)', () => {
    const track = club();
    const race = createRace({
      track,
      entries: scriptedEntries(track, ['Roadster S', 'Club Hatch', 'Muscle', 'Track Weapon', 'Kei Racer', 'Drift Missile']),
      laps: 5,
      seed: 3,
      collisions: true,
    });
    race.start();
    const seconds = 15;
    const t0 = performance.now();
    run(race, seconds, 1 / 60);
    const wall = (performance.now() - t0) / 1000;
    const ratio = seconds / wall;
    console.log(`race throughput: 6 cars, ${seconds} s simulated in ${wall.toFixed(2)} s → ${ratio.toFixed(1)}× realtime`);
    expect(race.time).toBeCloseTo(seconds, 6);
    expect(ratio).toBeGreaterThanOrEqual(5);
    for (const car of race.cars) expectFinite(car.state, `car${car.index}`);
    expectOrderConsistent(race, race.snapshot());
  });
});
