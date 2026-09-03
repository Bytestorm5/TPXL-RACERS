/**
 * Track compiler & spatial query — STUB (to be implemented).
 */
import type { RoadQuery, RoadSample } from './types';
import type { TrackSample, TrackSpec, TrackValidationIssue } from './trackTypes';

export interface CompiledTrack extends RoadQuery {
  spec: TrackSpec;
  /** Total centreline length (m). */
  length: number;
  samples: TrackSample[];
  /** Centreline sample at arc length s (wraps for closed tracks, clamps for stages). Interpolated. */
  centreAt(s: number): TrackSample;
  /** Nearest-centreline projection with an optional hint `s` for fast incremental tracking. */
  project(x: number, y: number, hintS?: number): { s: number; lateral: number; distance: number };
  /** World pose for a car at arc length s and lateral offset (m, +left). */
  poseAt(s: number, lateral: number): { x: number; y: number; z: number; heading: number };
  /** Grid slots behind the start line, index 0 = pole. */
  gridSlot(index: number): { x: number; y: number; z: number; heading: number };
  /** Axis-aligned bounds of the drivable area (for the renderer/minimap). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  issues: TrackValidationIssue[];
  /** Start/finish arc-length (m). */
  startLine: number;
}

export function validateTrack(spec: TrackSpec): TrackValidationIssue[] {
  throw new Error('TODO validateTrack');
}

export function compileTrack(spec: TrackSpec): CompiledTrack {
  throw new Error('TODO compileTrack');
}
