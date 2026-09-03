/**
 * Race manager — owns the vehicles, their drivers, timing / positions, simple car-to-car collisions
 * and the fixed-step loop.
 *
 *  - Cars are created on `track.gridSlot(i)` in entry order (`createVehicleState`, settled on the
 *    road). AI drivers are created for `driver.kind === 'ai'` entries (seed derived from
 *    `config.seed` and the entry index); `RaceEntry.controller` overrides the input source of a car
 *    (scripted drivers for tests / demos / replays).
 *  - 3 s countdown: inputs are ignored and the cars are held on the brake; `time` stays 0 until the
 *    green light. `start()` skips the countdown. A rolling start (`startSpeed > 0`) skips it too and
 *    launches the field at that speed.
 *  - `step(dt)` accumulates real time and runs whole SIM_DT (1/120 s) substeps, at most 8 per call
 *    (the backlog is dropped → slow motion instead of a spiral of death). Per substep: gather inputs
 *    → `stepVehicle` every car → collisions → timing → wreck watchdog.
 *  - Collisions: two circles per car (front / rear, radius width/2 + 0.1). On overlap the cars are
 *    pushed apart along the contact normal (positional correction split by mass) and receive a normal
 *    impulse with restitution 0.25 plus a Coulomb tangential impulse (μ 0.3); the world impulses are
 *    converted to the body-frame velocity / yaw rate of each car (`applyWorldImpulse`). `lastImpact`
 *    holds the largest recent normal impulse (N·s), decaying with a 0.3 s time constant.
 *  - Timing: each car is projected onto the centreline every substep (hinted → O(1)). A lap is
 *    counted when the lap fraction (measured from the start line) wraps forward; wrapping backward
 *    undoes the last crossing (reversing over the line, or a reset that moves the car behind it).
 *    Cars start behind the line, so the first crossing STARTS lap 1. Three equal sectors by s.
 *    `progress = lap + frac` (frac relative to the start line; cars still behind it read frac − 1),
 *    for stages `progress = s / length`. Finished at `lap == laps` (stages: `s ≥ length − 1`).
 *  - Order: finished cars first by finish time, then by progress descending (ties by index).
 *  - `resetCar(i)`: nearest centreline pose to the car (or the last on-track s when it is far off),
 *    `resetVehicleState` (keeps tyre / brake temperatures and wear), zero input. Called automatically
 *    2.5 s after a car becomes `wrecked`; counted in `timing.resets`.
 *
 * Deterministic: no RNG; the substep sequence only depends on the inputs (and, for AI, the seed).
 * See docs/notes/race.md for the timing rules, the collision model and the simplifications.
 */
import { createAiDriver } from './ai';
import type { AiDriver, AiDriverOptions } from './ai';
import { rpmFromWheelSpeed } from './drivetrain';
import type { DriverInput, VehicleSpec, VehicleState } from './types';
import type { CompiledTrack } from './track';
import { createVehicleState, NEUTRAL_INPUT, resetVehicleState, SIM_DT, stepVehicle } from './vehicle';

/**
 * Scripted controller: produces the driver input for a car each substep. When present on an entry it
 * replaces the player input / AI driver for that car (tests, demos, replays).
 */
export type CarController = (state: VehicleState, others: ReadonlyArray<VehicleState>, dt: number) => DriverInput;

export interface RaceEntry {
  spec: VehicleSpec;
  driver: { kind: 'player' } | ({ kind: 'ai' } & AiDriverOptions);
  name: string;
  /** Optional scripted controller overriding the input source for this car (see CarController). */
  controller?: CarController;
}

export interface RaceConfig {
  track: CompiledTrack;
  entries: RaceEntry[];
  laps: number;
  /** Rolling start speed (m/s) or 0 for standing start. */
  startSpeed?: number;
  /** Seed for deterministic replays. */
  seed?: number;
  /** Enable car-to-car collisions (default true). */
  collisions?: boolean;
}

export interface CarTiming {
  lap: number; // completed laps
  lapStartTime: number;
  lastLapTime: number | null;
  bestLapTime: number | null;
  /** Progress along the track for ordering: lap + s/length. */
  progress: number;
  finished: boolean;
  finishTime: number | null;
  /** Sector splits of the current lap (3 equal sectors). */
  sectors: number[];
  /** Number of times the car was put back on the road (player key or wreck watchdog). */
  resets?: number;
  /** Sector durations (s) of the last completed lap, 3 entries. */
  lastLapSectors?: number[];
  /** Every completed lap time (s), in order. */
  lapTimes?: number[];
}

