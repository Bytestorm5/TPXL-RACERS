/**
 * Build → VehicleSpec compiler.
 * Deterministic. Every physical parameter of the VehicleSpec traces back to a build choice
 * via a formula documented here and summarised in docs/DESIGN_MODEL.md.
 *
 * compileBuild() normalises the build first, so an out-of-range or inconsistent save file
 * still compiles to a legal car.
 */
import { buildEngineSpec } from '../sim/engine';
import { clamp, deg2rad } from '../sim/math';
import type {
  AeroSpec,
  BrakeSpec,
  DiffSpec,
  DrivetrainSpec,
  SteeringSpec,
  SuspensionSpec,
  TireSpec,
  VehicleSpec,
} from '../sim/types';
import type { CarBuild, DiffChoice, EnginePosition, EngineTune, TireSetup, Underbody } from './types';
import {
  BRAKE_PADS,
  CHASSIS_MATERIALS,
  CHASSIS_SIZES,
  FIELD_RANGES,
  INTEGER_FIELDS,
  TIRE_COMPOUNDS,
} from './parts';

// ---------------------------------------------------------------------------
// Constants (every one is a documented design-model term)
// ---------------------------------------------------------------------------

export const DRIVER_MASS = 80; // kg, seated at 45% of the wheelbase
const DRIVER_POS = 0.45;
const CHASSIS_POS = 0.5;
const FUEL_POS = 0.85; // tank behind the CG

/** Engine block CG as a fraction of wheelbase behind the front axle. */
const ENGINE_POSITION: Record<EnginePosition, number> = {
  front: -0.12,
  'front-mid': 0.18,
  mid: 0.72,
  rear: 1.08,
};

/** Yaw-inertia layout factor: a mid engine concentrates mass near the CG. */
const YAW_LAYOUT_FACTOR: Record<EnginePosition, number> = {
  front: 1.05,
  'front-mid': 0.97,
  mid: 0.9,
  rear: 1.05,
};

const TUNES: Record<EngineTune, { peakTorqueRpmFraction: number; peakiness: number }> = {
  economy: { peakTorqueRpmFraction: 0.35, peakiness: 0.3 },
  street: { peakTorqueRpmFraction: 0.5, peakiness: 0.5 },
  sport: { peakTorqueRpmFraction: 0.62, peakiness: 0.7 },
  race: { peakTorqueRpmFraction: 0.75, peakiness: 0.95 },
};

const FLYWHEEL_FACTOR = { light: 0.6, standard: 1, heavy: 1.6 } as const;

/**
 * °C per joule for the reference tyre (205 mm, 220 kPa) at heatingScale 1 — the inverse of the
 * tyre's effective thermal mass (0.65e-3 °C/J ≈ 1.5 kJ/°C, about a kilogram of tread rubber: the
 * single temperature the model tracks is the tread, the carcass is the cooling path). Heating and
 * cooling (`TIRE_COOLING_BASE`) were both scaled by 0.65 from the first calibration so the hot-lap
 * EQUILIBRIUM is unchanged (the Track Weapon's mediums still settle around their 92 °C optimum on
 * clubsprint, sport tyres ~15 °C below their 70 °C optimum) while one hard stop from 200 km/h
 * raises a warm slick by ~18 °C instead of ~27 °C — the surface spike is real, but a single-mass
 * tyre must not treat it as the whole tyre — and a 2 s burnout costs ~13 °C.
 */
export const TIRE_HEATING_BASE = 0.65e-3;
/** Cooling rate (1/s) at rest for the reference tyre at coolingScale 1; ×(1 + v/20) with speed. */
export const TIRE_COOLING_BASE = 0.013;

const DIFF_MAP: Record<DiffChoice, DiffSpec> = {
  open: { type: 'open', powerLock: 0, coastLock: 0 },
  lsd_1way: { type: 'lsd', powerLock: 0.5, coastLock: 0 },
  lsd_1_5way: { type: 'lsd', powerLock: 0.5, coastLock: 0.25 },
  lsd_2way: { type: 'lsd', powerLock: 0.6, coastLock: 0.6 },
  locked: { type: 'locked', powerLock: 1, coastLock: 1 },
};

