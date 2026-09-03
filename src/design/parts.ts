/**
 * Parts catalogue — STUB (to be implemented).
 * Physical property tables behind every discrete choice in CarBuild, plus slider ranges.
 */
import type { CarBuild, ChassisMaterial, ChassisSize, FieldRange, PadCompound, TireCompoundId } from './types';

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
  wearScale: number;
  rollingResistance: number;
  optimalCamberDeg: number;
  camberGain: number;
  surfaceAffinity: Partial<Record<import('../sim/types').SurfaceKind, number>>;
}

export interface ChassisSizeData { label: string; wheelbase: number; track: number; length: number; width: number; baseMass: number; frontalArea: number; cgHeight: number; }
export interface ChassisMaterialData { label: string; massFactor: number; stiffness: number; }
export interface PadData { label: string; mu: number; fadeStart: number; fadeEnd: number; fadeMin: number; coldFactor: number; coldBite: number; }

export const TIRE_COMPOUNDS: Record<TireCompoundId, TireCompoundData> = null as unknown as Record<TireCompoundId, TireCompoundData>;
export const CHASSIS_SIZES: Record<ChassisSize, ChassisSizeData> = null as unknown as Record<ChassisSize, ChassisSizeData>;
export const CHASSIS_MATERIALS: Record<ChassisMaterial, ChassisMaterialData> = null as unknown as Record<ChassisMaterial, ChassisMaterialData>;
export const BRAKE_PADS: Record<PadCompound, PadData> = null as unknown as Record<PadCompound, PadData>;

/** Slider ranges for every continuous field, keyed by dotted path e.g. 'tires.front.pressure'. */
export const FIELD_RANGES: Record<string, FieldRange> = {};

/** A sensible generic starting point — the car a player gets when they click "New car". */
export function defaultBuild(id?: string): CarBuild {
  throw new Error('TODO defaultBuild');
}

/** Curated example builds: track car, rally car, drift car, muscle car, hot hatch… */
export function presetBuilds(): CarBuild[] {
  throw new Error('TODO presetBuilds');
}