export interface RaceCar {
  index: number;
  entry: RaceEntry;
  state: VehicleState;
  timing: CarTiming;
  input: DriverInput;
  /** Last collision impulse magnitude for FX. */
  lastImpact: number;
  /** The AI driver of an `ai` entry (absent for player / scripted cars). */
  ai?: AiDriver;
}

export interface RaceSnapshot {
  time: number;
  /** Car indices ordered by race position. */
  order: number[];
  cars: RaceCar[];
  countdown: number;
  started: boolean;
  finished: boolean;
}

export interface Race {
  config: RaceConfig;
  cars: RaceCar[];
  time: number;
  /** Provide the player input for the next steps (ignored for AI cars). */
  setPlayerInput(input: DriverInput): void;
  /** Advance the race by dt (fixed sub-steps internally). */
  step(dt: number): void;
  snapshot(): RaceSnapshot;
  /** Skip countdown (tests). */
  start(): void;
  /**
   * Put a car back on the track: nearest centreline pose to its current position (or the last on-track
   * position), zero velocity, upright. Used by the player's reset key and automatically ~2.5 s after a
   * car is `wrecked` (rolled over) so races always continue.
   */
  resetCar(index: number): void;
}

/** One row of the results table produced by `raceSummary`. */
export interface RaceResultRow {
  /** 1-based finishing / running position. */
  position: number;
  /** Car index in `race.cars`. */
  index: number;
  name: string;
  /** Cosmetic colour of the car (CSS string). */
  color: string;
  /** Completed laps (1 for a finished stage). */
  laps: number;
  bestLapTime: number | null;
  lastLapTime: number | null;
  finished: boolean;
  /** Race time at the finish (s), null while running. */
  finishTime: number | null;
  /** Seconds behind the winner (finished cars only, 0 for the winner), null while running. */
  gap: number | null;
  /** Whole laps behind the leader (running cars), 0 otherwise. */
  lapsDown: number;
  resets: number;
  /** Ready-to-show total column: "1:23.456" (winner), "+2.345", "+1 lap", "running". */
  total: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Countdown before the green light (s). */
export const COUNTDOWN_S = 3;
/** Substeps per `step()` call before the backlog is dropped (slow motion instead of a spiral). */
export const MAX_SUBSTEPS = 8;
/** A wrecked car is put back on the road after this long (s). */
export const WRECK_RESET_DELAY = 2.5;
/** Collision circle radius = width/2 + this (m). */
export const COLLISION_RADIUS_MARGIN = 0.1;
/** Normal restitution of car-to-car contacts. */
export const COLLISION_RESTITUTION = 0.25;
/** Coulomb friction of car-to-car contacts (tangential impulse ≤ μ × normal impulse). */
export const COLLISION_FRICTION = 0.3;
/** Fraction of the remaining overlap removed per substep (positional correction). */
const POSITION_CORRECTION = 0.6;
/** Overlap below which no positional correction is applied (m). */
const CONTACT_SLOP = 0.01;
/** Cars whose CGs differ by more than this in height do not collide (one is flying over the other). */
const MAX_CONTACT_Z_GAP = 1.0;
/** `lastImpact` decay time constant (s). */
const IMPACT_DECAY_TAU = 0.3;
/** A car farther than halfWidth + this from the centreline resets to its last on-track s instead. */
const RESET_MAX_OFF_TRACK = 12;
/** Lap-fraction thresholds for detecting a wrap across the start line. */
const WRAP_HI = 0.75;
const WRAP_LO = 0.25;
/** Stage finish: s ≥ length − this (m). */
const STAGE_FINISH_MARGIN = 1;

const HOLD_INPUT: DriverInput = { ...NEUTRAL_INPUT, brake: 1 };
const IMPACT_DECAY = Math.exp(-SIM_DT / IMPACT_DECAY_TAU);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 32-bit hash of (seed, index, entrySeed) → AI seed. Deterministic, order-sensitive. */
export function deriveAiSeed(raceSeed: number, index: number, entrySeed: number): number {
  let h = (raceSeed | 0) ^ Math.imul((index | 0) + 0x632be5ab, 0x9e3779b9) ^ Math.imul(entrySeed | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Apply a world-frame impulse (jx, jy) [N·s] acting at world point (px, py) to a vehicle state: the
 * body-frame velocity changes by R⁻¹·J/m and the yaw rate by (r × J)/Iz with r the lever arm from the
 * CG. Pitch/roll are ignored (planar contact model).
 */
export function applyWorldImpulse(spec: VehicleSpec, state: VehicleState, px: number, py: number, jx: number, jy: number): void {
  const m = spec.mass > 1 ? spec.mass : 1;
  const iz = spec.yawInertia > 0 ? spec.yawInertia : m * 1.5;
  const c = Math.cos(state.heading);
  const s = Math.sin(state.heading);
  state.vx += (jx * c + jy * s) / m;
  state.vy += (-jx * s + jy * c) / m;
  const rx = px - state.x;
  const ry = py - state.y;
  state.yawRate += (rx * jy - ry * jx) / iz;
}

function copyInput(dst: DriverInput, src: DriverInput): void {
  dst.throttle = src.throttle;
  dst.brake = src.brake;
  dst.steer = src.steer;
  dst.handbrake = src.handbrake;
  dst.shiftUp = src.shiftUp;
  dst.shiftDown = src.shiftDown;
}

function zeroInput(dst: DriverInput): void {
  copyInput(dst, NEUTRAL_INPUT);
}

/** m:ss.mmm */
function fmtTime(t: number): string {
  const total = Math.round(Math.max(0, t) * 1000);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total - m * 60000) / 1000);
  const ms = total - m * 60000 - s * 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

interface CarInternal {
  /** Projection hint (last arc length). */
  lastS: number;
  /** Lap fraction (circuit: from the start line, [0,1)) or s/length (stage) at the previous substep. */
  prevFrac: number;
  /** Car is behind the start line and has not started lap 1 yet (its first crossing starts the lap). */
  pendingStart: boolean;
  /** Arc length where the car was last on the track surface (reset fallback). */
  lastOnTrackS: number;
  /** Seconds spent wrecked (auto-reset watchdog). */
  wreckTimer: number;
  /** Lap time at the last recorded sector boundary (s). */
  sectorAcc: number;
  /** State to restore when the car reverses back over the line after a crossing. */
  undo: { lapStart: number; lastLap: number | null; best: number | null; sectors: number[] | undefined } | null;
  /** The other cars' states (for AI / controllers). */
  others: VehicleState[];
  ai: AiDriver | null;
  controller: CarController | null;
  /** Collision geometry (body frame): circle radius and the two circle centres along body x. */
  radius: number;
  frontOff: number;
  rearOff: number;
  /** Broad-phase reach: farthest circle extent from the CG. */
  reach: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class RaceImpl implements Race {
  readonly config: RaceConfig;
  readonly cars: RaceCar[] = [];
  time = 0;

  private readonly track: CompiledTrack;
  private readonly closed: boolean;
  private readonly length: number;
  private readonly startLine: number;
  private readonly laps: number;
  private readonly collisionsOn: boolean;
  private readonly internals: CarInternal[] = [];
  private readonly order: number[] = [];
  private countdown = COUNTDOWN_S;
  private started = false;
  private finished = false;
  private acc = 0;
  private orderDirty = true;

  constructor(config: RaceConfig) {
    if (!config || !config.track) throw new Error('createRace: a compiled track is required');
    if (!config.entries || config.entries.length === 0) throw new Error('createRace: at least one entry is required');
    const track = config.track;
    if (!(track.length > 0) || track.samples.length < 2) throw new Error('createRace: the track has no length');
    this.config = config;
    this.track = track;
    this.closed = track.spec.closed && track.length > 0;
    this.length = track.length;
    this.startLine = track.startLine;
    this.laps = Math.max(1, Math.floor(Number.isFinite(config.laps) ? config.laps : 1));
    this.collisionsOn = config.collisions !== false;
    const startSpeed = config.startSpeed !== undefined && Number.isFinite(config.startSpeed) ? Math.max(0, config.startSpeed) : 0;
    const raceSeed = config.seed !== undefined && Number.isFinite(config.seed) ? Math.floor(config.seed) : 0;

    for (let i = 0; i < config.entries.length; i++) {
      const entry = config.entries[i];
      const spec = entry.spec;
      const slot = track.gridSlot(i);
      const state = createVehicleState(spec, { x: slot.x, y: slot.y, heading: slot.heading }, track);
      if (startSpeed > 0) launchAtSpeed(spec, state, startSpeed);
      const timing: CarTiming = {
        lap: 0,
        lapStartTime: 0,
        lastLapTime: null,
        bestLapTime: null,
        progress: 0,
        finished: false,
        finishTime: null,
        sectors: [],
        resets: 0,
        lapTimes: [],
      };
      const car: RaceCar = { index: i, entry, state, timing, input: { ...NEUTRAL_INPUT }, lastImpact: 0 };
      let ai: AiDriver | null = null;
      if (!entry.controller && entry.driver.kind === 'ai') {
        const opts: AiDriverOptions = {
          skill: entry.driver.skill,
          aggression: entry.driver.aggression,
          seed: deriveAiSeed(raceSeed, i, Number.isFinite(entry.driver.seed) ? Math.floor(entry.driver.seed) : 0),
        };
        ai = createAiDriver(spec, track, opts);
        car.ai = ai;
      }
      this.cars.push(car);
      const a = spec.cgToFront;
      const b = spec.wheelbase - a;
      const bodyCx = (a - b) / 2; // body centred between the axles (matches the renderer)
      const radius = spec.width / 2 + COLLISION_RADIUS_MARGIN;
      const half = Math.max(spec.length / 2 - radius, 0);
      const frontOff = bodyCx + half;
      const rearOff = bodyCx - half;
      this.internals.push({
        lastS: 0,
        prevFrac: 0,
        pendingStart: false,
        lastOnTrackS: 0,
        wreckTimer: 0,
        sectorAcc: 0,
        undo: null,
        others: [],
        ai,
        controller: entry.controller ?? null,
        radius,
        frontOff,
        rearOff,
        reach: Math.max(Math.abs(frontOff), Math.abs(rearOff)) + radius,
      });
      this.order.push(i);
    }

    // Other cars' states for the drivers (stable arrays: states are mutated in place, never replaced).
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = 0; j < this.cars.length; j++) if (j !== i) this.internals[i].others.push(this.cars[j].state);
    }

    // Timing baselines.
    for (let i = 0; i < this.cars.length; i++) {
      const st = this.cars[i].state;
      const it = this.internals[i];
      const proj = track.project(st.x, st.y);
      it.lastS = proj.s;
      it.lastOnTrackS = proj.s;
      if (this.closed) {
        const f = this.lapFrac(proj.s);
        it.prevFrac = f;
        it.pendingStart = f > 0.5; // grid slots sit behind the line: the first crossing starts lap 1
        this.cars[i].timing.progress = it.pendingStart ? f - 1 : f;
      } else {
        it.prevFrac = proj.s / this.length;
        it.pendingStart = proj.s < this.startLine - 0.5;
        this.cars[i].timing.progress = proj.s / this.length;
      }
    }

    if (startSpeed > 0) this.goGreen(); // rolling start: the field is already moving, no grid hold
    this.sortOrder();
  }

  // ------------------------------------------------------------------ API

  setPlayerInput(input: DriverInput): void {
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      if (car.entry.driver.kind === 'player' && !this.internals[i].controller) copyInput(car.input, input);
    }
  }

