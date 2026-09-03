/**
 * Parts catalogue — physical property tables behind every discrete choice in CarBuild,
 * plus slider ranges for every continuous field, the default build and curated presets.
 *
 * All tyre compound base figures are at the REFERENCE tyre: 205 mm wide, 220 kPa, 17".
 * compile.ts scales them with width/pressure/rim (see docs/DESIGN_MODEL.md).
 */
import type {
  CarBuild,
  ChassisMaterial,
  ChassisSize,
  FieldRange,
  PadCompound,
  TireCompoundId,
} from './types';

export interface TireCompoundData {
  id: TireCompoundId;
  label: string;
  description: string;
  /** Base peak mu at reference (205 mm, 220 kPa, optimal load). */
  peakMu: number;
  loadSensitivity: number;
  underloadPenalty: number;
  peakSlipAngleDeg: number;
  peakSlipRatio: number;
  slideMuRatio: number;
  optimalTemp: number;
  tempWindow: number;
  coldGripFloor: number;
  heatingScale: number;
  /** Multiplier on the cooling rate: thick slick tread holds its heat, a thin road tyre sheds it. */
  coolingScale: number;
  wearScale: number;
  rollingResistance: number;
  optimalCamberDeg: number;
  camberGain: number;
  surfaceAffinity: Partial<Record<import('../sim/types').SurfaceKind, number>>;
  /** Cornering stiffness per unit load (1/rad) at the reference tyre. */
  corneringStiffness: number;
  /** Longitudinal stiffness per unit load at the reference tyre. */
  longStiffness: number;
  /** Fraction of peak grip lost at wear = 1. */
  wearGripLoss: number;
}

export interface ChassisSizeData {
  label: string;
  wheelbase: number;
  track: number;
  length: number;
  width: number;
  baseMass: number;
  frontalArea: number;
  cgHeight: number;
}
export interface ChassisMaterialData {
  label: string;
  massFactor: number;
  stiffness: number;
}
export interface PadData {
  label: string;
  mu: number;
  fadeStart: number;
  fadeEnd: number;
  fadeMin: number;
  coldFactor: number;
  coldBite: number;
}

