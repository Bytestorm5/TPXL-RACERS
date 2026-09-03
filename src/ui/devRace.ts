/**
 * FREE-RUN FALLBACK race — used ONLY while src/sim/race.ts is still a stub (createRace throws
 * 'TODO'). It drives the player's car with the real vehicle model (stepVehicle) on the real track
 * and keeps lap timing, so the race screen, HUD, telemetry and input can be exercised. No AI, no
 * collisions, no grid for other cars. Remove once createRace is implemented (raceView.ts only
 * reaches for it when createRace throws a TODO error).
 */
import type { CarTiming, Race, RaceCar, RaceConfig, RaceSnapshot } from '../sim/race';
import type { DriverInput } from '../sim/types';
import { createVehicleState, NEUTRAL_INPUT, resetVehicleState, SIM_DT, stepVehicle } from '../sim/vehicle';

const COUNTDOWN_S = 3;
const MAX_SUBSTEPS = 8;
const HOLD_INPUT: DriverInput = { ...NEUTRAL_INPUT, brake: 1 };

export function createFallbackRace(config: RaceConfig): Race {
  const track = config.track;
  const entry = config.entries.find((e) => e.driver.kind === 'player') ?? config.entries[0];
  if (!entry) throw new Error('fallback race: no entries');
  const spec = entry.spec;
  const slot = track.gridSlot(0);
  const state = createVehicleState(spec, { x: slot.x, y: slot.y, heading: slot.heading }, track);
  const timing: CarTiming = {
    lap: 0,
    lapStartTime: 0,
    lastLapTime: null,
    bestLapTime: null,
    progress: 0,
    finished: false,
    finishTime: null,
    sectors: [],
  };
  const car: RaceCar = { index: 0, entry, state, timing, input: { ...NEUTRAL_INPUT }, lastImpact: 0 };
  const cars = [car];
  const closed = track.spec.closed;
  const L = track.length;
  const laps = Math.max(1, config.laps);

  let time = 0;
  let countdown = COUNTDOWN_S;
  let started = false;
  let finished = false;
  let acc = 0;
  let lastS = track.startLine;
  let lastFrac = 0;
  /** Grid slots sit behind the line: the first crossing STARTS lap 1 instead of completing one. */
  let pendingStart = false;
  const input: DriverInput = { ...NEUTRAL_INPUT };
  const order = [0];
  const snap: RaceSnapshot = { time: 0, order, cars, countdown, started, finished };

  const lapFrac = (s: number): number => {
    if (!(L > 0)) return 0;
    let d = s - track.startLine;
    if (closed) d = ((d % L) + L) % L;
    return d / L;
  };

  const substep = (): void => {
    if (!started) {
      countdown -= SIM_DT;
      stepVehicle(spec, state, HOLD_INPUT, track, SIM_DT);
      if (countdown <= 0) {
        countdown = 0;
        started = true;
        timing.lapStartTime = time;
        const p = track.project(state.x, state.y, lastS);
        lastS = p.s;
        lastFrac = lapFrac(p.s);
        pendingStart = closed && lastFrac > 0.5;
      }
    } else {
      stepVehicle(spec, state, input, track, SIM_DT);
      const proj = track.project(state.x, state.y, lastS);
      lastS = proj.s;
      const frac = lapFrac(proj.s);
      if (!finished) {
        if (closed) {
          if (lastFrac > 0.8 && frac < 0.2 && pendingStart) {
            pendingStart = false;
            timing.lapStartTime = time; // lap 1 begins at the line
          } else if (lastFrac > 0.8 && frac < 0.2) {
            timing.lap += 1;
            const lapTime = time - timing.lapStartTime;
            timing.lastLapTime = lapTime;
            if (timing.bestLapTime == null || lapTime < timing.bestLapTime) timing.bestLapTime = lapTime;
            timing.lapStartTime = time;
            if (timing.lap >= laps) {
              finished = true;
              timing.finished = true;
              timing.finishTime = time;
            }
          } else if (lastFrac < 0.2 && frac > 0.8) {
            if (timing.lap > 0) timing.lap -= 1; // rolled back over the line
            else pendingStart = true;
          }
        } else if (proj.s >= L - 0.5) {
          finished = true;
          timing.finished = true;
          timing.finishTime = time;
          timing.lastLapTime = time - timing.lapStartTime;
          timing.bestLapTime = timing.lastLapTime;
          timing.lap = 1;
        }
        timing.progress = timing.lap + (pendingStart ? frac - 1 : frac);
      }
      lastFrac = frac;
    }
    time += SIM_DT;
  };

  return {
    config,
    cars,
    get time() {
      return time;
    },
    setPlayerInput(i: DriverInput): void {
      input.throttle = i.throttle;
      input.brake = i.brake;
      input.steer = i.steer;
      input.handbrake = i.handbrake;
      input.shiftUp = i.shiftUp;
      input.shiftDown = i.shiftDown;
      car.input = input;
    },
    step(dt: number): void {
      if (!(dt > 0)) return;
      acc += dt;
      let n = 0;
      while (acc >= SIM_DT && n < MAX_SUBSTEPS) {
        substep();
        acc -= SIM_DT;
        n++;
      }
      if (n >= MAX_SUBSTEPS) acc = 0; // slow-motion rather than a spiral
    },
    snapshot(): RaceSnapshot {
      snap.time = time;
      snap.countdown = countdown;
      snap.started = started;
      snap.finished = finished;
      return snap;
    },
    start(): void {
      started = true;
      countdown = 0;
      timing.lapStartTime = time;
    },
    resetCar(): void {
      const proj = track.project(state.x, state.y, lastS);
      const pose = track.poseAt(proj.s, 0);
      resetVehicleState(spec, state, { x: pose.x, y: pose.y, heading: pose.heading }, track);
      lastS = proj.s;
      lastFrac = lapFrac(proj.s);
    },
  };
}