  step(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.acc += dt;
    let n = 0;
    while (this.acc >= SIM_DT - 1e-9 && n < MAX_SUBSTEPS) {
      this.substep();
      this.acc -= SIM_DT;
      n++;
    }
    if (n >= MAX_SUBSTEPS && this.acc >= SIM_DT) this.acc = 0; // drop the backlog: slow motion, not a spiral
    if (n > 0) this.orderDirty = true;
    if (this.orderDirty) this.sortOrder();
  }

  snapshot(): RaceSnapshot {
    if (this.orderDirty) this.sortOrder();
    return {
      time: this.time,
      order: this.order.slice(),
      cars: this.cars,
      countdown: this.countdown,
      started: this.started,
      finished: this.finished,
    };
  }

  start(): void {
    if (this.started) return;
    this.goGreen();
    this.orderDirty = true;
  }

  resetCar(index: number): void {
    const car = this.cars[index];
    const it = this.internals[index];
    if (!car || !it) return;
    const st = car.state;
    const track = this.track;
    let s = it.lastOnTrackS;
    if (Number.isFinite(st.x) && Number.isFinite(st.y)) {
      const proj = track.project(st.x, st.y, it.lastS);
      const c = track.centreAt(proj.s);
      if (Number.isFinite(proj.s) && proj.distance <= c.width / 2 + RESET_MAX_OFF_TRACK) s = proj.s;
    }
    const pose = track.poseAt(s, 0);
    resetVehicleState(car.entry.spec, st, { x: pose.x, y: pose.y, heading: pose.heading }, track);
    zeroInput(car.input);
    car.lastImpact = 0;
    it.wreckTimer = 0;
    it.lastS = s;
    const tm = car.timing;
    tm.resets = (tm.resets ?? 0) + 1;
    // A reset that moves the car across the start line counts like driving across it (a car put back
    // behind the line has its crossing undone and must cross again; never a double count).
    if (this.closed) {
      const f = this.lapFrac(s);
      if (!tm.finished) {
        if (it.prevFrac > WRAP_HI && f < WRAP_LO) this.crossForward(car, it);
        else if (it.prevFrac < WRAP_LO && f > WRAP_HI) this.crossBackward(car, it);
        if (!tm.finished) tm.progress = tm.lap + (it.pendingStart ? f - 1 : f);
      }
      it.prevFrac = f;
    } else {
      if (!tm.finished) tm.progress = s / this.length;
      it.prevFrac = s / this.length;
    }
    this.orderDirty = true;
  }