export const TIRE_COMPOUNDS: Record<TireCompoundId, TireCompoundData> = {
  street: {
    id: 'street',
    label: 'Street',
    description: 'Long-life road tyre. Modest grip, works from cold, huge temperature window.',
    peakMu: 0.95,
    loadSensitivity: 0.11,
    underloadPenalty: 0.18,
    peakSlipAngleDeg: 8,
    peakSlipRatio: 0.13,
    slideMuRatio: 0.8,
    optimalTemp: 60,
    tempWindow: 45,
    coldGripFloor: 0.75,
    heatingScale: 1.0,
    coolingScale: 1.1,
    wearScale: 0.4,
    rollingResistance: 0.012,
    optimalCamberDeg: -1.5,
    camberGain: 0.05,
    surfaceAffinity: {},
    corneringStiffness: 15,
    longStiffness: 19,
    wearGripLoss: 0.25,
  },
  sport: {
    id: 'sport',
    label: 'Sport',
    description: 'Sticky road tyre. More grip than street, still friendly when cold.',
    peakMu: 1.05,
    loadSensitivity: 0.13,
    underloadPenalty: 0.2,
    peakSlipAngleDeg: 7.5,
    peakSlipRatio: 0.12,
    slideMuRatio: 0.78,
    optimalTemp: 70,
    tempWindow: 35,
    coldGripFloor: 0.65,
    heatingScale: 1.0,
    coolingScale: 1.0,
    wearScale: 0.7,
    rollingResistance: 0.013,
    optimalCamberDeg: -2,
    camberGain: 0.07,
    surfaceAffinity: { gravel: 0.85, dirt: 0.85, snow: 0.7 },
    corneringStiffness: 16,
    longStiffness: 20,
    wearGripLoss: 0.3,
  },
  semi_slick: {
    id: 'semi_slick',
    label: 'Semi-slick',
    description: 'Track-day tyre. Strong grip once warm, narrower temperature window.',
    peakMu: 1.15,
    loadSensitivity: 0.15,
    underloadPenalty: 0.22,
    peakSlipAngleDeg: 7,
    peakSlipRatio: 0.11,
    slideMuRatio: 0.75,
    optimalTemp: 80,
    tempWindow: 30,
    coldGripFloor: 0.6,
    heatingScale: 1.1,
    coolingScale: 1.0,
    wearScale: 1.2,
    rollingResistance: 0.014,
    optimalCamberDeg: -2.5,
    camberGain: 0.09,
    surfaceAffinity: { gravel: 0.75, dirt: 0.75, grass: 0.7, sand: 0.7, snow: 0.5, ice: 0.7 },
    corneringStiffness: 17,
    longStiffness: 21,
    wearGripLoss: 0.35,
  },
  slick_hard: {
    id: 'slick_hard',
    label: 'Slick (hard)',
    description: 'Racing slick, endurance compound. Big grip, needs heat, lasts a race.',
    peakMu: 1.25,
    loadSensitivity: 0.16,
    underloadPenalty: 0.25,
    peakSlipAngleDeg: 6.5,
    peakSlipRatio: 0.1,
    slideMuRatio: 0.72,
    optimalTemp: 85,
    tempWindow: 24,
    coldGripFloor: 0.5,
    heatingScale: 0.95,
    coolingScale: 0.8,
    wearScale: 1.8,
    rollingResistance: 0.015,
    optimalCamberDeg: -3,
    camberGain: 0.1,
    surfaceAffinity: { gravel: 0.6, dirt: 0.6, grass: 0.55, sand: 0.6, snow: 0.35, ice: 0.5 },
    corneringStiffness: 18,
    longStiffness: 22,
    wearGripLoss: 0.4,
  },
  slick_medium: {
    id: 'slick_medium',
    label: 'Slick (medium)',
    description: 'Racing slick, sprint compound. More grip, narrower window, heats and wears faster.',
    peakMu: 1.35,
    loadSensitivity: 0.17,
    underloadPenalty: 0.27,
    peakSlipAngleDeg: 6.2,
    peakSlipRatio: 0.1,
    slideMuRatio: 0.71,
    optimalTemp: 92,
    tempWindow: 20,
    coldGripFloor: 0.45,
    heatingScale: 1.0,
    coolingScale: 0.75,
    wearScale: 3.0,
    rollingResistance: 0.015,
    optimalCamberDeg: -3,
    camberGain: 0.11,
    surfaceAffinity: { gravel: 0.6, dirt: 0.6, grass: 0.55, sand: 0.6, snow: 0.35, ice: 0.5 },
    corneringStiffness: 19,
    longStiffness: 23,
    wearGripLoss: 0.45,
  },
  slick_soft: {
    id: 'slick_soft',
    label: 'Slick (soft)',
    description: 'Qualifying slick. Huge grip in a very narrow, hot window; wears out fast.',
    peakMu: 1.45,
    loadSensitivity: 0.18,
    underloadPenalty: 0.28,
    peakSlipAngleDeg: 6,
    peakSlipRatio: 0.095,
    slideMuRatio: 0.7,
    optimalTemp: 100,
    tempWindow: 16,
    coldGripFloor: 0.4,
    heatingScale: 1.15,
    coolingScale: 0.7,
    wearScale: 6.0,
    rollingResistance: 0.016,
    optimalCamberDeg: -3,
    camberGain: 0.12,
    surfaceAffinity: { gravel: 0.6, dirt: 0.6, grass: 0.55, sand: 0.6, snow: 0.35, ice: 0.5 },
    corneringStiffness: 20,
    longStiffness: 24,
    wearGripLoss: 0.5,
  },
  rally_gravel: {
    id: 'rally_gravel',
    label: 'Rally (gravel)',
    description: 'Knobby rally tyre. Digs into loose surfaces, loves big slip angles, weak on asphalt.',
    peakMu: 0.85,
    loadSensitivity: 0.12,
    underloadPenalty: 0.15,
    peakSlipAngleDeg: 12,
    peakSlipRatio: 0.2,
    slideMuRatio: 0.9,
    optimalTemp: 65,
    tempWindow: 40,
    coldGripFloor: 0.7,
    heatingScale: 1.1,
    coolingScale: 1.0,
    wearScale: 1.2,
    rollingResistance: 0.02,
    optimalCamberDeg: -1,
    camberGain: 0.04,
    surfaceAffinity: { gravel: 1.5, dirt: 1.45, grass: 1.3, sand: 1.3, snow: 1.2 },
    corneringStiffness: 11,
    longStiffness: 14,
    wearGripLoss: 0.3,
  },
  rally_tarmac: {
    id: 'rally_tarmac',
    label: 'Rally (tarmac)',
    description: 'Tarmac-stage rally tyre. Near semi-slick grip on asphalt, still tolerable on gravel.',
    peakMu: 1.2,
    loadSensitivity: 0.15,
    underloadPenalty: 0.22,
    peakSlipAngleDeg: 8,
    peakSlipRatio: 0.13,
    slideMuRatio: 0.82,
    optimalTemp: 75,
    tempWindow: 30,
    coldGripFloor: 0.6,
    heatingScale: 1.2,
    coolingScale: 1.0,
    wearScale: 1.3,
    rollingResistance: 0.014,
    optimalCamberDeg: -2.5,
    camberGain: 0.09,
    surfaceAffinity: { gravel: 0.8, dirt: 0.85, grass: 0.9, snow: 0.8 },
    corneringStiffness: 16,
    longStiffness: 20,
    wearGripLoss: 0.35,
  },
  snow: {
    id: 'snow',
    label: 'Snow (studded)',
    description: 'Studded winter tyre. Transforms snow and ice, dull and squirmy on asphalt.',
    peakMu: 0.8,
    loadSensitivity: 0.1,
    underloadPenalty: 0.12,
    peakSlipAngleDeg: 10,
    peakSlipRatio: 0.16,
    slideMuRatio: 0.85,
    optimalTemp: 40,
    tempWindow: 35,
    coldGripFloor: 0.8,
    heatingScale: 0.9,
    coolingScale: 1.0,
    wearScale: 1.4,
    rollingResistance: 0.018,
    optimalCamberDeg: -0.5,
    camberGain: 0.03,
    surfaceAffinity: { snow: 2.2, ice: 2.5, gravel: 1.2, dirt: 1.15, grass: 1.1 },
    corneringStiffness: 10,
    longStiffness: 13,
    wearGripLoss: 0.3,
  },
  drift: {
    id: 'drift',
    label: 'Drift',
    description: 'Hard compound with a wide, forgiving slip curve. Keeps most grip while sliding, heats slowly.',
    peakMu: 0.9,
    loadSensitivity: 0.1,
    underloadPenalty: 0.15,
    peakSlipAngleDeg: 10,
    peakSlipRatio: 0.15,
    slideMuRatio: 0.95,
    optimalTemp: 70,
    tempWindow: 60,
    coldGripFloor: 0.75,
    heatingScale: 0.7,
    coolingScale: 1.0,
    wearScale: 0.8,
    rollingResistance: 0.013,
    optimalCamberDeg: -2,
    camberGain: 0.06,
    surfaceAffinity: { gravel: 0.85, snow: 0.7 },
    corneringStiffness: 14,
    longStiffness: 18,
    wearGripLoss: 0.25,
  },
};

