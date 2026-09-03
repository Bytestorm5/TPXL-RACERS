/**
 * Road helpers for the vehicle model and its tests.
 *
 *  - `roadNoise(x, y)`: deterministic, smooth value noise in (-1, 1) at ~0.5 m wavelength
 *    (hash of floor(x/0.5), floor(y/0.5), Hermite-weighted bilinear interpolation so the
 *    height AND its slope are continuous — the dampers see the slope).
 *  - `roughnessHeight(surface, x, y)`: the vertical offset the vehicle model adds to the
 *    sampled ground under each wheel: 0.06 m × surface.roughness × noise. Curbs and paved
 *    surfaces use the pure 0.5 m serration; loose surfaces (gravel, dirt, grass, sand, snow,
 *    ice) use a red spectrum (0.5 / 2 / 8 m octaves, longer waves larger) because real
 *    loose roads are dominated by undulations, not 0.5 m corrugations.
 *  - `flatRoad(opts)`: an infinite plane through the origin, z = x·tan(grade) − y·tan(bank),
 *    with gradeAlong / bankAcross resolved for the query heading exactly like track.ts.
 *  - `rampRoad(opts)`: flat, then an uphill ramp, then flat at the new height — or, with
 *    `dropGrade`, a descent back down to `dropHeight` below the ramp top (a jump).
 *
 * Everything here is pure and deterministic (no Math.random).
 */
import { AIR_DENSITY, DEFAULT_AMBIENT_TEMP } from './types';
import type { RoadQuery, RoadSample, SurfaceKind, SurfaceProps } from './types';
import { surfaceProps } from './surface';

/** Base wavelength (m) of the roughness noise. */
export const ROUGHNESS_WAVELENGTH = 0.5;
/** Peak roughness height (m) per unit of `surface.roughness`. */
export const ROUGHNESS_AMPLITUDE = 0.06;

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

