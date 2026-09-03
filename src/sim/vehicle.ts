/**
 * Vehicle dynamics — STUB (to be implemented).
 *
 * Planar 4-wheel model (3 DOF body: vx, vy, yawRate) with:
 *  - per-wheel normal load: static + longitudinal transfer + lateral transfer split by roll stiffness,
 *    + aero, + road bank/grade gravity components, + load-transfer lag from damping,
 *  - tyre forces from tire.ts, per-wheel surface from RoadQuery,
 *  - quasi-static wheel torque balance: brake/drive torque vs tyre capacity → lockup / wheelspin,
 *    ABS modulation when enabled,
 *  - engine + gearbox + differentials from engine.ts / drivetrain.ts,
 *  - aero from aero.ts.
 *
 * Fixed-step integration; call with dt = SIM_DT (subdivided internally if needed).
 */
import type { DriverInput, RoadQuery, VehicleSpec, VehicleState } from './types';

/** Recommended fixed simulation step (s). */
export const SIM_DT = 1 / 120;

export interface Pose {
  x: number;
  y: number;
  heading: number;
}

export function createVehicleState(spec: VehicleSpec, pose: Pose, road: RoadQuery): VehicleState {
  throw new Error('TODO createVehicleState');
}

/** Advance one fixed step. Mutates and returns `state`. */
export function stepVehicle(spec: VehicleSpec, state: VehicleState, input: DriverInput, road: RoadQuery, dt: number): VehicleState {
  throw new Error('TODO stepVehicle');
}

/** Static axle loads (N) on level ground, no aero: [front, rear]. */
export function staticAxleLoads(spec: VehicleSpec): [number, number] {
  throw new Error('TODO staticAxleLoads');
}

export const NEUTRAL_INPUT: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false };
