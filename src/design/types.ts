/**
 * RACERS — car design contracts (player-facing).
 *
 * A CarBuild is what the player edits in the garage. It is a mix of discrete part choices
 * and continuous settings. `compileBuild()` turns it into a VehicleSpec with real physical
 * parameters; nothing in the simulation reads a CarBuild.
 *
 * Design principle: no abstract 0-100 "handling" or "braking" stats. Every knob maps to
 * something physical, and the ANALYSIS (design/analyze.ts) explains the consequences
 * (e.g. "front brakes lock before the rear at 1.1 g", "rear tyres are under-loaded until
 * you carry more weight rearward").
 */

export type ChassisSize = 'kei' | 'compact' | 'mid' | 'large' | 'truck';
export type ChassisMaterial = 'steel' | 'aluminium' | 'carbon';
export type EnginePosition = 'front' | 'front-mid' | 'mid' | 'rear';
export type Aspiration = 'na' | 'turbo' | 'supercharged';
export type EngineTune = 'economy' | 'street' | 'sport' | 'race';
export type TireCompoundId =
  | 'street'      // long life, low grip, wide temp window, good cold
  | 'sport'       // street+grip
  | 'semi_slick'  // track day
  | 'slick_hard'
  | 'slick_medium'
  | 'slick_soft'  // huge grip, narrow temp window, wears fast
  | 'rally_gravel'// knobby: strong on loose surfaces, weak on asphalt, loves slip
  | 'rally_tarmac'
  | 'snow'        // studded-ish
  | 'drift';      // hard, wide slip curve, slow heat
export type PadCompound = 'street' | 'sport' | 'race' | 'carbon_ceramic';
export type Underbody = 'none' | 'flat' | 'diffuser';
export type DiffChoice = 'open' | 'lsd_1way' | 'lsd_1_5way' | 'lsd_2way' | 'locked';

export interface TireSetup {
  compound: TireCompoundId;
  /** Section width (mm), 155..355. Wider = higher optimal load, more grip, more drag/mass. */
  width: number;
  /** Cold pressure (kPa), 120..320. Lower = higher optimal load & more heat; higher = less rolling resistance, less peak grip. */
  pressure: number;
  /** Static camber (deg), -6..+2. */
  camber: number;
  /** Rim diameter (inch) 13..20 — affects radius, unsprung mass, brake disc room. */
  rim: number;
}

export interface CarBuild {
  /** Schema version for save files. */
  format: 1;
  id: string;
  name: string;
  color: string;

  chassis: {
    size: ChassisSize;
    material: ChassisMaterial;
    enginePosition: EnginePosition;
    /** 0..1 — interior stripping, lightweight panels. Removes mass, raises cost of nothing (no economy yet). */
    weightReduction: number;
    /** Ballast mass (kg) 0..200 and its longitudinal position -1 (rear axle) .. +1 (front axle). */
    ballastMass: number;
    ballastPosition: number;
    /** Driver + fuel are fixed: 80 kg driver, fuel load kg 10..80 (in the tank behind the CG). */
    fuel: number;
  };

  engine: {
    /** Displacement (litres) 0.6..8.0. */
    displacement: number;
    cylinders: 3 | 4 | 5 | 6 | 8 | 10 | 12;
    aspiration: Aspiration;
    /** Boost pressure (bar gauge) 0.3..2.0 for turbo/supercharged. Ignored for NA. */
    boost: number;
    /** Where the cam/intake is tuned to breathe: shifts the torque peak. */
    tune: EngineTune;
    /** Redline (rpm) 4500..11000. Raising it past what the tune supports gains nothing but heat/inertia. */
    redline: number;
    /** Flywheel: 'light' (fast response, harder launches) | 'standard' | 'heavy'. */
    flywheel: 'light' | 'standard' | 'heavy';
  };

  drivetrain: {
    layout: 'FWD' | 'RWD' | 'AWD';
    /** AWD only: fraction of torque to the front, 0.2..0.7. */
    awdFrontSplit: number;
    /** Number of forward gears 3..8. */
    gears: number;
    /** Explicit ratios (length must equal `gears`); if omitted, geometric spread from `firstGear` to `topGear`. */
    gearRatios?: number[];
    firstGear: number;
    topGear: number;
    finalDrive: number;
    frontDiff: DiffChoice;
    rearDiff: DiffChoice;
    /** 'manual' requires shift inputs; 'auto' shifts near peak power. */
    gearbox: 'manual' | 'auto';
  };

  tires: { front: TireSetup; rear: TireSetup };

  suspension: {
    /** Spring rate (N/mm) per wheel, 15..250. */
    springFront: number;
    springRear: number;
    /** Anti-roll bar stiffness (0..1 slider mapped to 0..2000 Nm/deg… see compile). */
    arbFront: number;
    arbRear: number;
    /** Damping ratio 0.2..1.2. */
    damperFront: number;
    damperRear: number;
    /** Ride height (mm) 40..250. */
    rideHeightFront: number;
    rideHeightRear: number;
    /** Steering lock (deg at road wheel) 20..60. */
    steeringLock: number;
  };

  brakes: {
    /** Disc diameter (mm) 240..420 — limited by rim size (rim_inch*25.4 - 60). */
    discFront: number;
    discRear: number;
    pads: PadCompound;
    /** Front share of the total brake torque (bias bar), 0.5..0.9. */
    bias: number;
    abs: boolean;
    /** Brake cooling ducts 0..1. */
    ducts: number;
  };