/** Integer lattice hash → uniform value in [-1, 1). Deterministic, 32-bit mixing. */
function hash2(ix: number, iy: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul((iy | 0) + 0x165667b1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

/** Smooth value noise in (-1, 1) at the given wavelength (m). */
export function valueNoise(x: number, y: number, wavelength: number): number {
  if (!(wavelength > 0) || x !== x || y !== y) return 0;
  const fx = x / wavelength;
  const fy = y / wavelength;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const n00 = hash2(ix, iy);
  const n10 = hash2(ix + 1, iy);
  const n01 = hash2(ix, iy + 1);
  const n11 = hash2(ix + 1, iy + 1);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

/** The ~0.5 m wavelength roughness noise in (-1, 1). */
export function roadNoise(x: number, y: number): number {
  return valueNoise(x, y, ROUGHNESS_WAVELENGTH);
}

const LOOSE: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(['gravel', 'dirt', 'grass', 'sand', 'snow', 'ice']);

/**
 * Vertical roughness offset (m) of the ground under a wheel at world (x, y):
 * 0.06 × roughness × noise. Paved surfaces and curbs: the pure 0.5 m serration. Loose
 * surfaces: a red spectrum, (0.25·n(0.5 m) + 0.5·n(2 m) + 1.0·n(8 m)) / 1.75.
 */
export function roughnessHeight(surface: SurfaceProps, x: number, y: number): number {
  const r = surface.roughness;
  if (!(r > 0)) return 0;
  let n: number;
  if (LOOSE.has(surface.kind)) {
    n = (0.25 * valueNoise(x, y, 0.5) + 0.5 * valueNoise(x + 37.1, y - 11.3, 2) + valueNoise(x - 91.7, y + 53.9, 8)) / 1.75;
  } else {
    n = valueNoise(x, y, ROUGHNESS_WAVELENGTH);
  }
  return ROUGHNESS_AMPLITUDE * r * n;
}

// ---------------------------------------------------------------------------
// Synthetic roads
// ---------------------------------------------------------------------------

/** Build a RoadSample for a locally planar ground with world gradient (gx, gy) = (dz/dx, dz/dy). */
function planeSample(
  z: number,
  gx: number,
  gy: number,
  heading: number,
  surface: SurfaceProps,
  s: number,
  lateral: number,
): RoadSample {
  const ch = Math.cos(heading);
  const sh = Math.sin(heading);
  return {
    z,
    gradeAlong: Math.atan(gx * ch + gy * sh),
    bankAcross: Math.atan(gx * sh - gy * ch),
    surface,
    onTrack: true,
    s,
    lateral,
    halfWidth: 1e6,
    trackHeading: 0,
    curvature: 0,
  };
}

export interface FlatRoadOptions {
  surface?: SurfaceKind;
  /** Road pitch (rad) as seen heading +x: positive = uphill toward +x. */
  grade?: number;
  /** Road roll (rad) as seen heading +x: positive = RIGHT side (−y) higher. */
  bank?: number;
  ambientTemp?: number;
  airDensity?: number;
}

/** An infinite plane through the origin: z = x·tan(grade) − y·tan(bank). */
export function flatRoad(opts: FlatRoadOptions = {}): RoadQuery {
  const surface = surfaceProps(opts.surface ?? 'asphalt');
  const gx = Math.tan(opts.grade ?? 0);
  const gy = -Math.tan(opts.bank ?? 0);
  return {
    ambientTemp: opts.ambientTemp ?? DEFAULT_AMBIENT_TEMP,
    airDensity: opts.airDensity ?? AIR_DENSITY,
    sampleAt(x: number, y: number, heading: number): RoadSample {
      return planeSample(gx * x + gy * y, gx, gy, heading, surface, x, y);
    },
  };
}

export interface RampRoadOptions {
  /** x where the ramp starts (m). */
  rampStart: number;
  /** Length of the ramp along x (m). */
  rampLength: number;
  /** Ramp slope as a fraction (0.25 = 25 %). */
  rampGrade: number;
  /**
   * If given, the ground descends after the ramp top at this slope magnitude (fraction) until
   * it is `dropHeight` below the top (default: the full ramp height, i.e. back to z = 0), then
   * stays flat. A large value (e.g. 10) is effectively a cliff: a jump table.
   */
  dropGrade?: number;
  dropHeight?: number;
  surface?: SurfaceKind;
  ambientTemp?: number;
  airDensity?: number;
}

/** Flat → uphill ramp → flat at the new height (or a drop back down when `dropGrade` is set). */
export function rampRoad(opts: RampRoadOptions): RoadQuery {
  const surface = surfaceProps(opts.surface ?? 'asphalt');
  const x0 = opts.rampStart;
  const len = Math.max(opts.rampLength, 1e-6);
  const g = opts.rampGrade;
  const top = len * g;
  const x1 = x0 + len;
  const dropSlope = opts.dropGrade !== undefined ? Math.abs(opts.dropGrade) : 0;
  const dropH = opts.dropHeight !== undefined ? Math.max(0, opts.dropHeight) : Math.max(0, top);
  const dropLen = dropSlope > 0 ? dropH / dropSlope : 0;
  const x2 = x1 + dropLen;
  const zEnd = dropSlope > 0 ? top - dropH : top;
  return {
    ambientTemp: opts.ambientTemp ?? DEFAULT_AMBIENT_TEMP,
    airDensity: opts.airDensity ?? AIR_DENSITY,
    sampleAt(x: number, y: number, heading: number): RoadSample {
      let z: number;
      let gx: number;
      if (x < x0) {
        z = 0;
        gx = 0;
      } else if (x < x1) {
        z = (x - x0) * g;
        gx = g;
      } else if (dropSlope > 0 && x < x2) {
        z = top - (x - x1) * dropSlope;
        gx = -dropSlope;
      } else {
        z = zEnd;
        gx = 0;
      }
      return planeSample(z, gx, 0, heading, surface, x, y);
    },
  };
}