  // ------------------------------------------------------------ internals

  private goGreen(): void {
    this.started = true;
    this.countdown = 0;
    for (const car of this.cars) {
      car.timing.lapStartTime = this.time;
      car.timing.sectors = [];
    }
    for (const it of this.internals) it.sectorAcc = 0;
  }

  private lapFrac(s: number): number {
    const L = this.length;
    let d = (s - this.startLine) % L;
    if (d < 0) d += L;
    return d >= L ? 0 : d / L;
  }

  private substep(): void {
    const cars = this.cars;
    const track = this.track;
    const n = cars.length;

    if (!this.started) {
      // Countdown: everyone held on the brake, inputs ignored, the race clock does not run.
      for (let i = 0; i < n; i++) stepVehicle(cars[i].entry.spec, cars[i].state, HOLD_INPUT, track, SIM_DT);
      this.countdown -= SIM_DT;
      if (this.countdown <= 1e-9) this.goGreen();
      return;
    }

    // 1. inputs
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      const it = this.internals[i];
      if (it.controller) copyInput(car.input, it.controller(car.state, it.others, SIM_DT));
      else if (it.ai) copyInput(car.input, it.ai.drive(car.state, it.others, SIM_DT));
      // player cars: car.input already holds the latest setPlayerInput
    }

