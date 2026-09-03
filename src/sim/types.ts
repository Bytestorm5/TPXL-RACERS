/**
 * RACERS — shared simulation contracts.
 *
 * All units are SI unless stated: metres, kilograms, seconds, newtons, radians,
 * degrees Celsius for temperatures, watts, joules. Angles positive counter-clockwise.
 *
 * World frame: x east, y north, z up (2D top-down with elevation). Heading 0 = +x.
 * Body frame: x forward, y LEFT, z up. Positive yaw rate = turning left.
 *
 * Layering:
 *   design/  CarBuild (player choices)  --compileBuild-->  VehicleSpec (pure physical parameters)
 *   sim/     VehicleSpec + VehicleState + DriverInput + RoadQuery  --stepVehicle-->  VehicleState
 *   The simulation NEVER reads a CarBuild. The designer NEVER reads sim internals except via VehicleSpec.
 */

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export type SurfaceKind =
  | 'asphalt'
  | 'concrete'
  | 'wet_asphalt'
  | 'curb'
  | 'gravel'
  | 'dirt'
  | 'grass'
  | 'sand'
  | 'snow'
  | 'ice';

export interface SurfaceProps {
  kind: SurfaceKind;
  /** Friction multiplier relative to dry asphalt (= 1.0) for a generic road tyre. */
  grip: number;
  /** Rolling resistance coefficient added to the tyre's own. */
  rollingResistance: number;
  /** 0..1 — vertical load noise / bumpiness. */
  roughness: number;
  /** Extra velocity-proportional drag force per kg of car (m/s^2 per m/s), e.g. sand, snow. */
  drag: number;
  /** Loose surfaces reward higher slip: multiplier on the slip angle/ratio at which grip peaks. */
  peakSlipScale: number;
  /** Loose surfaces have a flatter falloff past the peak (0..1, 1 = no falloff). */
  slideRetention: number;
}

// ---------------------------------------------------------------------------
// Tyres
// ---------------------------------------------------------------------------

/**
 * Physical description of one tyre (one axle shares a spec). Produced by design/compile
 * from compound + width + pressure + camber choices. All grip figures are for dry asphalt.
 */
export interface TireSpec {
  /** Peak friction coefficient at `optimalLoad`, at optimal temperature, zero camber, dry asphalt. */
  peakMu: number;
  /**
   * Load (N) at which the tyre delivers `peakMu`. Below this the carcass is under-worked
   * (grip coefficient reduced by `underloadPenalty`); above it grip coefficient falls with
   * `loadSensitivity`. Lower pressure and wider tyres raise this figure.
   */
  optimalLoad: number;
  /** 0..0.5 — fractional loss of mu per +100% load above optimalLoad (linear-in-ratio falloff). */
  loadSensitivity: number;
  /** 0..1 — fractional loss of mu at zero load, approaching optimalLoad quadratically. */
  underloadPenalty: number;
  /** Slip angle (rad) at which lateral force peaks at optimalLoad and optimal temp. */
  peakSlipAngle: number;
  /** Slip ratio at which longitudinal force peaks. */
  peakSlipRatio: number;
  /** Sliding friction as fraction of peak (force past the peak decays toward this). */
  slideMuRatio: number;
  /** Cornering stiffness per unit load (1/rad): Fy ≈ corneringStiffnessPerLoad * Fz * alpha at small alpha. */
  corneringStiffnessPerLoad: number;
  /** Longitudinal stiffness per unit load (dimensionless): Fx ≈ longStiffnessPerLoad * Fz * kappa at small kappa. */
  longStiffnessPerLoad: number;
  /** Temperature (°C) at which grip peaks. */
  optimalTemp: number;
  /** Half-width (°C) of the grip window: at optimalTemp ± tempWindow grip is ~75% of peak. */
  tempWindow: number;
  /** Fraction of peak grip retained far outside the temperature window (0..1). */
  coldGripFloor: number;
  /** °C per joule of slip energy absorbed (higher = heats faster; soft compounds & low pressure heat faster). */
  heatingPerJoule: number;
  /** Cooling coefficient: dT/dt = -coolingRate * (1 + speed/20) * (T - ambient). Units 1/s. */
  coolingRate: number;
  /** Wear accrued per joule of slip energy (0..1 scale over a race distance). */
  wearPerJoule: number;
  /** Fraction of peak grip lost at wear = 1. */
  wearGripLoss: number;
  /** Tyre rolling resistance coefficient on asphalt. */
  rollingResistance: number;
  /** Loaded radius (m). */
  radius: number;
  /** Section width (m). */
  width: number;
  /** Static camber (rad); negative = top of tyre leaning inward (typical race setting). */
  camber: number;
  /** Camber at which lateral grip is maximised (rad, negative) — depends on compound/carcass. */
  optimalCamber: number;
  /** Fractional lateral grip gain at optimal camber vs 0 camber; longitudinal grip loses the same fraction at that camber. */
  camberGain: number;
  /** Multiplier of grip per surface kind, relative to the surface's own generic `grip` (rally tyres > 1 on gravel, slicks < 1). */
  surfaceAffinity: Partial<Record<SurfaceKind, number>>;
  /** Wheel + tyre mass (kg), used for unsprung mass and rotational inertia. */
  mass: number;
}

