import type { SurfaceKind, SurfaceProps } from './types';

/**
 * Surface catalogue. `grip` is relative to dry asphalt for a generic road tyre; tyre specs
 * further multiply by their `surfaceAffinity[kind]` (rally tyres on gravel > slicks on gravel).
 *
 * ASSUMPTION: single static grip figure per surface — no rubbering-in, no wetness gradient,
 * no marbles. Roughness only adds load noise; it does not (yet) launch the car.
 */
export const SURFACES: Record<SurfaceKind, SurfaceProps> = {
  asphalt:     { kind: 'asphalt',     grip: 1.00, rollingResistance: 0.000, roughness: 0.02, drag: 0.0,  peakSlipScale: 1.0, slideRetention: 0.0 },
  concrete:    { kind: 'concrete',    grip: 0.95, rollingResistance: 0.000, roughness: 0.03, drag: 0.0,  peakSlipScale: 1.0, slideRetention: 0.0 },
  wet_asphalt: { kind: 'wet_asphalt', grip: 0.70, rollingResistance: 0.002, roughness: 0.02, drag: 0.0,  peakSlipScale: 0.9, slideRetention: 0.1 },
  curb:        { kind: 'curb',        grip: 0.85, rollingResistance: 0.004, roughness: 0.35, drag: 0.0,  peakSlipScale: 1.0, slideRetention: 0.0 },
  gravel:      { kind: 'gravel',      grip: 0.60, rollingResistance: 0.020, roughness: 0.25, drag: 0.05, peakSlipScale: 1.8, slideRetention: 0.6 },
  dirt:        { kind: 'dirt',        grip: 0.65, rollingResistance: 0.015, roughness: 0.20, drag: 0.03, peakSlipScale: 1.6, slideRetention: 0.5 },
  grass:       { kind: 'grass',       grip: 0.45, rollingResistance: 0.030, roughness: 0.15, drag: 0.06, peakSlipScale: 1.5, slideRetention: 0.5 },
  sand:        { kind: 'sand',        grip: 0.40, rollingResistance: 0.080, roughness: 0.10, drag: 0.25, peakSlipScale: 1.6, slideRetention: 0.6 },
  snow:        { kind: 'snow',        grip: 0.30, rollingResistance: 0.030, roughness: 0.10, drag: 0.10, peakSlipScale: 2.0, slideRetention: 0.7 },
  ice:         { kind: 'ice',         grip: 0.12, rollingResistance: 0.001, roughness: 0.01, drag: 0.0,  peakSlipScale: 1.2, slideRetention: 0.8 },
};

export function surfaceProps(kind: SurfaceKind): SurfaceProps {
  return SURFACES[kind] ?? SURFACES.asphalt;
}