/** baseMass is the bare steel chassis + body + interior; the total car adds engine, drivetrain, wheels, brakes, driver (80 kg) and fuel. */
export const CHASSIS_SIZES: Record<ChassisSize, ChassisSizeData> = {
  kei:     { label: 'Kei',        wheelbase: 2.4,  track: 1.35, length: 3.4, width: 1.48, baseMass: 500,  frontalArea: 1.9,  cgHeight: 0.5 },
  compact: { label: 'Compact',    wheelbase: 2.55, track: 1.5,  length: 4.2, width: 1.75, baseMass: 710,  frontalArea: 2.05, cgHeight: 0.52 },
  mid:     { label: 'Mid-size',   wheelbase: 2.7,  track: 1.56, length: 4.6, width: 1.85, baseMass: 880,  frontalArea: 2.2,  cgHeight: 0.53 },
  large:   { label: 'Large',      wheelbase: 2.9,  track: 1.62, length: 4.9, width: 1.95, baseMass: 1050, frontalArea: 2.35, cgHeight: 0.55 },
  truck:   { label: 'Truck',      wheelbase: 3.2,  track: 1.7,  length: 5.4, width: 2.05, baseMass: 1450, frontalArea: 3.0,  cgHeight: 0.75 },
};

export const CHASSIS_MATERIALS: Record<ChassisMaterial, ChassisMaterialData> = {
  steel:     { label: 'Steel',     massFactor: 1.0,  stiffness: 1.0 },
  aluminium: { label: 'Aluminium', massFactor: 0.82, stiffness: 0.95 },
  carbon:    { label: 'Carbon',    massFactor: 0.66, stiffness: 1.2 },
};

export const BRAKE_PADS: Record<PadCompound, PadData> = {
  street:         { label: 'Street',         mu: 0.38, fadeStart: 350, fadeEnd: 550,  fadeMin: 0.35, coldFactor: 1.0,  coldBite: 0 },
  sport:          { label: 'Sport',          mu: 0.42, fadeStart: 450, fadeEnd: 650,  fadeMin: 0.4,  coldFactor: 0.95, coldBite: 40 },
  race:           { label: 'Race',           mu: 0.5,  fadeStart: 600, fadeEnd: 850,  fadeMin: 0.45, coldFactor: 0.6,  coldBite: 150 },
  carbon_ceramic: { label: 'Carbon-ceramic', mu: 0.47, fadeStart: 800, fadeEnd: 1100, fadeMin: 0.6,  coldFactor: 0.7,  coldBite: 120 },
};