export interface TireInput {
  /** Normal load (N), >= 0. */
  load: number;
  /** Slip angle (rad): angle between wheel heading and contact patch velocity. Positive = velocity is to the LEFT of wheel heading → produces force to the RIGHT (negative fy)? NO: see convention below. */
  slipAngle: number;
  /** Slip ratio: (omega * r - vx) / max(|vx|, eps). Positive = driving, negative = braking. */
  slipRatio: number;
  /** Effective camber (rad) including static camber. */
  camber: number;
  surface: SurfaceProps;
  temp: number;
  wear: number;
  /** Contact patch longitudinal speed (m/s), used for slip power. */
  speed: number;
}

/**
 * Sign convention for tyre forces:
 *   slipAngle = atan2(vy_wheel, |vx_wheel|) in the wheel frame (y left).
 *   The tyre pushes AGAINST the slip, so fy has the OPPOSITE sign to slipAngle.
 *   fx has the SAME sign as slipRatio.
 */
export interface TireOutput {
  /** Longitudinal force at contact patch, wheel frame (N). */
  fx: number;
  /** Lateral force at contact patch, wheel frame (N), positive left. */
  fy: number;
  /** Effective peak friction coefficient at this load/temp/surface/camber. */
  muPeak: number;
  /** Maximum total force the tyre could produce right now (N) = muPeak * load. */
  maxForce: number;
  /** 0..1+ : |F| / maxForce ; > ~1 means sliding past the peak. */
  utilisation: number;
  /** Power dissipated in slip (W) — drives heating and wear. */
  slipPower: number;
}

export interface TireState {
  temp: number;
  wear: number;
}

// ---------------------------------------------------------------------------
// Brakes
// ---------------------------------------------------------------------------

export interface BrakeSpec {
  /** Torque at the wheel at full pedal with cold pads (Nm). */
  maxTorque: number;
  /** Thermal mass of disc + pad (J/°C). */
  heatCapacity: number;
  /** Convective cooling W/°C at rest; multiplied by (1 + speed/15) — ducts increase this. */
  coolingCoeff: number;
  /** Fraction of absorbed kinetic energy that enters the disc (rest to air/hub). ~0.9. */
  heatAbsorption: number;
  /** Below this temperature the pad is at full effectiveness (°C). */
  fadeStartTemp: number;
  /** At this temperature effectiveness has fallen to `fadeMinFactor` (°C). */
  fadeEndTemp: number;
  /** Minimum effectiveness fraction when fully faded (0..1). */
  fadeMinFactor: number;
  /** Cold pads (street pads are fine cold; race pads need heat): effectiveness at ambient (0..1). */
  coldFactor: number;
  /** Temperature at which cold pads reach full bite (°C). */
  coldBiteTemp: number;
  /** Disc + caliper mass (kg) — feeds unsprung mass in compile. */
  mass: number;
}

export interface BrakeState {
  temp: number;
}

// ---------------------------------------------------------------------------
// Engine & drivetrain
// ---------------------------------------------------------------------------

export interface EngineSpec {
  /** Full-throttle torque curve as [rpm, Nm] sorted by rpm; linearly interpolated, clamped at ends. */
  torqueCurve: Array<[number, number]>;
  idleRpm: number;
  redlineRpm: number;
  /** Fuel cut / hard limiter above this rpm. */
  limiterRpm: number;
  /** Rotational inertia of crank + flywheel (kg·m²). */
  inertia: number;
  /** Engine braking torque at redline with closed throttle (Nm), scaled linearly with rpm. */
  engineBrakingTorque: number;
  /** Throttle response first-order time constant (s). Turbo lag lives here for boosted engines. */
  throttleResponse: number;
  /** Peak power (W) — derived, for display and autotune. */
  peakPower: number;
  /** RPM at peak power — derived. */
  peakPowerRpm: number;
  /** Peak torque (Nm) — derived. */
  peakTorque: number;
  peakTorqueRpm: number;
  mass: number;
}

export type DriveLayout = 'FWD' | 'RWD' | 'AWD';
export type DiffType = 'open' | 'lsd' | 'locked';