const BODY_CD = { streamlined: 0.28, standard: 0.33, boxy: 0.42 } as const;
const UNDERBODY_CD: Record<Underbody, number> = { none: 0.02, flat: 0, diffuser: -0.01 };
const UNDERBODY_FRONT_LIFT: Record<Underbody, number> = { none: 0, flat: 0.05, diffuser: 0.12 };
const UNDERBODY_REAR_LIFT: Record<Underbody, number> = { none: 0, flat: 0.1, diffuser: 0.35 };
const UNDERBODY_RIDE_SENS: Record<Underbody, number> = { none: 0.1, flat: 0.4, diffuser: 0.9 };

// ---------------------------------------------------------------------------
// Per-part builders
// ---------------------------------------------------------------------------

/** Wheel + tyre mass (kg) for one corner. */
function wheelMass(setup: TireSetup): number {
  return 7 + 0.04 * setup.width + 0.6 * setup.rim;
}

/** Disc mass (kg): scales ~ diameter^2.2; carbon-ceramic discs are half the mass. */
function discMass(discMm: number, ceramic: boolean): number {
  return 8 * Math.pow(discMm / 330, 2.2) * (ceramic ? 0.5 : 1);
}

/** One axle's TireSpec from compound + width + pressure + camber + rim. */
function buildTireSpec(setup: TireSetup): TireSpec {
  const c = TIRE_COMPOUNDS[setup.compound];
  const w = setup.width;
  const p = setup.pressure;
  const rim = setup.rim;
  const wr = w / 205; // width ratio vs reference
  const pr = 220 / p; // inverse pressure ratio vs reference (>1 = softer than reference)

  // Over-inflation kills the contact patch; severe under-inflation folds the carcass.
  const pressurePenalty =
    1 - 0.12 * Math.max(0, (p - 260) / 60) - 0.1 * Math.max(0, (150 - p) / 30);

  // Overall diameter stays ≈ 0.67 m: bigger rims = lower-profile sidewall.
  const sidewall = clamp(0.335 - rim * 0.0127, 0.045, 0.14);

  return {
    peakMu: c.peakMu * Math.pow(wr, 0.08) * pressurePenalty,
    optimalLoad: 3200 * wr * Math.pow(pr, 0.6) * Math.pow(rim / 17, 0.1),
    loadSensitivity: c.loadSensitivity * Math.pow(1 / wr, 0.5),
    underloadPenalty: c.underloadPenalty * Math.pow(pr, 0.7) * Math.pow(wr, 0.5),
    peakSlipAngle: deg2rad(c.peakSlipAngleDeg) * Math.pow(pr, 0.2),
    peakSlipRatio: c.peakSlipRatio,
    slideMuRatio: c.slideMuRatio,
    corneringStiffnessPerLoad: c.corneringStiffness * Math.pow(wr, 0.3) * Math.pow(p / 220, 0.25),
    longStiffnessPerLoad: c.longStiffness * Math.pow(wr, 0.3) * Math.pow(p / 220, 0.25),
    optimalTemp: c.optimalTemp,
    tempWindow: c.tempWindow,
    coldGripFloor: c.coldGripFloor,
    hotGripFloor: c.hotGripFloor,
    heatingPerJoule: TIRE_HEATING_BASE * c.heatingScale * (205 / w) * Math.pow(pr, 0.35),
    coolingRate: TIRE_COOLING_BASE * Math.pow(wr, 0.3) * c.coolingScale,
    wearPerJoule: c.wearScale * 1e-8 * (205 / w),
    wearGripLoss: c.wearGripLoss,
    rollingResistance: c.rollingResistance * Math.pow(pr, 0.5),
    radius: 0.5 * rim * 0.0254 + sidewall,
    width: w / 1000,
    camber: deg2rad(setup.camber),
    optimalCamber: deg2rad(c.optimalCamberDeg),
    camberGain: c.camberGain,
    surfaceAffinity: { ...c.surfaceAffinity },
    mass: wheelMass(setup),
  };
}