/** Slider ranges for every continuous field, keyed by dotted path e.g. 'tires.front.pressure'. */
export const FIELD_RANGES: Record<string, FieldRange> = {
  'chassis.weightReduction': {
    min: 0, max: 1, step: 0.05, unit: '', label: 'Weight reduction',
    hint: 'Strip interior and fit lightweight panels. Less mass everywhere: faster in a straight line, in corners and under braking. Also lowers the centre of gravity slightly.',
  },
  'chassis.ballastMass': {
    min: 0, max: 200, step: 5, unit: 'kg', label: 'Ballast',
    hint: 'Dead weight you place deliberately. Slower overall, but lets you move the weight balance front/rear without changing parts.',
  },
  'chassis.ballastPosition': {
    min: -1, max: 1, step: 0.1, unit: '', label: 'Ballast position',
    hint: '+1 puts the ballast over the front axle, -1 over the rear. More weight on an axle presses its tyres harder — and makes that end heavier to stop and turn.',
  },
  'chassis.fuel': {
    min: 10, max: 80, step: 5, unit: 'kg', label: 'Fuel load',
    hint: 'Fuel sits in a tank behind the middle of the car: more fuel means more mass and a slightly more rearward balance.',
  },
  'engine.displacement': {
    min: 0.6, max: 8, step: 0.1, unit: 'L', label: 'Displacement',
    hint: 'Bigger engine = proportionally more torque, but also more engine mass over its mounting point.',
  },
  'engine.boost': {
    min: 0.3, max: 2, step: 0.05, unit: 'bar', label: 'Boost pressure',
    hint: 'Forced-induction pressure. More boost multiplies torque. Turbos add lag and only reach full boost at mid rpm; superchargers work from idle but steal some power to drive the blower.',
  },
  'engine.redline': {
    min: 4500, max: 11000, step: 100, unit: 'rpm', label: 'Redline',
    hint: 'Maximum engine speed. Power = torque × rpm, so revs are power — but only if the cam (tune) keeps torque alive up there. A street tune gains little past ~7000 rpm.',
  },
  'drivetrain.awdFrontSplit': {
    min: 0.2, max: 0.7, step: 0.05, unit: '', label: 'AWD front torque split',
    hint: 'Fraction of engine torque sent to the front axle. More front = stable, ploughs wide under power; more rear = lively, rotates on the throttle.',
  },
  'drivetrain.gears': {
    min: 3, max: 8, step: 1, unit: '', label: 'Gears',
    hint: 'More gears keep the engine near its power peak but add gearbox mass and more shifts (each shift briefly cuts drive).',
  },
  'drivetrain.firstGear': {
    min: 2, max: 5, step: 0.05, unit: ':1', label: '1st gear ratio',
    hint: 'Shorter (higher number) = harder launch but you run out of 1st sooner and can overwhelm the tyres.',
  },
  'drivetrain.topGear': {
    min: 0.5, max: 1.2, step: 0.05, unit: ':1', label: 'Top gear ratio',
    hint: 'Taller (lower number) = higher top speed and relaxed cruising, but less pull at speed.',
  },
  'drivetrain.finalDrive': {
    min: 2.5, max: 6, step: 0.05, unit: ':1', label: 'Final drive',
    hint: 'Multiplies every gear. Shorter (higher number) = stronger acceleration everywhere, lower top speed, busier shifting.',
  },
  'tires.front.width': {
    min: 155, max: 355, step: 10, unit: 'mm', label: 'Front tyre width',
    hint: 'Wider tyres carry more load before giving up grip and grip harder overall, but add mass and heat up more slowly.',
  },
  'tires.front.pressure': {
    min: 120, max: 320, step: 5, unit: 'kPa', label: 'Front tyre pressure',
    hint: 'Lower pressure needs more load to work but grips harder when loaded; higher pressure is crisper, cooler and rolls easier — at the cost of peak grip.',
  },
  'tires.front.camber': {
    min: -6, max: 2, step: 0.1, unit: 'deg', label: 'Front camber',
    hint: 'Negative camber leans the tyre into the corner: more side grip, slightly less braking/traction grip. Each compound has a sweet spot.',
  },
  'tires.front.rim': {
    min: 13, max: 20, step: 1, unit: 'in', label: 'Front rim size',
    hint: 'Bigger rims mean a lower-profile tyre (crisper response) and room for bigger brake discs, but more unsprung mass.',
  },
  'tires.rear.width': {
    min: 155, max: 355, step: 10, unit: 'mm', label: 'Rear tyre width',
    hint: 'Wider tyres carry more load before giving up grip and grip harder overall, but add mass and heat up more slowly.',
  },
  'tires.rear.pressure': {
    min: 120, max: 320, step: 5, unit: 'kPa', label: 'Rear tyre pressure',
    hint: 'Lower pressure needs more load to work but grips harder when loaded; higher pressure is crisper, cooler and rolls easier — at the cost of peak grip.',
  },
  'tires.rear.camber': {
    min: -6, max: 2, step: 0.1, unit: 'deg', label: 'Rear camber',
    hint: 'Negative camber leans the tyre into the corner: more side grip, slightly less braking/traction grip. Each compound has a sweet spot.',
  },
  'tires.rear.rim': {
    min: 13, max: 20, step: 1, unit: 'in', label: 'Rear rim size',
    hint: 'Bigger rims mean a lower-profile tyre (crisper response) and room for bigger brake discs, but more unsprung mass.',
  },
  'suspension.springFront': {
    min: 15, max: 250, step: 1, unit: 'N/mm', label: 'Front springs',
    hint: 'Stiffer front springs resist roll at the front, which shifts cornering load onto the front tyres — more stability, more understeer at the limit.',
  },
  'suspension.springRear': {
    min: 15, max: 250, step: 1, unit: 'N/mm', label: 'Rear springs',
    hint: 'Stiffer rear springs resist roll at the rear, loading the rear tyres harder in corners — livelier, more oversteer at the limit.',
  },
  'suspension.arbFront': {
    min: 0, max: 1, step: 0.05, unit: '', label: 'Front anti-roll bar',
    hint: 'Adds roll stiffness at the front only. Stiffer front bar = flatter cornering and more understeer. On bumpy or loose surfaces, softer is faster.',
  },
  'suspension.arbRear': {
    min: 0, max: 1, step: 0.05, unit: '', label: 'Rear anti-roll bar',
    hint: 'Adds roll stiffness at the rear only. Stiffer rear bar = sharper turn-in and more oversteer.',
  },
  'suspension.damperFront': {
    min: 0.2, max: 1.2, step: 0.05, unit: '', label: 'Front dampers',
    hint: 'How fast front load transfer settles. Soft = smooth but floaty weight shifts; stiff = immediate response but nervous over bumps.',
  },
  'suspension.damperRear': {
    min: 0.2, max: 1.2, step: 0.05, unit: '', label: 'Rear dampers',
    hint: 'How fast rear load transfer settles. Soft = forgiving on throttle; stiff = crisp but snappy.',
  },
  'suspension.rideHeightFront': {
    min: 40, max: 250, step: 5, unit: 'mm', label: 'Front ride height',
    hint: 'Lower = lower centre of gravity (less weight transfer) and more underbody downforce, but less suspension travel for bumps and curbs.',
  },
  'suspension.rideHeightRear': {
    min: 40, max: 250, step: 5, unit: 'mm', label: 'Rear ride height',
    hint: 'Lower = lower centre of gravity and more underbody downforce, but less travel. Rake (rear higher than front) helps a diffuser.',
  },
  'suspension.steeringLock': {
    min: 20, max: 60, step: 1, unit: 'deg', label: 'Steering lock',
    hint: 'Maximum road-wheel angle. More lock helps hairpins, U-turns and holding big drift angles; it does nothing for fast corners.',
  },
  'brakes.discFront': {
    min: 240, max: 420, step: 10, unit: 'mm', label: 'Front disc diameter',
    hint: 'Bigger discs give more braking torque and soak up more heat before fading — but they must fit inside the rim (rim inches × 25.4 − 60 mm) and add unsprung mass.',
  },
  'brakes.discRear': {
    min: 240, max: 420, step: 10, unit: 'mm', label: 'Rear disc diameter',
    hint: 'Bigger discs give more braking torque and soak up more heat before fading — but they must fit inside the rim (rim inches × 25.4 − 60 mm) and add unsprung mass.',
  },
  'brakes.bias': {
    min: 0.5, max: 0.9, step: 0.005, unit: '', label: 'Brake bias (front)',
    hint: 'Front share of the total braking torque (0.75 = three quarters of the braking on the front axle). Braking throws weight forward, so the front can take more — too much front locks the fronts (plough straight on), too little locks the rears (spin). Balanced is roughly the front axle\'s share of the load under hard braking.',
  },
  'brakes.ducts': {
    min: 0, max: 1, step: 0.1, unit: '', label: 'Brake cooling ducts',
    hint: 'Air ducts to the discs. More cooling = fade arrives later or never; costs nothing here except a little drag in spirit.',
  },
  'aero.splitter': {
    min: 0, max: 1, step: 0.05, unit: '', label: 'Front splitter',
    hint: 'Presses the front axle down at speed: more front grip in fast corners and braking. Adds a little drag. Balance it against the rear wing.',
  },
  'aero.wing': {
    min: 0, max: 1, step: 0.05, unit: '', label: 'Rear wing',
    hint: 'Presses the rear axle down at speed: stability and traction in fast corners. Adds noticeable drag — costs top speed.',
  },
};

