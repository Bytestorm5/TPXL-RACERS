/**
 * Input device profiles — pure data + math, no DOM (tested in tests/input.test.ts).
 *
 * A controller or steering wheel reaches the browser through the Gamepad API as a bag of axes
 * (−1..1) and buttons (0..1). Xbox / PlayStation pads use the "standard" mapping; wheels do NOT:
 * every model lays its wheel axis, pedals (often resting at +1 and pressed to −1, sometimes as a
 * combined axis) and buttons out differently, and Chrome / Firefox / Windows / Linux do not agree.
 * So an InputProfile describes, per device:
 *
 *   steer    which axis, direction, dead zone, how much of the wheel's rotation to use and a
 *            linearity curve (1 = linear; > 1 finer near centre for pads)
 *   pedals   throttle / brake / clutch / analogue handbrake — an axis with its rest and full raw
 *            values (learned by the wizard, so inverted or half-range pedals just work), a button
 *            (pad triggers), or nothing
 *   buttons  handbrake, paddles, camera, reset, menu, H-pattern gears 1–6 + R + neutral
 *
 * Presets cover the common devices as a starting point; the setup wizard (src/ui/input/settings.ts)
 * learns the rest. Sim convention: steer +1 = LEFT; pedals 0..1.
 */

export type PedalAction = 'throttle' | 'brake' | 'clutch' | 'handbrakeAxis';
export type ButtonAction =
  | 'handbrake'
  | 'shiftUp'
  | 'shiftDown'
  | 'camera'
  | 'reset'
  | 'menu'
  | 'gear1'
  | 'gear2'
  | 'gear3'
  | 'gear4'
  | 'gear5'
  | 'gear6'
  | 'gearR'
  | 'neutral';

export const PEDAL_ACTIONS: PedalAction[] = ['throttle', 'brake', 'clutch', 'handbrakeAxis'];
export const BUTTON_ACTIONS: ButtonAction[] = ['handbrake', 'shiftUp', 'shiftDown', 'camera', 'reset', 'menu', 'gear1', 'gear2', 'gear3', 'gear4', 'gear5', 'gear6', 'gearR', 'neutral'];

export const ACTION_LABEL: Record<PedalAction | ButtonAction | 'steer', string> = {
  steer: 'Steering',
  throttle: 'Throttle',
  brake: 'Brake',
  clutch: 'Clutch (optional — the gearbox has none)',
  handbrakeAxis: 'Handbrake (analogue lever)',
  handbrake: 'Handbrake',
  shiftUp: 'Shift up (paddle)',
  shiftDown: 'Shift down (paddle)',
  camera: 'Camera',
  reset: 'Reset car',
  menu: 'Pause menu',
  gear1: 'H-pattern 1st',
  gear2: 'H-pattern 2nd',
  gear3: 'H-pattern 3rd',
  gear4: 'H-pattern 4th',
  gear5: 'H-pattern 5th',
  gear6: 'H-pattern 6th',
  gearR: 'H-pattern reverse',
  neutral: 'Neutral',
};

export type AxisSource = { kind: 'axis'; index: number; rest: number; full: number } | { kind: 'button'; index: number } | { kind: 'none' };

export interface SteerBinding {
  /** Axis index; −1 = none. */
  axis: number;
  /** Raw axis positive = RIGHT is the norm (sim steer = −raw); invert flips it. */
  invert: boolean;
  /** Centre dead zone as a fraction of the axis (0..0.5). */
  deadzone: number;
  /** Fraction of the axis travel that reaches full lock (1 = whole travel; 0.5 = half the wheel's rotation). */
  range: number;
  /** Response exponent: 1 linear, 2 finer near the centre. */
  linearity: number;
}

export interface InputProfile {
  format: 1;
  /** Device id string from the Gamepad API (the key it is stored under). */
  device: string;
  /** Human name (from the preset or the id). */
  name: string;
  kind: 'wheel' | 'pad';
  /** Preset id this profile started from (null = wizard-built). */
  preset: PresetId | null;
  steer: SteerBinding;
  pedals: Record<PedalAction, AxisSource>;
  buttons: Partial<Record<ButtonAction, number>>;
}

export type PresetId = 'standard-pad' | 'logitech-g29' | 'logitech-g920' | 'thrustmaster' | 'fanatec' | 'generic-wheel' | 'generic-pad';

export interface Preset {
  id: PresetId;
  name: string;
  kind: 'wheel' | 'pad';
  /** Matched against the Gamepad `id` (case-insensitive). */
  match: RegExp[];
  build: () => Omit<InputProfile, 'format' | 'device' | 'name' | 'preset'>;
}

const NONE: AxisSource = { kind: 'none' };
const axis = (index: number, rest: number, full: number): AxisSource => ({ kind: 'axis', index, rest, full });
const button = (index: number): AxisSource => ({ kind: 'button', index });

