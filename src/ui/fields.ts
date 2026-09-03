/**
 * Garage editor field descriptors. Continuous fields are driven GENERICALLY from
 * FIELD_RANGES (label, unit, hint, min/max/step); this file only decides the order,
 * the grouping into sections and the discrete choices (with a hint per option).
 */
import { BRAKE_PADS, CHASSIS_MATERIALS, CHASSIS_SIZES, FIELD_RANGES, TIRE_COMPOUNDS } from '../design/parts';
import type { BuildWarning, CarBuild } from '../design/types';

export interface SelectOption {
  value: string | number | boolean;
  label: string;
  hint?: string;
}

export type FieldDesc =
  | {
      kind: 'range';
      path: string;
      enabled?: (b: CarBuild) => boolean;
      /** Extra live note under the control (e.g. the disc size limit for the current rim). */
      note?: (b: CarBuild) => string | null;
    }
  | {
      kind: 'select';
      path: string;
      label: string;
      hint: string;
      options: SelectOption[];
      /** Segmented buttons instead of a <select> (≤ 5 short options). */
      segmented?: boolean;
      enabled?: (b: CarBuild) => boolean;
    }
  | { kind: 'toggle'; path: string; label: string; hint: string }
  | { kind: 'ratios' };

export interface SectionDesc {
  id: string;
  title: string;
  area: BuildWarning['area'];
  fields: FieldDesc[];
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function setPath(obj: unknown, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: unknown = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = (cur as Record<string, unknown>)[keys[i]];
  }
  if (cur != null && typeof cur === 'object') (cur as Record<string, unknown>)[keys[keys.length - 1]] = value;
}

const range = (path: string, extra: Partial<Extract<FieldDesc, { kind: 'range' }>> = {}): FieldDesc => {
  if (!FIELD_RANGES[path]) throw new Error(`no FieldRange for ${path}`);
  return { kind: 'range', path, ...extra };
};

const compoundOptions: SelectOption[] = Object.values(TIRE_COMPOUNDS).map((c) => ({
  value: c.id,
  label: c.label,
  hint: `${c.description} Peak μ ${c.peakMu.toFixed(2)} at ${c.optimalTemp} °C (±${c.tempWindow} °C window).`,
}));

const padOptions: SelectOption[] = (Object.keys(BRAKE_PADS) as Array<keyof typeof BRAKE_PADS>).map((k) => {
  const p = BRAKE_PADS[k];
  return {
    value: k,
    label: p.label,
    hint: `μ ${p.mu.toFixed(2)}; fades ${p.fadeStart}–${p.fadeEnd} °C; ${p.coldFactor < 1 ? `${Math.round(p.coldFactor * 100)}% bite until ${p.coldBite} °C` : 'full bite from cold'}.`,
  };
});

const diffOptions: SelectOption[] = [
  { value: 'open', label: 'Open', hint: 'Cheapest and smoothest; the inside wheel spins up on corner exit.' },
  { value: 'lsd_1way', label: 'LSD 1-way', hint: 'Locks under power only: traction on exit, free on entry.' },
  { value: 'lsd_1_5way', label: 'LSD 1.5-way', hint: 'Locks under power, a little on coast: stable entry, good exit.' },
  { value: 'lsd_2way', label: 'LSD 2-way', hint: 'Locks under power and coast: stable braking, pushes a bit on entry.' },
  { value: 'locked', label: 'Locked', hint: 'Maximum traction, wheels forced to one speed — understeers when gripping, loves sliding.' },
];

const tuneOptions: SelectOption[] = [
  { value: 'economy', label: 'Economy', hint: 'Torque peak at 35% of the redline, flat and lazy up top.' },
  { value: 'street', label: 'Street', hint: 'Peak at 50% of the redline: broad, forgiving.' },
  { value: 'sport', label: 'Sport', hint: 'Peak at 62%: more top end, a little weaker down low.' },
  { value: 'race', label: 'Race', hint: 'Peak at 75%: holds torque to the redline, weak below ~40% rpm. Needs short gears and revs.' },
];