/** Fields that must be integers after normalisation. */
export const INTEGER_FIELDS: ReadonlySet<string> = new Set([
  'drivetrain.gears',
  'tires.front.rim',
  'tires.rear.rim',
]);

/**
 * A sensible starting point: a front-mid-engine RWD mid-size 2.5 L sport-tuned coupe on
 * sport tyres — quick, balanced (~53–54% front) and forgiving (ABS, mild aero, 1-way LSD).
 */
export function defaultBuild(id?: string): CarBuild {
  return {
    format: 1,
    id: id ?? 'default',
    name: 'Roadster S',
    color: '#c0392b',
    chassis: {
      size: 'mid',
      material: 'steel',
      enginePosition: 'front-mid',
      weightReduction: 0,
      ballastMass: 0,
      ballastPosition: 0,
      fuel: 50,
    },
    engine: {
      displacement: 2.5,
      cylinders: 6,
      aspiration: 'na',
      boost: 0,
      tune: 'sport',
      redline: 7200,
      flywheel: 'standard',
    },
    drivetrain: {
      layout: 'RWD',
      awdFrontSplit: 0.5,
      gears: 6,
      firstGear: 3.4,
      topGear: 0.85,
      finalDrive: 3.9,
      frontDiff: 'open',
      rearDiff: 'lsd_1way',
      gearbox: 'auto',
    },
    tires: {
      front: { compound: 'sport', width: 225, pressure: 220, camber: -1.5, rim: 17 },
      rear: { compound: 'sport', width: 225, pressure: 220, camber: -1.5, rim: 17 },
    },
    suspension: {
      springFront: 45,
      springRear: 40,
      arbFront: 0.4,
      arbRear: 0.3,
      damperFront: 0.7,
      damperRear: 0.7,
      rideHeightFront: 120,
      rideHeightRear: 125,
      steeringLock: 38,
    },
    brakes: {
      discFront: 320,
      discRear: 300,
      pads: 'sport',
      bias: 0.705,
      abs: true,
      ducts: 0.2,
    },
    aero: {
      splitter: 0.2,
      wing: 0.2,
      underbody: 'flat',
      body: 'standard',
    },
  };
}