  aero: {
    /** Front splitter 0..1. */
    splitter: number;
    /** Rear wing angle 0..1 (0 = none). */
    wing: number;
    underbody: Underbody;
    /** Body drag tweak: 'streamlined' | 'standard' | 'boxy'. */
    body: 'streamlined' | 'standard' | 'boxy';
  };
}

/** Continuous field ranges, used by UI sliders, validation and auto-tune search. */
export interface FieldRange {
  min: number;
  max: number;
  step: number;
  unit: string;
  label: string;
  hint: string;
}

/** Warnings and metrics explaining what a build will do. Produced by design/analyze.ts. */
export interface BuildAnalysis {
  metrics: {
    massKg: number;
    frontWeightFraction: number;
    peakPowerKw: number;
    peakTorqueNm: number;
    powerToWeightWkg: number;
    /** Estimated 0-100 km/h (s) from a quasi-static launch model incl. traction limits. */
    accel0to100s: number;
    /** Estimated top speed (km/h) — min(drag-limited, gearing-limited). */
    topSpeedKmh: number;
    /** Steady-state lateral grip on dry asphalt (g) at the balanced limit. */
    skidpadG: number;
    /** 100-0 km/h braking distance (m) with the current bias, incl. lockup penalty. */
    brakingDistance100m: number;
    /** Max deceleration before the first axle locks (g) — bias quality. */
    lockupG: number;
    /** Which axle locks first: 'front' | 'rear' | 'balanced'. */
    lockupAxle: 'front' | 'rear' | 'balanced';
    /** Understeer gradient (deg/g). > 0 understeer, < 0 oversteer. */
    understeerGradientDegPerG: number;
    /** Estimated brake temperature after 10 hard stops (°C) → fade risk. */
    brakeTempAfterStopsC: number;
    /** Fraction of engine torque that the driven wheels can put down in 1st gear (>1 = traction-limited). */
    tractionUse1stGear: number;
    /** Aero balance: fraction of downforce on the front at 200 km/h. */
    aeroBalanceFront: number;
    /** Downforce (N) at 200 km/h. */
    downforce200N: number;

    // --- optional extras (added by design/analyze.ts; UI must tolerate their absence) ---
    /** Lateral acceleration (g) at which the car would roll over, reduced by body roll at the limit. */
    rolloverG?: number;
    /** Strut force at full bump travel / static corner load — how hard a jump landing hits. */
    jumpLandingG?: number;
    /** (ay_rear − ay_front)/max(...): > 0 the front gives up first (understeer at the limit). */
    limitBalance?: number;
    /** Which axle reaches its lateral limit first on the skidpad. */
    limitAxle?: 'front' | 'rear';
    /** Per-axle skidpad limits (g). */
    skidpadFrontG?: number;
    skidpadRearG?: number;
    /** Linear-range part of the understeer gradient (deg/g), from cornering stiffness per load only. */
    understeerLinearDegPerG?: number;
    /** Slip-angle part of the understeer gradient (deg/g) at 90 % of the limit, from the tyre curves. */
    understeerSlipDegPerG?: number;
    /** Limit part of the understeer gradient (deg/g): how much earlier the front axle saturates. */
    understeerLimitDegPerG?: number;
    /** Ideal (CVT) drag-limited top speed (km/h): what the gearing could reach at best. */
    topSpeedDragLimitedKmh?: number;
    /** True when the top speed is set by the rev limiter in top gear rather than by drag. */
    topSpeedGearingLimited?: boolean;
    /** Road speed at the limiter in 1st gear (km/h). */
    firstGearLimiterKmh?: number;
    /** Which axle's discs are hotter after the 10-stop test. */
    brakeHotAxle?: 'front' | 'rear';
    /** Rear-axle utilisation (demand/capacity) at the moment the first axle locks. */
    lockupRearUtilisation?: number;
    /** Front-axle utilisation at the moment the first axle locks. */
    lockupFrontUtilisation?: number;
    /** Hook for a future lap-time estimate on the reference track (s). Not computed yet. */
    lapTimeEstimateS?: number;
  };
  warnings: BuildWarning[];
  /** Short natural-language character summary ("Front-heavy, understeers at the limit, brakes fade after 6 laps"). */
  summary: string;
}

export interface BuildWarning {
  severity: 'info' | 'warning' | 'danger';
  /** Which part of the build this is about. */
  area: 'chassis' | 'engine' | 'drivetrain' | 'tires' | 'suspension' | 'brakes' | 'aero';
  message: string;
  /** Optional auto-fix identifier that autotune.ts understands (e.g. 'brakeBias', 'gears', 'balance'). */
  fix?: AutoTuneTarget;
}

export type AutoTuneTarget =
  | 'brakeBias'    // set bias so both axles reach the limit together
  | 'gears'        // choose ratios for launch + top speed on the reference track
  | 'balance'      // ARB/springs for target handling balance
  | 'pressures'    // set tyre pressures so optimal load ≈ actual load
  | 'aero'         // balance downforce with weight distribution
  | 'camber'       // pick camber for the compound
  | 'dampers'      // damping ratio sanity
  | 'all';

export type HandlingIntent = 'stable' | 'neutral' | 'lively' | 'drift';