    // 2. vehicles
    for (let i = 0; i < n; i++) stepVehicle(cars[i].entry.spec, cars[i].state, cars[i].input, track, SIM_DT);

    // 3. collisions
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      car.lastImpact = car.lastImpact > 1 ? car.lastImpact * IMPACT_DECAY : 0;
    }
    if (this.collisionsOn && n > 1) this.collide();

    // 4. clock + timing
    this.time += SIM_DT;
    let allDone = true;
    for (let i = 0; i < n; i++) {
      this.updateTiming(cars[i], this.internals[i]);
      if (!cars[i].timing.finished) allDone = false;
    }
    this.finished = allDone;

    // 5. wreck watchdog
    for (let i = 0; i < n; i++) {
      const it = this.internals[i];
      if (cars[i].state.wrecked) {
        it.wreckTimer += SIM_DT;
        if (it.wreckTimer >= WRECK_RESET_DELAY - 1e-9) this.resetCar(i);
      } else it.wreckTimer = 0;
    }
  }

  // ---- timing ---------------------------------------------------------------

  private updateTiming(car: RaceCar, it: CarInternal): void {
    const st = car.state;
    const tm = car.timing;
    const proj = this.track.project(st.x, st.y, it.lastS);
    if (!Number.isFinite(proj.s)) return;
    it.lastS = proj.s;
    if (st.road.onTrack) it.lastOnTrackS = proj.s;
    if (tm.finished) return;

    if (this.closed) {
      const f = this.lapFrac(proj.s);
      const pf = it.prevFrac;
      if (pf > WRAP_HI && f < WRAP_LO) this.crossForward(car, it);
      else if (pf < WRAP_LO && f > WRAP_HI) this.crossBackward(car, it);
      else if (!it.pendingStart && f > pf) {
        const k = tm.sectors.length; // sectors 0 and 1 end at 1/3 and 2/3; sector 2 ends at the line
        if (k < 2) {
          const boundary = (k + 1) / 3;
          if (pf < boundary && f >= boundary) this.recordSector(car, it);
        }
      }
      if (!tm.finished) tm.progress = tm.lap + (it.pendingStart ? f - 1 : f);
      it.prevFrac = f;
      return;
    }

    // Stage (point-to-point).
    const s = proj.s;
    const L = this.length;
    const prevS = it.prevFrac * L;
    if (it.pendingStart) {
      if (s >= this.startLine && prevS < this.startLine) {
        it.pendingStart = false;
        tm.lapStartTime = this.time;
        tm.sectors = [];
        it.sectorAcc = 0;
      }
    } else if (s > prevS) {
      const k = tm.sectors.length;
      if (k < 2) {
        const run = Math.max(L - this.startLine, 1e-6);
        const boundary = this.startLine + ((k + 1) / 3) * run;
        if (prevS < boundary && s >= boundary) this.recordSector(car, it);
      }
    }
    if (s >= L - STAGE_FINISH_MARGIN) {
      const total = this.time - tm.lapStartTime;
      tm.sectors.push(total - it.sectorAcc);
      tm.lastLapSectors = tm.sectors;
      tm.sectors = [];
      it.sectorAcc = 0;
      tm.lap = 1;
      tm.lastLapTime = total;
      tm.bestLapTime = total;
      (tm.lapTimes ??= []).push(total);
      tm.finished = true;
      tm.finishTime = this.time;
      tm.progress = 1;
    } else {
      tm.progress = s / L;
    }
    it.prevFrac = s / L;
  }

  private recordSector(car: RaceCar, it: CarInternal): void {
    const tm = car.timing;
    const elapsed = this.time - tm.lapStartTime;
    tm.sectors.push(elapsed - it.sectorAcc);
    it.sectorAcc = elapsed;
  }

  /** The car passed the start/finish line going forward. */
  private crossForward(car: RaceCar, it: CarInternal): void {
    const tm = car.timing;
    if (it.pendingStart) {
      // From the grid: lap 1 begins at the line.
      it.pendingStart = false;
      tm.lapStartTime = this.time;
      tm.sectors = [];
      it.sectorAcc = 0;
      it.undo = null;
      return;
    }
    const lapTime = this.time - tm.lapStartTime;
    it.undo = { lapStart: tm.lapStartTime, lastLap: tm.lastLapTime, best: tm.bestLapTime, sectors: tm.lastLapSectors };
    tm.sectors.push(lapTime - it.sectorAcc);
    tm.lastLapSectors = tm.sectors;
    tm.sectors = [];
    it.sectorAcc = 0;
    tm.lap += 1;
    tm.lastLapTime = lapTime;
    if (tm.bestLapTime == null || lapTime < tm.bestLapTime) tm.bestLapTime = lapTime;
    (tm.lapTimes ??= []).push(lapTime);
    tm.lapStartTime = this.time;
    if (tm.lap >= this.laps) {
      tm.finished = true;
      tm.finishTime = this.time;
      tm.progress = this.laps;
    }
  }

  /** The car passed the start/finish line going backward: undo the last crossing. */
  private crossBackward(car: RaceCar, it: CarInternal): void {
    const tm = car.timing;
    if (tm.lap > 0) {
      tm.lap -= 1;
      if (it.undo) {
        tm.lapStartTime = it.undo.lapStart;
        tm.lastLapTime = it.undo.lastLap;
        tm.bestLapTime = it.undo.best;
        tm.lastLapSectors = it.undo.sectors;
        if (tm.lapTimes && tm.lapTimes.length > 0) tm.lapTimes.pop();
        it.undo = null;
      }
      // Sector bookkeeping of the re-entered lap is lost (it completed already); start fresh.
      tm.sectors = [];
      it.sectorAcc = this.time - tm.lapStartTime;
    } else if (!it.pendingStart) {
      // Rolled back behind the line before completing a lap: lap 1 has not started.
      it.pendingStart = true;
      tm.sectors = [];
      it.sectorAcc = 0;
    }
  }

  // ---- order -----------------------------------------------------------------

  private sortOrder(): void {
    const cars = this.cars;
    this.order.sort((a, b) => {
      const ta = cars[a].timing;
      const tb = cars[b].timing;
      if (ta.finished !== tb.finished) return ta.finished ? -1 : 1;
      if (ta.finished && tb.finished) {
        const d = (ta.finishTime ?? 0) - (tb.finishTime ?? 0);
        if (d !== 0) return d;
        return a - b;
      }
      const d = tb.progress - ta.progress;
      if (d !== 0) return d;
      return a - b;
    });
    this.orderDirty = false;
  }

  // ---- collisions ------------------------------------------------------------

  private collide(): void {
    const cars = this.cars;
    const n = cars.length;
    for (let i = 0; i < n - 1; i++) {
      const a = cars[i];
      const ia = this.internals[i];
      const sa = a.state;
      for (let j = i + 1; j < n; j++) {
        const b = cars[j];
        const ib = this.internals[j];
        const sb = b.state;
        const dx = sb.x - sa.x;
        const dy = sb.y - sa.y;
        const reach = ia.reach + ib.reach;
        if (dx * dx + dy * dy > reach * reach) continue;
        if (Math.abs(sa.z - sb.z) > MAX_CONTACT_Z_GAP) continue;
        for (let ka = 0; ka < 2; ka++) {
          for (let kb = 0; kb < 2; kb++) {
            // positions re-read every pair: an earlier contact may have moved the cars
            const ca = Math.cos(sa.heading);
            const sna = Math.sin(sa.heading);
            const cb = Math.cos(sb.heading);
            const snb = Math.sin(sb.heading);
            const offA = ka === 0 ? ia.frontOff : ia.rearOff;
            const offB = kb === 0 ? ib.frontOff : ib.rearOff;
            const pax = sa.x + offA * ca;
            const pay = sa.y + offA * sna;
            const pbx = sb.x + offB * cb;
            const pby = sb.y + offB * snb;
            const ddx = pbx - pax;
            const ddy = pby - pay;
            const d2 = ddx * ddx + ddy * ddy;
            const rs = ia.radius + ib.radius;
            if (d2 >= rs * rs) continue;
            const d = Math.sqrt(d2);
            let nx: number;
            let ny: number;
            if (d > 1e-6) {
              nx = ddx / d;
              ny = ddy / d;
            } else {
              // Concentric circles (teleported on top of each other): separate along a's left.
              nx = -sna;
              ny = ca;
            }
            const overlap = rs - d;
            const px = pax + nx * (ia.radius - overlap / 2);
            const py = pay + ny * (ia.radius - overlap / 2);
            this.resolveContact(a, b, nx, ny, px, py, overlap);
          }
        }
      }
    }
  }

  private resolveContact(a: RaceCar, b: RaceCar, nx: number, ny: number, px: number, py: number, overlap: number): void {
    const sa = a.state;
    const sb = b.state;
    const specA = a.entry.spec;
    const specB = b.entry.spec;
    const ma = specA.mass > 1 ? specA.mass : 1;
    const mb = specB.mass > 1 ? specB.mass : 1;
    const iza = specA.yawInertia > 0 ? specA.yawInertia : ma * 1.5;
    const izb = specB.yawInertia > 0 ? specB.yawInertia : mb * 1.5;

    // Positional correction split by mass (the light car moves more).
    if (overlap > CONTACT_SLOP) {
      const corr = (overlap - CONTACT_SLOP) * POSITION_CORRECTION;
      const wa = mb / (ma + mb);
      const wb = ma / (ma + mb);
      sa.x -= nx * corr * wa;
      sa.y -= ny * corr * wa;
      sb.x += nx * corr * wb;
      sb.y += ny * corr * wb;
    }

    // Relative velocity of the contact point (world frame, planar).
    const ca = Math.cos(sa.heading);
    const sna = Math.sin(sa.heading);
    const cb = Math.cos(sb.heading);
    const snb = Math.sin(sb.heading);
    const rax = px - sa.x;
    const ray = py - sa.y;
    const rbx = px - sb.x;
    const rby = py - sb.y;
    const vax = sa.vx * ca - sa.vy * sna - sa.yawRate * ray;
    const vay = sa.vx * sna + sa.vy * ca + sa.yawRate * rax;
    const vbx = sb.vx * cb - sb.vy * snb - sb.yawRate * rby;
    const vby = sb.vx * snb + sb.vy * cb + sb.yawRate * rbx;
    const rvx = vbx - vax;
    const rvy = vby - vay;
    const vn = rvx * nx + rvy * ny;
    if (!(vn < 0)) return; // separating (or NaN): the positional correction is all that is needed

    const invA = 1 / ma;
    const invB = 1 / mb;
    const ran = rax * ny - ray * nx;
    const rbn = rbx * ny - rby * nx;
    const kn = invA + invB + (ran * ran) / iza + (rbn * rbn) / izb;
    const jn = (-(1 + COLLISION_RESTITUTION) * vn) / kn;

    const tx = -ny;
    const ty = nx;
    const vt = rvx * tx + rvy * ty;
    const rat = rax * ty - ray * tx;
    const rbt = rbx * ty - rby * tx;
    const kt = invA + invB + (rat * rat) / iza + (rbt * rbt) / izb;
    let jt = -vt / kt;
    const jtMax = COLLISION_FRICTION * jn;
    if (jt > jtMax) jt = jtMax;
    else if (jt < -jtMax) jt = -jtMax;

    const jx = jn * nx + jt * tx;
    const jy = jn * ny + jt * ty;
    applyWorldImpulse(specA, sa, px, py, -jx, -jy);
    applyWorldImpulse(specB, sb, px, py, jx, jy);
    if (jn > a.lastImpact) a.lastImpact = jn;
    if (jn > b.lastImpact) b.lastImpact = jn;
  }
}