export const SECTIONS: SectionDesc[] = [
  {
    id: 'chassis',
    title: 'Chassis',
    area: 'chassis',
    fields: [
      {
        kind: 'select',
        path: 'chassis.size',
        label: 'Size',
        hint: 'Sets wheelbase, track, frontal area, base mass and CG height. Bigger is heavier and draggier but longer and more stable.',
        options: (Object.keys(CHASSIS_SIZES) as Array<keyof typeof CHASSIS_SIZES>).map((k) => {
          const s = CHASSIS_SIZES[k];
          return { value: k, label: s.label, hint: `${s.baseMass} kg bare, wheelbase ${s.wheelbase} m, track ${s.track} m, ${s.frontalArea} m² frontal area.` };
        }),
      },
      {
        kind: 'select',
        path: 'chassis.material',
        label: 'Material',
        hint: 'Chassis mass factor: steel 1.0, aluminium 0.82, carbon 0.66.',
        segmented: true,
        options: (Object.keys(CHASSIS_MATERIALS) as Array<keyof typeof CHASSIS_MATERIALS>).map((k) => ({
          value: k,
          label: CHASSIS_MATERIALS[k].label,
          hint: `Mass × ${CHASSIS_MATERIALS[k].massFactor}`,
        })),
      },
      {
        kind: 'select',
        path: 'chassis.enginePosition',
        label: 'Engine position',
        hint: 'Where the engine lump sits: front ≈ 57% front weight, front-mid ≈ 53%, mid ≈ 43%, rear ≈ 40%. Decides which tyres are pressed hard and how eagerly the car rotates.',
        segmented: true,
        options: [
          { value: 'front', label: 'Front' },
          { value: 'front-mid', label: 'Front-mid' },
          { value: 'mid', label: 'Mid' },
          { value: 'rear', label: 'Rear' },
        ],
      },
      range('chassis.weightReduction'),
      range('chassis.ballastMass'),
      range('chassis.ballastPosition', { enabled: (b) => b.chassis.ballastMass > 0 }),
      range('chassis.fuel'),
    ],
  },
  {
    id: 'engine',
    title: 'Engine',
    area: 'engine',
    fields: [
      range('engine.displacement'),
      {
        kind: 'select',
        path: 'engine.cylinders',
        label: 'Cylinders',
        hint: 'Marginal breathing gain (+1% BMEP per cylinder over 4) and +5 kg each; small engines idle higher.',
        segmented: true,
        options: [3, 4, 5, 6, 8, 10, 12].map((n) => ({ value: n, label: String(n) })),
      },
      {
        kind: 'select',
        path: 'engine.aspiration',
        label: 'Aspiration',
        hint: 'Turbo: biggest numbers, lag and nothing below spool. Supercharger: instant, linear, costs a little power to drive.',
        segmented: true,
        options: [
          { value: 'na', label: 'Natural' },
          { value: 'turbo', label: 'Turbo' },
          { value: 'supercharged', label: 'Supercharged' },
        ],
      },
      range('engine.boost', { enabled: (b) => b.engine.aspiration !== 'na' }),
      { kind: 'select', path: 'engine.tune', label: 'Tune (cams/intake)', hint: 'Where the engine breathes best — shifts the torque peak and how peaky the curve is.', segmented: true, options: tuneOptions },
      range('engine.redline'),
      {
        kind: 'select',
        path: 'engine.flywheel',
        label: 'Flywheel',
        hint: 'Light = revs snap up and down (fast shifts, easier to break traction); heavy = smooth launches.',
        segmented: true,
        options: [
          { value: 'light', label: 'Light' },
          { value: 'standard', label: 'Standard' },
          { value: 'heavy', label: 'Heavy' },
        ],
      },
    ],
  },
  {
    id: 'drivetrain',
    title: 'Drivetrain',
    area: 'drivetrain',
    fields: [
      {
        kind: 'select',
        path: 'drivetrain.layout',
        label: 'Driven wheels',
        hint: 'FWD: light, ploughs under power. RWD: rotates on throttle. AWD: grips off the line and on loose surfaces, +55 kg and ~5–7% of the power.',
        segmented: true,
        options: [
          { value: 'FWD', label: 'FWD' },
          { value: 'RWD', label: 'RWD' },
          { value: 'AWD', label: 'AWD' },
        ],
      },
      range('drivetrain.awdFrontSplit', { enabled: (b) => b.drivetrain.layout === 'AWD' }),
      { kind: 'select', path: 'drivetrain.frontDiff', label: 'Front differential', hint: 'How the front axle shares torque between its wheels.', options: diffOptions, enabled: (b) => b.drivetrain.layout !== 'RWD' },
      { kind: 'select', path: 'drivetrain.rearDiff', label: 'Rear differential', hint: 'How the rear axle shares torque between its wheels.', options: diffOptions, enabled: (b) => b.drivetrain.layout !== 'FWD' },
      {
        kind: 'select',
        path: 'drivetrain.gearbox',
        label: 'Gearbox',
        hint: 'Auto shifts for you (0.12 s per shift). Manual needs E/Q (0.22 s) but gives you control.',
        segmented: true,
        options: [
          { value: 'auto', label: 'Automatic' },
          { value: 'manual', label: 'Manual' },
        ],
      },
      range('drivetrain.gears'),
      range('drivetrain.firstGear'),
      range('drivetrain.topGear'),
      range('drivetrain.finalDrive'),
      { kind: 'ratios' },
    ],
  },
  {
    id: 'tiresFront',
    title: 'Tyres — front',
    area: 'tires',
    fields: [
      { kind: 'select', path: 'tires.front.compound', label: 'Front compound', hint: 'The single biggest grip decision — and a temperature window, not a number.', options: compoundOptions },
      range('tires.front.width'),
      range('tires.front.pressure'),
      range('tires.front.camber'),
      range('tires.front.rim'),
    ],
  },
  {
    id: 'tiresRear',
    title: 'Tyres — rear',
    area: 'tires',
    fields: [
      { kind: 'select', path: 'tires.rear.compound', label: 'Rear compound', hint: 'The single biggest grip decision — and a temperature window, not a number.', options: compoundOptions },
      range('tires.rear.width'),
      range('tires.rear.pressure'),
      range('tires.rear.camber'),
      range('tires.rear.rim'),
    ],
  },
  {
    id: 'suspension',
    title: 'Suspension & steering',
    area: 'suspension',
    fields: [
      range('suspension.springFront'),
      range('suspension.springRear'),
      range('suspension.arbFront'),
      range('suspension.arbRear'),
      range('suspension.damperFront'),
      range('suspension.damperRear'),
      range('suspension.rideHeightFront'),
      range('suspension.rideHeightRear'),
      range('suspension.steeringLock'),
    ],
  },
  {
    id: 'brakes',
    title: 'Brakes',
    area: 'brakes',
    fields: [
      range('brakes.discFront', { note: (b) => `Max ${Math.round(b.tires.front.rim * 25.4 - 60)} mm inside ${b.tires.front.rim}" rims` }),
      range('brakes.discRear', { note: (b) => `Max ${Math.round(b.tires.rear.rim * 25.4 - 60)} mm inside ${b.tires.rear.rim}" rims` }),
      { kind: 'select', path: 'brakes.pads', label: 'Pads', hint: 'Friction, fade band and cold behaviour of the pad compound.', segmented: true, options: padOptions },
      range('brakes.bias'),
      { kind: 'toggle', path: 'brakes.abs', label: 'ABS', hint: 'Holds the wheels near peak slip instead of locking. Safety vs the last few percent and threshold-braking skill.' },
      range('brakes.ducts'),
    ],
  },
  {
    id: 'aero',
    title: 'Aero',
    area: 'aero',
    fields: [
      {
        kind: 'select',
        path: 'aero.body',
        label: 'Body shape',
        hint: 'Base drag coefficient: streamlined 0.28, standard 0.33, boxy 0.42.',
        segmented: true,
        options: [
          { value: 'streamlined', label: 'Streamlined' },
          { value: 'standard', label: 'Standard' },
          { value: 'boxy', label: 'Boxy' },
        ],
      },
      range('aero.splitter'),
      range('aero.wing'),
      {
        kind: 'select',
        path: 'aero.underbody',
        label: 'Underbody',
        hint: 'Flat floor: a little downforce, mild ride-height sensitivity. Diffuser: low-drag downforce that lives and dies by ride height.',
        segmented: true,
        options: [
          { value: 'none', label: 'None' },
          { value: 'flat', label: 'Flat floor' },
          { value: 'diffuser', label: 'Diffuser' },
        ],
      },
    ],
  },
];

/** Paths whose change invalidates explicit gear ratios (they are derived from these). */
export const GEAR_SHAPE_PATHS: ReadonlySet<string> = new Set(['drivetrain.gears', 'drivetrain.firstGear', 'drivetrain.topGear']);

/** Human label for a dotted path (FIELD_RANGES label when available). */
export function fieldLabel(path: string): string {
  const r = FIELD_RANGES[path];
  if (r) return r.label;
  for (const s of SECTIONS) {
    for (const f of s.fields) {
      if ('path' in f && f.path === path && 'label' in f) return f.label;
    }
  }
  return path;
}

export function fieldUnit(path: string): string {
  return FIELD_RANGES[path]?.unit ?? '';
}