/** One axle's BrakeSpec from disc diameter + pad + ducts. */
function buildBrakeSpec(discMm: number, pad: PadCompoundData, ceramic: boolean, ducts: number): BrakeSpec {
  const dMass = discMass(discMm, ceramic);
  return {
    // 2 pad faces × clamp force 25 kN × pad mu × effective radius (40% of diameter).
    maxTorque: 2 * pad.mu * 25000 * ((discMm / 1000) * 0.5 * 0.8),
    heatCapacity: dMass * (ceramic ? 800 : 460) + 300, // + hub/caliper thermal mass
    coolingCoeff: 12 + 12 * (discMm / 330) + 70 * ducts,
    heatAbsorption: 0.9,
    fadeStartTemp: pad.fadeStart,
    fadeEndTemp: pad.fadeEnd,
    fadeMinFactor: pad.fadeMin,
    coldFactor: pad.coldFactor,
    coldBiteTemp: pad.coldBite,
    mass: dMass + 3, // + caliper
  };
}
type PadCompoundData = (typeof BRAKE_PADS)['street'];

// ---------------------------------------------------------------------------
// compileBuild
// ---------------------------------------------------------------------------

export function compileBuild(build: CarBuild): VehicleSpec {
  const b = normalizeBuild(build);
  const size = CHASSIS_SIZES[b.chassis.size];
  const material = CHASSIS_MATERIALS[b.chassis.material];
  const pad = BRAKE_PADS[b.brakes.pads];
  const ceramic = b.brakes.pads === 'carbon_ceramic';
  const tune = TUNES[b.engine.tune];

  // --- engine -------------------------------------------------------------
  const flywheelInertia =
    (0.08 + 0.05 * b.engine.displacement) * FLYWHEEL_FACTOR[b.engine.flywheel];
  const engine = buildEngineSpec({
    displacement: b.engine.displacement,
    cylinders: b.engine.cylinders,
    aspiration: b.engine.aspiration,
    boost: b.engine.boost,
    peakTorqueRpmFraction: tune.peakTorqueRpmFraction,
    peakiness: tune.peakiness,
    redlineRpm: b.engine.redline,
    inertia: flywheelInertia,
  });

  // --- masses and positions (fraction of wheelbase behind the FRONT axle) --
  const chassisMass =
    size.baseMass * material.massFactor * (1 - 0.15 * b.chassis.weightReduction);
  const gearboxMass =
    45 + 4 * b.drivetrain.gears + (b.drivetrain.layout === 'AWD' ? 55 : 0) + (b.drivetrain.layout === 'FWD' ? -8 : 0);
  const frontLayout = b.chassis.enginePosition === 'front' || b.chassis.enginePosition === 'front-mid';
  const gearboxPos = frontLayout ? 0.35 : 0.92;

  const wheelMassF = wheelMass(b.tires.front);
  const wheelMassR = wheelMass(b.tires.rear);
  const discMassF = discMass(b.brakes.discFront, ceramic);
  const discMassR = discMass(b.brakes.discRear, ceramic);
  const ballastPos = (1 - b.chassis.ballastPosition) / 2; // +1 → front axle (0), −1 → rear axle (1)

  const items: Array<[mass: number, pos: number]> = [
    [chassisMass, CHASSIS_POS],
    [engine.mass, ENGINE_POSITION[b.chassis.enginePosition]],
    [gearboxMass, gearboxPos],
    [2 * wheelMassF + 2 * discMassF, 0],
    [2 * wheelMassR + 2 * discMassR, 1],
    [DRIVER_MASS, DRIVER_POS],
    [b.chassis.fuel, FUEL_POS],
    [b.chassis.ballastMass, ballastPos],
  ];
  let mass = 0;
  let moment = 0;
  for (const [m, pos] of items) {
    mass += m;
    moment += m * pos;
  }
  const cgToFront = (moment / mass) * size.wheelbase;

  const rideF = b.suspension.rideHeightFront / 1000;
  const rideR = b.suspension.rideHeightRear / 1000;
  const rideAvg = (rideF + rideR) / 2;
  const cgHeight =
    size.cgHeight +
    (rideAvg - 0.12) * 0.8 -
    0.02 * b.chassis.weightReduction -
    0.05 * (b.chassis.ballastMass / 200); // ballast is mounted on the floor
  const yawInertia =
    mass *
    (0.16 * size.wheelbase * size.wheelbase + 0.06 * size.width * size.width) *
    YAW_LAYOUT_FACTOR[b.chassis.enginePosition];

  // --- tyres ----------------------------------------------------------------
  const tireF = buildTireSpec(b.tires.front);
  const tireR = buildTireSpec(b.tires.rear);

  // --- brakes ---------------------------------------------------------------
  const brakeF = buildBrakeSpec(b.brakes.discFront, pad, ceramic, b.brakes.ducts);
  const brakeR = buildBrakeSpec(b.brakes.discRear, pad, ceramic, b.brakes.ducts);
  const wheelInertiaFront =
    0.6 * tireF.mass * tireF.radius * tireF.radius +
    0.5 * discMassF * Math.pow(b.brakes.discFront / 2000, 2);
  const wheelInertiaRear =
    0.6 * tireR.mass * tireR.radius * tireR.radius +
    0.5 * discMassR * Math.pow(b.brakes.discRear / 2000, 2);

  // --- suspension -----------------------------------------------------------
  const springF = b.suspension.springFront * 1000; // N/mm → N/m
  const springR = b.suspension.springRear * 1000;
  const suspension: SuspensionSpec = {
    springRateFront: springF,
    springRateRear: springR,
    arbFront: b.suspension.arbFront * 50000,
    arbRear: b.suspension.arbRear * 50000,
    rollStiffnessFront: 0.5 * springF * size.track * size.track + b.suspension.arbFront * 50000,
    rollStiffnessRear: 0.5 * springR * size.track * size.track + b.suspension.arbRear * 50000,
    dampingFront: b.suspension.damperFront,
    dampingRear: b.suspension.damperRear,
    rideHeightFront: rideF,
    rideHeightRear: rideR,
    travel: 0.06 + 0.4 * rideAvg,
    rollCentreFront: 0.3 * rideF,
    rollCentreRear: 0.3 * rideR,
  };

  const steering: SteeringSpec = {
    maxSteerAngle: deg2rad(b.suspension.steeringLock),
    ackermann: 0.6,
    fullLockSpeed: 45,
    highSpeedLockFraction: 0.3,
  };

  // --- aero -------------------------------------------------------------------
  const cd =
    BODY_CD[b.aero.body] + 0.03 * b.aero.splitter + 0.13 * b.aero.wing + UNDERBODY_CD[b.aero.underbody];
  // Lower ride height = cleaner underbody airflow = slightly less drag (±5%).
  const rideDragAdj = clamp((0.1 * (rideAvg - 0.12)) / 0.12, -0.05, 0.05);
  const aero: AeroSpec = {
    dragArea: cd * size.frontalArea * (1 + rideDragAdj),
    liftAreaFront:
      size.frontalArea * (-0.05 + 0.45 * b.aero.splitter + UNDERBODY_FRONT_LIFT[b.aero.underbody]),
    liftAreaRear:
      size.frontalArea * (-0.04 + 0.9 * b.aero.wing + UNDERBODY_REAR_LIFT[b.aero.underbody]),
    rideHeightSensitivity: UNDERBODY_RIDE_SENS[b.aero.underbody],
    refRideHeight: 0.1,
  };

  // --- drivetrain --------------------------------------------------------------
  const nGears = b.drivetrain.gears;
  let gearRatios: number[];
  if (b.drivetrain.gearRatios && b.drivetrain.gearRatios.length === nGears) {
    gearRatios = [...b.drivetrain.gearRatios];
  } else {
    gearRatios = [];
    const first = b.drivetrain.firstGear;
    const top = b.drivetrain.topGear;
    for (let i = 0; i < nGears; i++) {
      const t = nGears > 1 ? i / (nGears - 1) : 0;
      gearRatios.push(first * Math.pow(top / first, t));
    }
  }
  const layout = b.drivetrain.layout;
  const drivetrain: DrivetrainSpec = {
    layout,
    frontTorqueSplit: layout === 'FWD' ? 1 : layout === 'RWD' ? 0 : b.drivetrain.awdFrontSplit,
    gearRatios,
    finalDrive: b.drivetrain.finalDrive,
    shiftTime: b.drivetrain.gearbox === 'auto' ? 0.12 : 0.22,
    efficiency: layout === 'FWD' ? 0.92 : layout === 'RWD' ? 0.9 : 0.85,
    frontDiff: { ...DIFF_MAP[b.drivetrain.frontDiff] },
    rearDiff: { ...DIFF_MAP[b.drivetrain.rearDiff] },
    autoShift: b.drivetrain.gearbox === 'auto',
    inertia: 0.4 + 0.1 * nGears,
    mass: gearboxMass,
  };

  return {
    id: b.id,
    name: b.name,
    mass,
    cgHeight,
    wheelbase: size.wheelbase,
    trackFront: size.track,
    trackRear: size.track,
    cgToFront,
    yawInertia,
    unsprungMassFront: wheelMassF + discMassF + 12,
    unsprungMassRear: wheelMassR + discMassR + 12,
    length: size.length,
    width: size.width,
    aero,
    suspension,
    steering,
    tires: { front: tireF, rear: tireR },
    brakes: {
      front: brakeF,
      rear: brakeR,
      bias: b.brakes.bias,
      abs: b.brakes.abs,
      wheelInertiaFront,
      wheelInertiaRear,
      handbrakeTorque: 0.45 * brakeR.maxTorque,
    },
    engine,
    drivetrain,
    color: b.color,
  };
}