/** Give a settled, stationary state a forward speed (rolling start): body velocity, wheel spin, a sensible gear. */
function launchAtSpeed(spec: VehicleSpec, state: VehicleState, v: number): void {
  state.vx = v;
  state.speed = v;
  const rF = spec.tires.front.radius > 0.05 ? spec.tires.front.radius : 0.3;
  const rR = spec.tires.rear.radius > 0.05 ? spec.tires.rear.radius : 0.3;
  state.wheels[0].omega = v / rF;
  state.wheels[1].omega = v / rF;
  state.wheels[2].omega = v / rR;
  state.wheels[3].omega = v / rR;
  const dtr = spec.drivetrain;
  const n = dtr.gearRatios.length;
  let gear = Math.max(1, n);
  const rad = 0.5 * (rF + rR);
  for (let g = 1; g <= n; g++) {
    if (rpmFromWheelSpeed(dtr, g, v / rad) <= 0.8 * spec.engine.redlineRpm) {
      gear = g;
      break;
    }
  }
  state.gear = gear;
  state.engineRpm = Math.max(spec.engine.idleRpm, rpmFromWheelSpeed(dtr, gear, v / rad));
}

export function createRace(config: RaceConfig): Race {
  return new RaceImpl(config);
}

/**
 * Results table in race order: finished cars first (by finish time, with the gap to the winner), then
 * the cars still running (by progress, with whole laps down on the leader).
 */