/** Standard-mapping pad (Xbox, PlayStation, most USB pads in Chrome): triggers are buttons 6/7. */
const standardPad = (): ReturnType<Preset['build']> => ({
  kind: 'pad',
  steer: { axis: 0, invert: false, deadzone: 0.12, range: 1, linearity: 1.6 },
  pedals: { throttle: button(7), brake: button(6), clutch: NONE, handbrakeAxis: NONE },
  buttons: { handbrake: 2, shiftUp: 5, shiftDown: 4, camera: 3, reset: 8, menu: 9 },
});

/**
 * Wheel guesses. Real layouts differ by model, mode switch, OS and browser — these get the wheel
 * axis and typical pedal polarity (rest +1, pressed −1) right often enough to drive on the first try;
 * the wizard corrects the rest in a minute. Pedals bound here carry rest/full raw values.
 */
export const PRESETS: Preset[] = [
  {
    id: 'logitech-g29',
    name: 'Logitech G29 / G27 / Driving Force',
    kind: 'wheel',
    match: [/g29/i, /g27/i, /driving force/i, /logitech.*(wheel|racing)/i, /046d.*c24f/i, /046d.*c29b/i],
    build: () => ({
      kind: 'wheel',
      steer: { axis: 0, invert: false, deadzone: 0.02, range: 0.5, linearity: 1 },
      pedals: { throttle: axis(2, 1, -1), brake: axis(5, 1, -1), clutch: axis(1, 1, -1), handbrakeAxis: NONE },
      buttons: { shiftUp: 4, shiftDown: 5, handbrake: 1, camera: 3, reset: 8, menu: 9, gear1: 12, gear2: 13, gear3: 14, gear4: 15, gear5: 16, gear6: 17, gearR: 18 },
    }),
  },
  {
    id: 'logitech-g920',
    name: 'Logitech G920 / G923',
    kind: 'wheel',
    match: [/g920/i, /g923/i, /046d.*c262/i, /046d.*c26e/i],
    build: () => ({
      kind: 'wheel',
      steer: { axis: 0, invert: false, deadzone: 0.02, range: 0.5, linearity: 1 },
      pedals: { throttle: axis(1, 1, -1), brake: axis(2, 1, -1), clutch: axis(3, 1, -1), handbrakeAxis: NONE },
      buttons: { shiftUp: 5, shiftDown: 4, handbrake: 1, camera: 3, reset: 8, menu: 9, gear1: 12, gear2: 13, gear3: 14, gear4: 15, gear5: 16, gear6: 17, gearR: 18 },
    }),
  },
  {
    id: 'thrustmaster',
    name: 'Thrustmaster (T150 / TMX / T300 / T248 / TX)',
    kind: 'wheel',
    match: [/thrustmaster/i, /t150/i, /tmx/i, /t300/i, /t248/i, /044f/i],
    build: () => ({
      kind: 'wheel',
      steer: { axis: 0, invert: false, deadzone: 0.02, range: 0.5, linearity: 1 },
      pedals: { throttle: axis(5, 1, -1), brake: axis(1, 1, -1), clutch: axis(2, 1, -1), handbrakeAxis: NONE },
      buttons: { shiftUp: 5, shiftDown: 4, handbrake: 1, camera: 3, reset: 8, menu: 9 },
    }),
  },
  {
    id: 'fanatec',
    name: 'Fanatec (CSL / DD)',
    kind: 'wheel',
    match: [/fanatec/i, /0eb7/i],
    build: () => ({
      kind: 'wheel',
      steer: { axis: 0, invert: false, deadzone: 0.01, range: 0.5, linearity: 1 },
      pedals: { throttle: axis(1, 1, -1), brake: axis(2, 1, -1), clutch: axis(3, 1, -1), handbrakeAxis: NONE },
      buttons: { shiftUp: 5, shiftDown: 4, handbrake: 1, camera: 3, reset: 8, menu: 9 },
    }),
  },
  {
    id: 'standard-pad',
    name: 'Controller (standard mapping)',
    kind: 'pad',
    match: [/xbox/i, /x-box/i, /xinput/i, /dualshock/i, /dualsense/i, /wireless controller/i, /playstation/i, /054c/i, /045e/i, /nintendo/i, /pro controller/i],
    build: standardPad,
  },
  {
    id: 'generic-wheel',
    name: 'Steering wheel (run the setup wizard)',
    kind: 'wheel',
    match: [/wheel/i, /racing/i, /pedal/i],
    build: () => ({
      kind: 'wheel',
      steer: { axis: 0, invert: false, deadzone: 0.02, range: 0.5, linearity: 1 },
      pedals: { throttle: NONE, brake: NONE, clutch: NONE, handbrakeAxis: NONE },
      buttons: { shiftUp: 5, shiftDown: 4, reset: 8, menu: 9 },
    }),
  },
  {
    id: 'generic-pad',
    name: 'Controller (unknown layout)',
    kind: 'pad',
    match: [],
    build: standardPad,
  },
];

