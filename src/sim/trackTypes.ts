/**
 * RACERS track format (v1) — the moddable standard.
 *
 * A track is a list of SEGMENTS laid end-to-end along a centreline. Each segment is a
 * clothoid-like piece: curvature, width, bank and grade may each be constant or vary
 * linearly from the segment start to its end. This is how real circuits are surveyed
 * and it lets a modder author elevation changes, banked bowls, hairpins, crests and
 * surface changes with a few lines of JSON. No decor.
 *
 * Coordinates: x east, y north, z up. The centreline starts at the origin heading +x
 * (unless `start` is given). Positive curvature turns LEFT.
 *
 * Closed circuits: authors are not expected to make a loop close perfectly. The compiler
 * measures the closure error (position + heading) and, if `closed` is true, distributes
 * the correction smoothly over the final `closureBlend` metres (default 20% of length,
 * minimum 50 m). A closure error above `maxClosureError` (default 25 m) is a validation
 * error — the author should fix the geometry.
 *
 * Lateral structure (optional): `lanes` describes strips across the width, e.g. a curb
 * on the inside of a turn, a gravel trap beyond the shoulder. If absent the whole width
 * is `surface` and beyond it `shoulder`.
 */

import type { SurfaceKind } from './types';

/** A value that is either constant across a segment or linearly interpolated [start, end]. */
export type Ramp = number | [number, number];

export interface TrackLane {
  /** Lateral extent of the lane as [from, to] in metres from the centreline, positive LEFT. */
  span: [number, number];
  surface: SurfaceKind;
}

export interface TrackSegment {
  /** Length along the centreline (m). Must be > 0. */
  length: number;
  /** Curvature (1/m). Positive = left turn. Default 0 (straight). Prefer `radius` for readability. */
  curvature?: Ramp;
  /** Convenience: turn radius (m) with `turn: 'left' | 'right'`. Mutually exclusive with `curvature`. */
  radius?: Ramp;
  turn?: 'left' | 'right';
  /** Total track width (m). Defaults to the track's `defaultWidth`. */
  width?: Ramp;
  /** Bank angle (deg). Positive = RIGHT edge higher (helps a left turn). Default 0. */
  bank?: Ramp;
  /** Grade (%). Positive = uphill. Default 0. */
  grade?: Ramp;
  /** Surface across the main width. Defaults to the track default. */
  surface?: SurfaceKind;
  /** Surface beyond the main width (run-off). Defaults to the track default shoulder. */
  shoulder?: SurfaceKind;
  /** Optional lateral strips overriding `surface` in their span (e.g. curbs). */
  lanes?: TrackLane[];
  /** Optional human name ("Turn 1", "Crest"). */
  name?: string;
}

export interface TrackSpec {
  /** Format version. */
  format: 1;
  id: string;
  name: string;
  author?: string;
  description?: string;
  /** Circuit (true) or point-to-point stage (false). */
  closed: boolean;
  /** Start pose override. Default {x:0, y:0, z:0, heading:0}. */
  start?: { x?: number; y?: number; z?: number; heading?: number };
  /** Arc length (m) of the start/finish line; default 0. For stages this is where cars start. */
  startLine?: number;
  /** Distance between grid rows (m); default 8. Grid is laid out BEHIND the start line in two staggered columns. */
  gridSpacing?: number;
  defaultWidth: number;
  defaultSurface: SurfaceKind;
  defaultShoulder: SurfaceKind;
  /** Ambient temperature (°C); default 22. */
  ambientTemp?: number;
  /** Sampling step along the centreline (m); default 1. */
  sampleStep?: number;
  closureBlend?: number;
  maxClosureError?: number;
  segments: TrackSegment[];
}

/** One sampled point of the compiled centreline. */
export interface TrackSample {
  s: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  curvature: number;
  /** Total width (m). */
  width: number;
  /** Bank (rad), positive = right edge higher. */
  bank: number;
  /** Grade (rad), positive = uphill. */
  grade: number;
  surface: SurfaceKind;
  shoulder: SurfaceKind;
  lanes: TrackLane[] | undefined;
  /** Index of the authoring segment this sample belongs to. */
  segmentIndex: number;
}

export interface TrackValidationIssue {
  level: 'error' | 'warning';
  message: string;
  segmentIndex?: number;
}