// ---------------------------------------------------------------------------
// normalizeBuild
// ---------------------------------------------------------------------------

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setPath(obj: unknown, path: string, value: number): void {
  const keys = path.split('.');
  let cur: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[keys[i]];
  }
  if (cur != null && typeof cur === 'object') {
    (cur as Record<string, unknown>)[keys[keys.length - 1]] = value;
  }
}

const VALID_CYLINDERS = [3, 4, 5, 6, 8, 10, 12] as const;

/**
 * Clamp every continuous field into its FieldRange and fix inconsistent discrete choices.
 * Returns a new build (deep copy); the input is never mutated. Rules beyond simple clamping:
 *  - NA engines carry boost 0 (the boost slider range starts at 0.3 for forced induction);
 *  - disc diameter ≤ rim × 25.4 − 60 mm (the disc must fit inside the wheel);
 *  - gearRatios of the wrong length (or non-positive/non-finite) are dropped, valid ones
 *    are sorted descending (1st gear first);
 *  - awdFrontSplit is canonicalised to 0.5 for non-AWD layouts (compile ignores it there);
 *  - cylinders snap to the nearest legal count.
 */
export function normalizeBuild(build: CarBuild): CarBuild {
  const b: CarBuild = JSON.parse(JSON.stringify(build)) as CarBuild;
  b.format = 1;
  if (typeof b.id !== 'string' || b.id.length === 0) b.id = 'car';
  if (typeof b.name !== 'string' || b.name.length === 0) b.name = 'Unnamed car';
  if (typeof b.color !== 'string' || b.color.length === 0) b.color = '#888888';

  for (const [path, range] of Object.entries(FIELD_RANGES)) {
    const raw = getPath(b, path);
    let v = typeof raw === 'number' && Number.isFinite(raw) ? raw : range.min;
    v = clamp(v, range.min, range.max);
    if (INTEGER_FIELDS.has(path)) v = Math.round(v);
    setPath(b, path, v);
  }

  if (!VALID_CYLINDERS.includes(b.engine.cylinders as (typeof VALID_CYLINDERS)[number])) {
    const c = Number.isFinite(b.engine.cylinders) ? (b.engine.cylinders as number) : 4;
    let best: (typeof VALID_CYLINDERS)[number] = 4;
    for (const candidate of VALID_CYLINDERS) {
      if (Math.abs(candidate - c) < Math.abs(best - c)) best = candidate;
    }
    b.engine.cylinders = best;
  }

  if (b.engine.aspiration === 'na') b.engine.boost = 0;

  const discRange = FIELD_RANGES['brakes.discFront'];
  const maxDiscF = b.tires.front.rim * 25.4 - 60;
  const maxDiscR = b.tires.rear.rim * 25.4 - 60;
  b.brakes.discFront = clamp(b.brakes.discFront, discRange.min, Math.min(discRange.max, maxDiscF));
  b.brakes.discRear = clamp(b.brakes.discRear, discRange.min, Math.min(discRange.max, maxDiscR));

  if (b.drivetrain.layout !== 'AWD') b.drivetrain.awdFrontSplit = 0.5;

  if (b.drivetrain.gearRatios !== undefined) {
    const ratios = b.drivetrain.gearRatios;
    const valid =
      Array.isArray(ratios) &&
      ratios.length === b.drivetrain.gears &&
      ratios.every((r) => typeof r === 'number' && Number.isFinite(r) && r > 0);
    if (!valid) {
      delete b.drivetrain.gearRatios;
    } else {
      b.drivetrain.gearRatios = [...ratios].sort((a, z) => z - a);
    }
  }

  return b;
}