export interface DiffSpec {
  type: DiffType;
  /** LSD lock fraction under power (0 = open, 1 = locked). Ignored for open/locked. */
  powerLock: number;
  /** LSD lock fraction under engine braking / coast. */
  coastLock: number;
}

export interface DrivetrainSpec {
  layout: DriveLayout;
  /** Fraction of engine torque sent to the front axle (0 for RWD, 1 for FWD, e.g. 0.4 for AWD). */
  frontTorqueSplit: number;
  /** Gear ratios, 1st gear first (e.g. [3.2, 2.1, 1.5, 1.1, 0.9]). */
  gearRatios: number[];
  finalDrive: number;
  /** Time during which no torque is transmitted on a shift (s). */
  shiftTime: number;
  /** Mechanical efficiency 0..1. */
  efficiency: number;
  frontDiff: DiffSpec;
  rearDiff: DiffSpec;
  /** Automatic gearbox shifts for the driver when true (AI always auto-shifts). */
  autoShift: boolean;
  /** Drivetrain rotational inertia referred to the wheels (kg·m²), adds to wheel inertia. */
  inertia: number;
  mass: number;
}

// ---------------------------------------------------------------------------
// Aero, suspension, steering
// ---------------------------------------------------------------------------

export interface AeroSpec {
  /** Drag coefficient × frontal area (m²). F_drag = 0.5 ρ v² CdA. */
  dragArea: number;
  /** Downforce coefficient × area at the front axle (m²), positive = pushes down. */
  liftAreaFront: number;
  /** Downforce coefficient × area at the rear axle (m²). */
  liftAreaRear: number;
  /**
   * Ground-effect sensitivity: underbody downforce multiplied by
   * (1 + rideHeightSensitivity * (refRideHeight - rideHeight)/refRideHeight), clamped ≥ 0.2.
   */
  rideHeightSensitivity: number;
  refRideHeight: number;
}

export interface SuspensionSpec {
  /** Wheel-rate spring stiffness (N/m) per wheel. */
  springRateFront: number;
  springRateRear: number;
  /** Anti-roll bar stiffness contribution to axle roll stiffness (Nm/rad). */
  arbFront: number;
  arbRear: number;
  /** Total axle roll stiffness (Nm/rad) = springs + ARB — derived by compile. */
  rollStiffnessFront: number;
  rollStiffnessRear: number;
  /** Damping ratio 0.2..1.2 per axle. Governs how fast load transfer settles (transient balance). */
  dampingFront: number;
  dampingRear: number;
  /** Static ride height (m) per axle. Affects CG height and aero. */
  rideHeightFront: number;
  rideHeightRear: number;
  /** Suspension travel before bump stop (m). Bottoming out spikes load. */
  travel: number;
  /** Roll centre heights (m) per axle — geometric load transfer path. */
  rollCentreFront: number;
  rollCentreRear: number;
}

export interface SteeringSpec {
  /** Maximum road-wheel steer angle (rad). */
  maxSteerAngle: number;
  /** 0..1 — fraction of Ackermann geometry (inner wheel steers more). */
  ackermann: number;
  /** Speed-sensitive steer limiting for playability: at `fullLockSpeed` m/s only `highSpeedLockFraction` of lock is available (linear between). 0 disables. */
  fullLockSpeed: number;
  highSpeedLockFraction: number;
}

// ---------------------------------------------------------------------------
// Vehicle
// ---------------------------------------------------------------------------

export interface VehicleSpec {
  id: string;
  name: string;
  /** Total mass incl. driver and fuel (kg). */
  mass: number;
  /** CG height above ground at static ride height (m). */
  cgHeight: number;
  wheelbase: number;
  trackFront: number;
  trackRear: number;
  /** Distance from CG to FRONT axle (m). Rear = wheelbase - cgToFront. */
  cgToFront: number;
  /** Yaw moment of inertia (kg·m²). */
  yawInertia: number;
  /** Unsprung mass per wheel (kg) — informational for load calc. */
  unsprungMassFront: number;
  unsprungMassRear: number;
  /** Body length/width (m) for collision & rendering. */
  length: number;
  width: number;
  aero: AeroSpec;
  suspension: SuspensionSpec;
  steering: SteeringSpec;
  tires: { front: TireSpec; rear: TireSpec };
  brakes: {
    front: BrakeSpec;
    rear: BrakeSpec;
    /** Fraction of pedal torque to the front axle (0..1). */
    bias: number;
    abs: boolean;
    /** Wheel inertia per wheel (kg·m²) incl. tyre & disc. */
    wheelInertiaFront: number;
    wheelInertiaRear: number;
    /** Handbrake torque on rear wheels (Nm). */
    handbrakeTorque: number;
  };
  engine: EngineSpec;
  drivetrain: DrivetrainSpec;
  /** Cosmetic colour for rendering (CSS colour string). */
  color: string;
}

