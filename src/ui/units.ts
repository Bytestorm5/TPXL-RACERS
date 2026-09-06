/**
 * Display units. The simulation, the design layer and every saved file stay SI; this module only
 * converts at the point of display (and back for the garage number inputs).
 *
 *   metric   km/h · °C · kg · m / mm · kPa · Nm · kW · N · N/mm · bar · L
 *   imperial mph  · °F · lb · ft / in · psi · lb·ft · hp · lbf · lb/in · psi · L
 *
 * `preference` is 'auto' (region from navigator.language: US, Liberia, Myanmar → imperial), 'metric'
 * or 'imperial'; persisted by the Session in racers.prefs.v1. `units()` is the resolved system.
 * Listeners re-render on change (the top bar toggle).
 */

export type UnitSystem = 'metric' | 'imperial';
export type UnitPreference = UnitSystem | 'auto';

const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

/** Region auto-detection from the browser locale (en-US → imperial; everything else metric). */
export function detectUnitSystem(locale: string | undefined = typeof navigator !== 'undefined' ? navigator.language : undefined): UnitSystem {
  if (!locale) return 'metric';
  const m = /[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(locale);
  const region = m ? m[1].toUpperCase() : '';
  return IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
}

let preference: UnitPreference = 'auto';
const listeners = new Set<() => void>();

export function unitPreference(): UnitPreference {
  return preference;
}

export function setUnitPreference(p: UnitPreference): void {
  if (p === preference) return;
  preference = p;
  for (const l of listeners) l();
}

export function onUnitsChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The resolved unit system. */
export function units(): UnitSystem {
  return preference === 'auto' ? detectUnitSystem() : preference;
}

export const isImperial = (): boolean => units() === 'imperial';

// ---------------------------------------------------------------- conversions (SI in)

const KMH_PER_MS = 3.6;
const MPH_PER_MS = 2.2369362920544;
const LB_PER_KG = 2.2046226218;
const FT_PER_M = 3.280839895;
const IN_PER_MM = 1 / 25.4;
const PSI_PER_KPA = 0.14503773773;
const PSI_PER_BAR = 14.503773773;
const LBFT_PER_NM = 0.7375621493;
const HP_PER_KW = 1.34102209;
const LBF_PER_N = 0.2248089431;
const LBIN_PER_NMM = 5.7101471627;

export interface Quantity {
  value: number;
  unit: string;
}

function q(value: number, unit: string): Quantity {
  return { value, unit };
}

export const U = {
  /** Speed from m/s. */
  speed: (ms: number): Quantity => (isImperial() ? q(ms * MPH_PER_MS, 'mph') : q(ms * KMH_PER_MS, 'km/h')),
  /** Speed from km/h (analysis metrics are in km/h). */
  speedKmh: (kmh: number): Quantity => (isImperial() ? q((kmh / KMH_PER_MS) * MPH_PER_MS, 'mph') : q(kmh, 'km/h')),
  /** Temperature from °C. */
  temp: (c: number): Quantity => (isImperial() ? q(c * 1.8 + 32, '°F') : q(c, '°C')),
  /** A temperature DIFFERENCE from K/°C. */
  tempDelta: (c: number): Quantity => (isImperial() ? q(c * 1.8, '°F') : q(c, '°C')),
  /** Mass from kg. */
  mass: (kg: number): Quantity => (isImperial() ? q(kg * LB_PER_KG, 'lb') : q(kg, 'kg')),
  /** Distance from m (road scale). */
  dist: (m: number): Quantity => (isImperial() ? q(m * FT_PER_M, 'ft') : q(m, 'm')),
  /** Long distance from m. */
  distLong: (m: number): Quantity => (isImperial() ? q(m / 1609.344, 'mi') : q(m / 1000, 'km')),
  /** Small length from mm. */
  small: (mm: number): Quantity => (isImperial() ? q(mm * IN_PER_MM, 'in') : q(mm, 'mm')),
  /** Pressure from kPa. */
  pressure: (kpa: number): Quantity => (isImperial() ? q(kpa * PSI_PER_KPA, 'psi') : q(kpa, 'kPa')),
  /** Boost from bar. */
  boost: (bar: number): Quantity => (isImperial() ? q(bar * PSI_PER_BAR, 'psi') : q(bar, 'bar')),
  /** Torque from Nm. */
  torque: (nm: number): Quantity => (isImperial() ? q(nm * LBFT_PER_NM, 'lb·ft') : q(nm, 'Nm')),
  /** Power from W. */
  power: (w: number): Quantity => (isImperial() ? q((w / 1000) * HP_PER_KW, 'hp') : q(w / 1000, 'kW')),
  /** Force from N. */
  force: (n: number): Quantity => (isImperial() ? q(n * LBF_PER_N, 'lbf') : q(n, 'N')),
  /** Force from N in thousands (chart axes). */
  forceK: (n: number): Quantity => (isImperial() ? q((n * LBF_PER_N) / 1000, 'klbf') : q(n / 1000, 'kN')),
  /** Spring rate from N/mm. */
  springRate: (nmm: number): Quantity => (isImperial() ? q(nmm * LBIN_PER_NMM, 'lb/in') : q(nmm, 'N/mm')),
  /** Power-to-weight from W/kg. */
  powerToWeight: (wkg: number): Quantity => (isImperial() ? q((wkg / 1000) * HP_PER_KW * 907.18474, 'hp/ton') : q(wkg, 'W/kg')),
};

export interface AxisUnits {
  unit: string;
  /** SI → display. */
  to: (si: number) => number;
  /** display → SI. */
  from: (d: number) => number;
}

/** Two-way conversions for chart axes (ticks are chosen in display units and mapped back). */
export function axisUnits(kind: 'temp' | 'speed' | 'forceK' | 'mass' | 'dist'): AxisUnits {
  const imp = isImperial();
  switch (kind) {
    case 'temp':
      return imp ? { unit: '°F', to: (c) => c * 1.8 + 32, from: (f) => (f - 32) / 1.8 } : { unit: '°C', to: (c) => c, from: (c) => c };
    case 'speed':
      return imp ? { unit: 'mph', to: (v) => v * MPH_PER_MS, from: (d) => d / MPH_PER_MS } : { unit: 'km/h', to: (v) => v * KMH_PER_MS, from: (d) => d / KMH_PER_MS };
    case 'forceK':
      return imp ? { unit: 'klbf', to: (n) => (n * LBF_PER_N) / 1000, from: (d) => (d * 1000) / LBF_PER_N } : { unit: 'kN', to: (n) => n / 1000, from: (d) => d * 1000 };
    case 'mass':
      return imp ? { unit: 'lb', to: (kg) => kg * LB_PER_KG, from: (d) => d / LB_PER_KG } : { unit: 'kg', to: (kg) => kg, from: (d) => d };
    default:
      return imp ? { unit: 'ft', to: (m) => m * FT_PER_M, from: (d) => d / FT_PER_M } : { unit: 'm', to: (m) => m, from: (d) => d };
  }
}

/** `value unit` with `digits` decimals (— for non-finite). */
export function fq(qty: Quantity, digits = 0): string {
  return Number.isFinite(qty.value) ? `${qty.value.toFixed(digits)} ${qty.unit}` : '—';
}

/** The speed-unit label alone (HUD). */
export const speedUnit = (): string => (isImperial() ? 'mph' : 'km/h');
export const tempUnit = (): string => (isImperial() ? '°F' : '°C');

// ---------------------------------------------------------------- garage field units (both ways)

export interface FieldUnitMap {
  /** Display unit label. */
  unit: string;
  /** SI → display. */
  to: (si: number) => number;
  /** display → SI. */
  from: (disp: number) => number;
  /** Decimals for the number box. */
  decimals: number;
  /** Step for the number box in display units. */
  step: number;
}

/** Mapping of FIELD_RANGES units into the current system (identity for metric and unit-less fields). */
export function fieldUnits(siUnit: string, siStep: number): FieldUnitMap {
  const dec = (() => {
    const s = String(siStep);
    const i = s.indexOf('.');
    return i >= 0 ? s.length - i - 1 : 0;
  })();
  const identity: FieldUnitMap = { unit: siUnit, to: (v) => v, from: (v) => v, decimals: dec, step: siStep };
  if (!isImperial()) return identity;
  switch (siUnit) {
    case 'kg':
      return { unit: 'lb', to: (v) => v * LB_PER_KG, from: (v) => v / LB_PER_KG, decimals: 0, step: 1 };
    case 'mm':
      return { unit: 'in', to: (v) => v * IN_PER_MM, from: (v) => v / IN_PER_MM, decimals: 2, step: 0.05 };
    case 'kPa':
      return { unit: 'psi', to: (v) => v * PSI_PER_KPA, from: (v) => v / PSI_PER_KPA, decimals: 1, step: 0.5 };
    case 'bar':
      return { unit: 'psi', to: (v) => v * PSI_PER_BAR, from: (v) => v / PSI_PER_BAR, decimals: 1, step: 0.5 };
    case 'N/mm':
      return { unit: 'lb/in', to: (v) => v * LBIN_PER_NMM, from: (v) => v / LBIN_PER_NMM, decimals: 0, step: 5 };
    default:
      return identity;
  }
}

/**
 * Convert the units inside a free-text message from the analysis layer (km/h, °C, kg, m). The
 * analysis writes SI; this keeps its sentences readable in imperial without teaching it about units.
 */
export function localizeText(text: string): string {
  if (!isImperial()) return text;
  return text
    .replace(/(\d+(?:\.\d+)?)\s?km\/h/g, (_, v) => `${Math.round((Number(v) / KMH_PER_MS) * MPH_PER_MS)} mph`)
    .replace(/(-?\d+(?:\.\d+)?)\s?°C/g, (_, v) => `${Math.round(Number(v) * 1.8 + 32)} °F`)
    .replace(/(\d+(?:\.\d+)?)\s?kg\b/g, (_, v) => `${Math.round(Number(v) * LB_PER_KG)} lb`)
    .replace(/(\d+(?:\.\d+)?)\s?kW\b/g, (_, v) => `${Math.round(Number(v) * HP_PER_KW)} hp`)
    .replace(/(\d+(?:\.\d+)?)\s?Nm\b/g, (_, v) => `${Math.round(Number(v) * LBFT_PER_NM)} lb·ft`)
    .replace(/(\d+(?:\.\d+)?)\s?kPa\b/g, (_, v) => `${(Number(v) * PSI_PER_KPA).toFixed(1)} psi`)
    .replace(/(\d+(?:\.\d+)?)\s?mm\b/g, (_, v) => `${(Number(v) * IN_PER_MM).toFixed(2)} in`)
    .replace(/(\d+(?:\.\d+)?)\s?m\b(?!\/|m|i|p)/g, (_, v) => `${Math.round(Number(v) * FT_PER_M)} ft`)
    .replace(/0–100\b/g, '0–62 mph')
    .replace(/100–0\b/g, '62–0 mph');
}