/** Curated example builds. Each is coherent: parts, tune and tyres agree on the job. */
export function presetBuilds(): CarBuild[] {
  const base = defaultBuild;
  const clubHatch: CarBuild = {
    ...base('preset_club_hatch'),
    name: 'Club Hatch',
    color: '#2980b9',
    chassis: {
      size: 'compact', material: 'steel', enginePosition: 'front',
      weightReduction: 0.1, ballastMass: 0, ballastPosition: 0, fuel: 45,
    },
    engine: {
      displacement: 1.6, cylinders: 4, aspiration: 'na', boost: 0,
      tune: 'sport', redline: 7400, flywheel: 'light',
    },
    drivetrain: {
      layout: 'FWD', awdFrontSplit: 0.5, gears: 6, firstGear: 3.6, topGear: 0.9,
      finalDrive: 4.2, frontDiff: 'lsd_1way', rearDiff: 'open', gearbox: 'manual',
    },
    tires: {
      front: { compound: 'semi_slick', width: 205, pressure: 210, camber: -2, rim: 16 },
      rear: { compound: 'semi_slick', width: 205, pressure: 215, camber: -1.5, rim: 16 },
    },
    suspension: {
      springFront: 40, springRear: 35, arbFront: 0.5, arbRear: 0.35,
      damperFront: 0.7, damperRear: 0.7, rideHeightFront: 110, rideHeightRear: 115, steeringLock: 40,
    },
    brakes: { discFront: 300, discRear: 280, pads: 'sport', bias: 0.745, abs: true, ducts: 0.3 },
    aero: { splitter: 0.3, wing: 0.3, underbody: 'flat', body: 'standard' },
  };

  const trackWeapon: CarBuild = {
    ...base('preset_track_weapon'),
    name: 'Track Weapon',
    color: '#e67e22',
    chassis: {
      size: 'mid', material: 'carbon', enginePosition: 'mid',
      weightReduction: 0.6, ballastMass: 0, ballastPosition: 0, fuel: 30,
    },
    engine: {
      displacement: 3.8, cylinders: 6, aspiration: 'na', boost: 0,
      tune: 'race', redline: 8600, flywheel: 'light',
    },
    drivetrain: {
      layout: 'RWD', awdFrontSplit: 0.5, gears: 6, firstGear: 3.2, topGear: 0.9,
      finalDrive: 4.0, frontDiff: 'open', rearDiff: 'lsd_2way', gearbox: 'manual',
    },
    tires: {
      front: { compound: 'slick_medium', width: 245, pressure: 190, camber: -3.2, rim: 18 },
      rear: { compound: 'slick_medium', width: 285, pressure: 185, camber: -2.8, rim: 18 },
    },
    suspension: {
      springFront: 90, springRear: 100, arbFront: 0.7, arbRear: 0.6,
      damperFront: 0.9, damperRear: 0.9, rideHeightFront: 70, rideHeightRear: 80, steeringLock: 34,
    },
    brakes: { discFront: 380, discRear: 355, pads: 'race', bias: 0.635, abs: false, ducts: 0.8 },
    aero: { splitter: 0.8, wing: 0.9, underbody: 'diffuser', body: 'streamlined' },
  };

  const gravelRally: CarBuild = {
    ...base('preset_gravel_rally'),
    name: 'Gravel Rally',
    color: '#27ae60',
    chassis: {
      size: 'compact', material: 'steel', enginePosition: 'front',
      weightReduction: 0.15, ballastMass: 0, ballastPosition: 0, fuel: 60,
    },
    engine: {
      displacement: 2.0, cylinders: 4, aspiration: 'turbo', boost: 1.2,
      tune: 'sport', redline: 7000, flywheel: 'standard',
    },
    drivetrain: {
      layout: 'AWD', awdFrontSplit: 0.4, gears: 6, firstGear: 3.8, topGear: 1.0,
      finalDrive: 4.5, frontDiff: 'lsd_2way', rearDiff: 'lsd_2way', gearbox: 'manual',
    },
    tires: {
      front: { compound: 'rally_gravel', width: 195, pressure: 180, camber: -1, rim: 15 },
      rear: { compound: 'rally_gravel', width: 195, pressure: 180, camber: -1, rim: 15 },
    },
    suspension: {
      springFront: 25, springRear: 25, arbFront: 0.2, arbRear: 0.2,
      damperFront: 0.65, damperRear: 0.65, rideHeightFront: 200, rideHeightRear: 200, steeringLock: 45,
    },
    brakes: { discFront: 300, discRear: 300, pads: 'sport', bias: 0.74, abs: false, ducts: 0.4 },
    aero: { splitter: 0.1, wing: 0.3, underbody: 'none', body: 'standard' },
  };

  const driftMissile: CarBuild = {
    ...base('preset_drift_missile'),
    name: 'Drift Missile',
    color: '#8e44ad',
    chassis: {
      size: 'mid', material: 'steel', enginePosition: 'front',
      weightReduction: 0.1, ballastMass: 0, ballastPosition: 0, fuel: 50,
    },
    engine: {
      displacement: 3.0, cylinders: 6, aspiration: 'turbo', boost: 0.8,
      tune: 'sport', redline: 7600, flywheel: 'light',
    },
    drivetrain: {
      layout: 'RWD', awdFrontSplit: 0.5, gears: 6, firstGear: 3.5, topGear: 0.9,
      finalDrive: 3.7, frontDiff: 'open', rearDiff: 'locked', gearbox: 'manual',
    },
    tires: {
      front: { compound: 'drift', width: 235, pressure: 230, camber: -4, rim: 17 },
      rear: { compound: 'drift', width: 255, pressure: 280, camber: -0.5, rim: 17 },
    },
    suspension: {
      springFront: 55, springRear: 50, arbFront: 0.5, arbRear: 0.3,
      damperFront: 0.8, damperRear: 0.75, rideHeightFront: 100, rideHeightRear: 110, steeringLock: 55,
    },
    brakes: { discFront: 330, discRear: 310, pads: 'sport', bias: 0.72, abs: false, ducts: 0.3 },
    aero: { splitter: 0.2, wing: 0.4, underbody: 'flat', body: 'standard' },
  };

  const muscle: CarBuild = {
    ...base('preset_muscle'),
    name: 'Muscle',
    color: '#2c3e50',
    chassis: {
      size: 'large', material: 'steel', enginePosition: 'front',
      weightReduction: 0, ballastMass: 0, ballastPosition: 0, fuel: 60,
    },
    engine: {
      displacement: 6.2, cylinders: 8, aspiration: 'na', boost: 0,
      tune: 'street', redline: 6500, flywheel: 'standard',
    },
    drivetrain: {
      layout: 'RWD', awdFrontSplit: 0.5, gears: 6, firstGear: 3.1, topGear: 0.75,
      finalDrive: 3.3, frontDiff: 'open', rearDiff: 'open', gearbox: 'auto',
    },
    tires: {
      front: { compound: 'street', width: 225, pressure: 230, camber: -0.5, rim: 17 },
      rear: { compound: 'street', width: 245, pressure: 230, camber: -0.5, rim: 17 },
    },
    suspension: {
      springFront: 50, springRear: 45, arbFront: 0.4, arbRear: 0.3,
      damperFront: 0.6, damperRear: 0.6, rideHeightFront: 130, rideHeightRear: 130, steeringLock: 36,
    },
    brakes: { discFront: 340, discRear: 320, pads: 'street', bias: 0.745, abs: true, ducts: 0.1 },
    aero: { splitter: 0, wing: 0, underbody: 'none', body: 'boxy' },
  };

  const keiRacer: CarBuild = {
    ...base('preset_kei_racer'),
    name: 'Kei Racer',
    color: '#f1c40f',
    chassis: {
      size: 'kei', material: 'steel', enginePosition: 'front',
      weightReduction: 0.2, ballastMass: 0, ballastPosition: 0, fuel: 25,
    },
    engine: {
      displacement: 0.66, cylinders: 3, aspiration: 'turbo', boost: 0.6,
      tune: 'sport', redline: 8800, flywheel: 'light',
    },
    drivetrain: {
      layout: 'FWD', awdFrontSplit: 0.5, gears: 5, firstGear: 3.9, topGear: 1.0,
      finalDrive: 5.0, frontDiff: 'lsd_1way', rearDiff: 'open', gearbox: 'manual',
    },
    tires: {
      front: { compound: 'sport', width: 165, pressure: 210, camber: -1.5, rim: 14 },
      rear: { compound: 'sport', width: 165, pressure: 215, camber: -1, rim: 14 },
    },
    suspension: {
      springFront: 28, springRear: 26, arbFront: 0.35, arbRear: 0.25,
      damperFront: 0.7, damperRear: 0.7, rideHeightFront: 110, rideHeightRear: 110, steeringLock: 42,
    },
    brakes: { discFront: 240, discRear: 240, pads: 'sport', bias: 0.745, abs: true, ducts: 0.2 },
    aero: { splitter: 0.2, wing: 0.3, underbody: 'flat', body: 'standard' },
  };

  const iceRunner: CarBuild = {
    ...base('preset_ice_runner'),
    name: 'Ice Runner',
    color: '#5dade2',
    chassis: {
      size: 'compact', material: 'steel', enginePosition: 'front',
      weightReduction: 0, ballastMass: 0, ballastPosition: 0, fuel: 40,
    },
    engine: {
      displacement: 1.8, cylinders: 4, aspiration: 'na', boost: 0,
      tune: 'street', redline: 6500, flywheel: 'standard',
    },
    drivetrain: {
      layout: 'AWD', awdFrontSplit: 0.45, gears: 5, firstGear: 3.6, topGear: 0.95,
      finalDrive: 4.3, frontDiff: 'lsd_2way', rearDiff: 'lsd_2way', gearbox: 'auto',
    },
    tires: {
      front: { compound: 'snow', width: 185, pressure: 190, camber: -0.5, rim: 15 },
      rear: { compound: 'snow', width: 185, pressure: 190, camber: -0.5, rim: 15 },
    },
    suspension: {
      springFront: 22, springRear: 22, arbFront: 0.15, arbRear: 0.15,
      damperFront: 0.6, damperRear: 0.6, rideHeightFront: 170, rideHeightRear: 175, steeringLock: 45,
    },
    brakes: { discFront: 280, discRear: 280, pads: 'street', bias: 0.725, abs: true, ducts: 0.1 },
    aero: { splitter: 0, wing: 0.1, underbody: 'none', body: 'standard' },
  };

  return [clubHatch, trackWeapon, gravelRally, driftMissile, muscle, keiRacer, iceRunner];
}