export interface DriverInput {
  throttle: number; // 0..1
  brake: number; // 0..1
  /** -1 (full right) .. +1 (full left) at the steering wheel; mapped to road-wheel angle via SteeringSpec. */
  steer: number;
  handbrake: number; // 0..1
  shiftUp: boolean; // edge-triggered
  shiftDown: boolean; // edge-triggered
}

export type WheelIndex = 0 | 1 | 2 | 3; // FL, FR, RL, RR

export interface WheelState {
  /** Angular velocity (rad/s). */
  omega: number;
  /** Normal load (N). */
  load: number;
  slipAngle: number;
  slipRatio: number;
  /** Wheel-frame forces (N). */
  fx: number;
  fy: number;
  /** Road-wheel steer angle (rad). */
  steer: number;
  tire: TireState;
  brake: BrakeState;
  /** Wheel is locked under braking (omega ≈ 0 while moving). */
  locked: boolean;
  /** Wheel is spinning under power (slipRatio well past peak). */
  spinning: boolean;
  /** 0..1+ friction utilisation this step. */
  utilisation: number;
  surface: SurfaceKind;
  /** World position of the contact patch (for rendering skid marks). */
  x: number;
  y: number;
  /** Brake torque applied this step (Nm) and drive torque (Nm), for telemetry. */
  brakeTorque: number;
  driveTorque: number;
}

export interface VehicleState {
  /** World position of the CG projected on the ground. */
  x: number;
  y: number;
  z: number;
  /** Heading (rad), 0 = +x, CCW positive. */
  heading: number;
  /** Body-frame velocity (m/s): vx forward, vy left. */
  vx: number;
  vy: number;
  /** Yaw rate (rad/s), CCW positive. */
  yawRate: number;
  /** Body-frame accelerations this step (m/s²) — for load transfer & telemetry. */
  ax: number;
  ay: number;
  /** Filtered lateral/longitudinal load transfer actually applied (N) — lags ax/ay by damping. */
  loadTransferLong: number;
  loadTransferLatFront: number;
  loadTransferLatRear: number;
  wheels: [WheelState, WheelState, WheelState, WheelState];
  engineRpm: number;
  /** Filtered throttle 0..1 after response lag. */
  throttleEffective: number;
  /** Current gear, 1-based; 0 = neutral, -1 = reverse. */
  gear: number;
  /** Seconds remaining in the current shift (no torque). */
  shiftTimer: number;
  /** Last driver input, echoed for telemetry. */
  input: DriverInput;
  /** Ground-speed magnitude (m/s). */
  speed: number;
  /** Convenience: true if any wheel is off the main track surface. */
  offTrack: boolean;
  /** Road info under the CG this step. */
  road: RoadSample;
  /** Accumulated distance travelled (m). */
  odometer: number;
  /** Time simulated (s). */
  time: number;
}

// ---------------------------------------------------------------------------
// Road / environment query (implemented by track.ts; consumed by vehicle.ts)
// ---------------------------------------------------------------------------

export interface RoadSample {
  /** Ground elevation at the query point (m). */
  z: number;
  /**
   * Road pitch along the query heading (rad): positive = uphill in the heading direction.
   * Gravity component along body x = -g * sin(gradeAlong).
   */
  gradeAlong: number;
  /**
   * Road roll about the heading axis (rad): positive = the RIGHT side of the road is higher
   * (a road banked to help a LEFT turn). Gravity component along body y (left) = +g * sin(bankAcross).
   */
  bankAcross: number;
  surface: SurfaceProps;
  /** True if the point is within the main track width. */
  onTrack: boolean;
  /** Track arc-length coordinate of the nearest centreline point (m). */
  s: number;
  /** Lateral offset from centreline (m), positive LEFT of travel direction. */
  lateral: number;
  /** Track half-width at s (m). */
  halfWidth: number;
  /** Centreline heading at s (rad). */
  trackHeading: number;
  /** Signed curvature at s (1/m), positive = left turn. */
  curvature: number;
}

export interface RoadQuery {
  /** Sample the road at a world point, oriented along `heading`. Must be cheap (called 5×/vehicle/step). */
  sampleAt(x: number, y: number, heading: number): RoadSample;
  ambientTemp: number;
  /** Air density kg/m³ (1.225 sea level). */
  airDensity: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const G = 9.81;
export const AIR_DENSITY = 1.225;
export const DEFAULT_AMBIENT_TEMP = 22;