/** Pick the preset for a Gamepad `id` / `mapping`. Standard mapping wins over name guesses for pads. */
export function detectPreset(id: string, mapping: string): Preset {
  const wheel = PRESETS.find((p) => p.kind === 'wheel' && p.match.some((re) => re.test(id)));
  if (wheel) return wheel;
  if (mapping === 'standard') return PRESETS.find((p) => p.id === 'standard-pad')!;
  const pad = PRESETS.find((p) => p.kind === 'pad' && p.match.some((re) => re.test(id)));
  return pad ?? PRESETS.find((p) => p.id === 'generic-pad')!;
}

export function presetById(id: PresetId | null): Preset | undefined {
  return id ? PRESETS.find((p) => p.id === id) : undefined;
}

/** A fresh profile for a device from its detected preset. */
export function defaultProfile(id: string, mapping: string): InputProfile {
  const p = detectPreset(id, mapping);
  return { format: 1, device: id, name: p.name, preset: p.id, ...p.build() };
}

/** Short display name from a Gamepad id ("Logitech G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)" → without the vendor tail). */
export function deviceLabel(id: string): string {
  return id.replace(/\s*\((?:STANDARD GAMEPAD\s*)?Vendor:.*$/i, '').replace(/\s*\(STANDARD GAMEPAD\)/i, '').trim() || id;
}

// ---------------------------------------------------------------- mapping math

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const num = (v: number | undefined): number => (typeof v === 'number' && v === v ? v : 0);

/** A pedal 0..1 from the raw device state. */
export function pedalValue(src: AxisSource, axes: ArrayLike<number>, buttons: ArrayLike<number>): number {
  if (src.kind === 'button') return clamp(num(buttons[src.index]), 0, 1);
  if (src.kind !== 'axis') return 0;
  const raw = num(axes[src.index]);
  const span = src.full - src.rest;
  if (!(Math.abs(span) > 1e-6)) return 0;
  const v = clamp((raw - src.rest) / span, 0, 1);
  // a small dead zone at rest so a pedal that does not return exactly to its rest value reads 0
  return v < 0.03 ? 0 : (v - 0.03) / 0.97;
}

/** Steering −1..1 in the SIM convention (+1 = left) from the raw device state. */
export function steerValue(b: SteerBinding, axes: ArrayLike<number>): number {
  if (b.axis < 0) return 0;
  let raw = num(axes[b.axis]);
  const dz = clamp(b.deadzone, 0, 0.5);
  const a = Math.abs(raw);
  if (a <= dz) return 0;
  raw = Math.sign(raw) * ((a - dz) / (1 - dz));
  const range = clamp(b.range, 0.05, 1);
  let v = clamp(raw / range, -1, 1);
  const lin = clamp(b.linearity, 0.5, 4);
  v = Math.sign(v) * Math.pow(Math.abs(v), lin);
  return b.invert ? v : -v;
}

/**
 * H-pattern / sequential target: which shift edge to pulse this frame to move `current` toward
 * `target` (gear numbers as the sim uses them: −1 reverse, 0 neutral, 1..n). Nothing while a shift
 * is in progress. Reverse from a forward gear goes through neutral, as the vehicle model requires.
 */
export function gearPulse(current: number, target: number, shiftTimer: number): { up: boolean; down: boolean } {
  if (shiftTimer > 0 || target === current) return { up: false, down: false };
  if (target > current) return { up: true, down: false };
  return { up: false, down: true };
}

// ---------------------------------------------------------------- storage shape

export interface InputFile {
  format: 1;
  profiles: Record<string, InputProfile>;
  /** Device id to prefer when several are connected. */
  primary?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function isAxisSource(v: unknown): v is AxisSource {
  if (!isObj(v)) return false;
  if (v.kind === 'none') return true;
  if (v.kind === 'button') return typeof v.index === 'number';
  return v.kind === 'axis' && typeof v.index === 'number' && typeof v.rest === 'number' && typeof v.full === 'number';
}

export function isInputProfile(v: unknown): v is InputProfile {
  if (!isObj(v) || v.format !== 1 || typeof v.device !== 'string' || typeof v.name !== 'string') return false;
  if (v.kind !== 'wheel' && v.kind !== 'pad') return false;
  const s = v.steer;
  if (!isObj(s) || typeof s.axis !== 'number' || typeof s.invert !== 'boolean' || typeof s.deadzone !== 'number' || typeof s.range !== 'number' || typeof s.linearity !== 'number') return false;
  const p = v.pedals;
  if (!isObj(p) || !PEDAL_ACTIONS.every((k) => isAxisSource(p[k]))) return false;
  const b = v.buttons;
  if (!isObj(b) || !Object.values(b).every((x) => typeof x === 'number')) return false;
  return true;
}

export function isInputFile(v: unknown): v is InputFile {
  return isObj(v) && v.format === 1 && isObj(v.profiles) && Object.values(v.profiles).every(isInputProfile) && (v.primary === undefined || typeof v.primary === 'string');
}
