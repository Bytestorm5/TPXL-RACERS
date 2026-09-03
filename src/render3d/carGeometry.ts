/**
 * Procedural car proportions from a VehicleSpec — pure, no three.js.
 *
 * Everything visible is a physical parameter of the build: body length/width, wheelbase, track
 * widths, CG height, ride heights, tyre radius and section width, the wing (rear downforce area),
 * and the colour. Wider tyres and a lower ride height are visibly wider and lower. Coordinates are
 * the SIM body frame (x forward, y LEFT, z up, origin at the CG); `bodyLocalToMesh` maps them into
 * the mesh frame (x forward, y up, z right).
 */
import type { VehicleSpec, WheelState } from '../sim/types';

export interface BoxPart {
  /** Centre in the sim body frame (m). */
  cx: number;
  cy: number;
  cz: number;
  /** Size along body x / y / z (m). */
  sx: number;
  sy: number;
  sz: number;
  role: 'body' | 'cabin' | 'nose' | 'wing' | 'wingPost' | 'tailLight' | 'headLight' | 'splitter';
}

export interface WheelPart {
  index: 0 | 1 | 2 | 3;
  /** Hub centre at static ride, sim body frame (m). */
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  width: number;
  steerable: boolean;
}

export interface CarGeometry {
  boxes: BoxPart[];
  wheels: WheelPart[];
  /** Height of the body floor above the CG (negative = below), m. */
  floorZ: number;
  /** Overall body height (m). */
  bodyHeight: number;
  /** Local z of the ground plane at static ride (= −cgHeight). */
  groundZ: number;
}

export function buildCarGeometry(spec: VehicleSpec): CarGeometry {
  const L = Math.max(2.4, spec.length);
  const W = Math.max(1.2, spec.width);
  const a = spec.cgToFront;
  const b = spec.wheelbase - a;
  const groundZ = -spec.cgHeight;
  const ride = 0.5 * (spec.suspension.rideHeightFront + spec.suspension.rideHeightRear);
  const floorZ = groundZ + Math.max(0.05, ride);
  const H = Math.max(0.9, Math.min(1.8, spec.height ?? 1.3));
  const bodyTop = groundZ + H;
  const cabinH = Math.max(0.3, (bodyTop - floorZ) * 0.42);
  const bodyH = bodyTop - floorZ - cabinH;
  const bodyCx = (a - b) / 2; // body centred between the axles
  const rf = spec.tires.front.radius;
  const rr = spec.tires.rear.radius;

  const boxes: BoxPart[] = [
    { cx: bodyCx, cy: 0, cz: floorZ + bodyH / 2, sx: L, sy: W, sz: bodyH, role: 'body' },
    { cx: bodyCx - L * 0.05, cy: 0, cz: floorZ + bodyH + cabinH / 2, sx: L * 0.46, sy: W * 0.8, sz: cabinH, role: 'cabin' },
    // nose wedge: a thinner box ahead of the cabin, slightly lower than the main body top
    { cx: bodyCx + L * 0.36, cy: 0, cz: floorZ + bodyH * 0.72, sx: L * 0.28, sy: W * 0.92, sz: bodyH * 0.44, role: 'nose' },
    { cx: L / 2 + bodyCx - 0.04, cy: W * 0.34, cz: floorZ + bodyH * 0.65, sx: 0.06, sy: 0.24, sz: 0.1, role: 'headLight' },
    { cx: L / 2 + bodyCx - 0.04, cy: -W * 0.34, cz: floorZ + bodyH * 0.65, sx: 0.06, sy: 0.24, sz: 0.1, role: 'headLight' },
    { cx: -L / 2 + bodyCx + 0.03, cy: W * 0.36, cz: floorZ + bodyH * 0.7, sx: 0.05, sy: 0.22, sz: 0.09, role: 'tailLight' },
    { cx: -L / 2 + bodyCx + 0.03, cy: -W * 0.36, cz: floorZ + bodyH * 0.7, sx: 0.05, sy: 0.22, sz: 0.09, role: 'tailLight' },
  ];
  // rear wing scales with rear downforce area; a splitter with front downforce area
  const wingArea = spec.aero.liftAreaRear;
  if (wingArea > 0.15) {
    const chord = Math.min(0.45, 0.18 + wingArea * 0.18);
    const span = W * 0.92;
    const height = floorZ + bodyH + Math.min(0.55, 0.2 + wingArea * 0.2);
    boxes.push({ cx: -L / 2 + bodyCx + chord / 2 + 0.02, cy: 0, cz: height, sx: chord, sy: span, sz: 0.035, role: 'wing' });
    boxes.push({ cx: -L / 2 + bodyCx + chord / 2 + 0.05, cy: span * 0.36, cz: (height + floorZ + bodyH) / 2, sx: 0.06, sy: 0.03, sz: height - floorZ - bodyH, role: 'wingPost' });
    boxes.push({ cx: -L / 2 + bodyCx + chord / 2 + 0.05, cy: -span * 0.36, cz: (height + floorZ + bodyH) / 2, sx: 0.06, sy: 0.03, sz: height - floorZ - bodyH, role: 'wingPost' });
  }
  if (spec.aero.liftAreaFront > 0.15) {
    boxes.push({ cx: L / 2 + bodyCx + 0.05, cy: 0, cz: floorZ + 0.02, sx: 0.18, sy: W * 0.95, sz: 0.03, role: 'splitter' });
  }

  const wheels: WheelPart[] = [
    { index: 0, cx: a, cy: spec.trackFront / 2, cz: groundZ + rf, radius: rf, width: spec.tires.front.width, steerable: true },
    { index: 1, cx: a, cy: -spec.trackFront / 2, cz: groundZ + rf, radius: rf, width: spec.tires.front.width, steerable: true },
    { index: 2, cx: -b, cy: spec.trackRear / 2, cz: groundZ + rr, radius: rr, width: spec.tires.rear.width, steerable: false },
    { index: 3, cx: -b, cy: -spec.trackRear / 2, cz: groundZ + rr, radius: rr, width: spec.tires.rear.width, steerable: false },
  ];
  return { boxes, wheels, floorZ, bodyHeight: H, groundZ };
}

/**
 * Wheel hub height relative to the body for a suspension state: `compression` > 0 = bump, the wheel
 * moves UP towards the body. Clamped to ±travel so a wild state never detaches the wheel visibly.
 */
export function wheelHubZ(part: WheelPart, w: Pick<WheelState, 'compression'>, travel: number): number {
  const c = Number.isFinite(w.compression) ? w.compression : 0;
  const lim = Math.max(0.05, travel);
  return part.cz + (c < -lim ? -lim : c > lim ? lim : c);
}