export function raceSummary(race: Race): RaceResultRow[] {
  const snap = race.snapshot();
  const cars = race.cars;
  const leader = snap.order.length > 0 ? cars[snap.order[0]] : null;
  const winner = leader && leader.timing.finished ? leader : null;
  return snap.order.map((idx, r) => {
    const car = cars[idx];
    const tm = car.timing;
    let gap: number | null = null;
    let lapsDown = 0;
    let total: string;
    if (tm.finished && tm.finishTime != null) {
      gap = winner && winner.timing.finishTime != null ? tm.finishTime - winner.timing.finishTime : 0;
      total = r === 0 || !winner ? fmtTime(tm.finishTime) : `+${gap.toFixed(3)}`;
    } else {
      lapsDown = leader ? Math.max(0, Math.floor(leader.timing.progress - tm.progress)) : 0;
      total = lapsDown >= 1 ? `+${lapsDown} lap${lapsDown === 1 ? '' : 's'}` : 'running';
    }
    return {
      position: r + 1,
      index: idx,
      name: car.entry.name,
      color: car.entry.spec.color,
      laps: tm.lap,
      bestLapTime: tm.bestLapTime,
      lastLapTime: tm.lastLapTime,
      finished: tm.finished,
      finishTime: tm.finishTime,
      gap,
      lapsDown,
      resets: tm.resets ?? 0,
      total,
    };
  });
}
