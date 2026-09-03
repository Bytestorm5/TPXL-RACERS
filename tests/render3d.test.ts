/**
 * 3D renderer — node-side tests of the pure geometry layer (no WebGL):
 *   coords:        the sim → three mapping is a proper rotation; heading / pitch / roll signs match
 *                  the VehicleState conventions; the mesh basis is orthonormal.
 *   trackGeometry: every road vertex sits on the sim's own road plane (sampleAt), bands cover the
 *                  width + shoulders, closed circuits wrap, normals are unit length and point up,
 *                  curbs / edge lines / start checker get their own colours.
 *   terrain:       the heightfield stays below the road plane next to the shoulder, hills only fade
 *                  in beyond it, no NaNs.
 *   carGeometry:   wheels sit at the axles at tyre radius, body/wing follow the spec.
 */
import { describe, expect, it } from 'vitest';
import { compileBuild } from '../src/design/compile';
import { presetBuilds } from '../src/design/parts';
import { buildCarGeometry, wheelHubZ } from '../src/render3d/carGeometry';
import { bodyBasis, bodyBasisSim, bodyLocalToMesh, det3, simToThree, threeToSim } from '../src/render3d/coords';
import { buildTerrain, ROAD_CLEARANCE } from '../src/render3d/terrain';
import { bandColor, buildTrackMesh, roadPoint, SHOULDER_M, surfaceBands } from '../src/render3d/trackGeometry';
import { compileTrack } from '../src/sim/track';
import { BUILTIN_TRACKS } from '../src/tracks/index';

const track = (id: string) => compileTrack(BUILTIN_TRACKS.find((t) => t.id === id)!);

describe('coords: sim ↔ three', () => {
  it('is a proper rotation (det +1) and round-trips', () => {
    const ex = simToThree(1, 0, 0);
    const ey = simToThree(0, 1, 0);
    const ez = simToThree(0, 0, 1);
    expect(det3(ex, ey, ez)).toBeCloseTo(1, 12);
    const norm = (v: number[]) => v.map((x) => x + 0); // −0 → +0
    expect(norm(ex)).toEqual([1, 0, 0]);
    expect(norm(ey)).toEqual([0, 0, -1]); // north → −Z
    expect(norm(ez)).toEqual([0, 1, 0]); // up → +Y
    const p = threeToSim(...simToThree(3, -4, 5));
    expect(p).toEqual([3, -4, 5]);
  });

  it('heading rotates about sim z: heading π/2 points north', () => {
    const b = bodyBasisSim(Math.PI / 2, 0, 0);
    expect(b.forward[0]).toBeCloseTo(0, 12);
    expect(b.forward[1]).toBeCloseTo(1, 12);
    expect(b.left[0]).toBeCloseTo(-1, 12); // left of north is west
    expect(b.up).toEqual([0, 0, 1]);
  });

  it('pitch > 0 is nose DOWN, roll > 0 is RIGHT side down (types.ts conventions)', () => {
    const p = bodyBasisSim(0, 0.2, 0);
    expect(p.forward[2]).toBeLessThan(0); // nose dips
    expect(p.up[0]).toBeGreaterThan(0); // the roof tilts forward
    const r = bodyBasisSim(0, 0, 0.2);
    expect(r.left[2]).toBeGreaterThan(0); // left side rises → right side down
    expect(r.up[1]).toBeLessThan(0);
  });

  it('bodyBasis is orthonormal and right-handed in the three frame for random poses', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    for (let k = 0; k < 50; k++) {
      const b = bodyBasis(rnd() * Math.PI, rnd() * 1.2, rnd() * 3);
      const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      expect(dot(b.x, b.x)).toBeCloseTo(1, 10);
      expect(dot(b.y, b.y)).toBeCloseTo(1, 10);
      expect(dot(b.z, b.z)).toBeCloseTo(1, 10);
      expect(dot(b.x, b.y)).toBeCloseTo(0, 10);
      expect(dot(b.x, b.z)).toBeCloseTo(0, 10);
      expect(dot(b.y, b.z)).toBeCloseTo(0, 10);
      expect(det3(b.x, b.y, b.z)).toBeCloseTo(1, 10);
    }
    // level car heading east: mesh x = +X, mesh y (up) = +Y, mesh z (right = south) = +Z
    const lvl = bodyBasis(0, 0, 0);
    expect(lvl.x.map((v) => +v.toFixed(12))).toEqual([1, 0, 0]);
    expect(lvl.y.map((v) => +v.toFixed(12))).toEqual([0, 1, 0]);
    expect(lvl.z.map((v) => +v.toFixed(12))).toEqual([0, 0, 1]);
    expect(bodyLocalToMesh(1, 2, 3)).toEqual([1, 3, -2]);
  });
});

describe('trackGeometry: road strip', () => {
  it('vertices lie on the sim road plane (sampleAt) on every built-in track', () => {
    for (const spec of BUILTIN_TRACKS) {
      const t = compileTrack(spec);
      const mesh = buildTrackMesh(t, { centreDash: false });
      expect(mesh.vertexCount).toBeGreaterThan(1000);
      expect(mesh.triangleCount * 3).toBe(mesh.indices.length);
      let worst = 0;
      // check a spread of vertices: the road plane at (x, y) queried through the sim's own road query
      const stride = Math.max(1, Math.floor(mesh.vertexCount / 400));
      for (let v = 0; v < mesh.vertexCount; v += stride) {
        const x = mesh.positions[v * 3];
        const y = mesh.positions[v * 3 + 1];
        const z = mesh.positions[v * 3 + 2];
        expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
        const s = t.sampleAt(x, y, 0);
        // inside the shoulder the plane is the same one the sim uses; tolerance covers the chord
        // interpolation between samples (~κ·step²/8) and the lateral·tan(bank) term at the edges
        if (Math.abs(s.lateral) <= s.halfWidth + SHOULDER_M + 0.01) worst = Math.max(worst, Math.abs(s.z - z));
        const nx = mesh.normals[v * 3];
        const ny = mesh.normals[v * 3 + 1];
        const nz = mesh.normals[v * 3 + 2];
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6);
        expect(nz).toBeGreaterThan(0.5);
      }
      expect(worst, `${spec.id}: max |z_mesh − z_sim|`).toBeLessThan(0.05);
      // winding: every triangle is counter-clockwise seen from above (front face up, so it is not culled)
      const P = mesh.positions;
      for (let tri = 0; tri < mesh.triangleCount; tri += 7) {
        const i0 = mesh.indices[tri * 3] * 3;
        const i1 = mesh.indices[tri * 3 + 1] * 3;
        const i2 = mesh.indices[tri * 3 + 2] * 3;
        const ux = P[i1] - P[i0];
        const uy = P[i1 + 1] - P[i0 + 1];
        const vx = P[i2] - P[i0];
        const vy = P[i2 + 1] - P[i0 + 1];
        expect(ux * vy - uy * vx, `${spec.id}: triangle ${tri} is clockwise`).toBeGreaterThan(0);
      }
    }
  });

  it('bands cover −(w/2+shoulder) … +(w/2+shoulder) contiguously and resolve lanes', () => {
    const t = track('clubsprint');
    for (const smp of t.samples.filter((_, i) => i % 97 === 0)) {
      const bands = surfaceBands(smp);
      const hw = smp.width / 2;
      expect(bands[0].lo).toBeCloseTo(-hw - SHOULDER_M, 9);
      expect(bands[bands.length - 1].hi).toBeCloseTo(hw + SHOULDER_M, 9);
      for (let i = 1; i < bands.length; i++) expect(bands[i].lo).toBeCloseTo(bands[i - 1].hi, 9);
      expect(bands[0].shoulder && bands[bands.length - 1].shoulder).toBe(true);
      if (smp.lanes) {
        for (const l of smp.lanes) {
          const mid = (l.span[0] + l.span[1]) / 2;
          const b = bands.find((bb) => mid >= bb.lo && mid <= bb.hi)!;
          expect(b.kind).toBe(l.surface);
        }
      }
    }
  });

  it('roadPoint matches the sim plane: z = z_c − lateral·tan(bank), left is +lateral', () => {
    const t = track('speedbowl');
    const banked = t.samples.find((smp) => Math.abs(smp.bank) > 0.2)!; // the 24° core of Turn 1
    expect(banked).toBeDefined();
    const c = t.centreAt(banked.s);
    const left = roadPoint(c, 4);
    const right = roadPoint(c, -4);
    expect(left.z).toBeCloseTo(c.z - 4 * Math.tan(c.bank), 12);
    expect(right.z).toBeCloseTo(c.z + 4 * Math.tan(c.bank), 12);
    // +lateral is to the LEFT of the heading
    const lx = left.x - c.x;
    const ly = left.y - c.y;
    expect(-Math.sin(c.heading) * lx + Math.cos(c.heading) * ly).toBeCloseTo(4, 9);
    const pose = t.poseAt(banked.s, 4);
    expect(left.x).toBeCloseTo(pose.x, 6);
    expect(left.y).toBeCloseTo(pose.y, 6);
    expect(left.z).toBeCloseTo(pose.z, 6);
  });

  it('closed circuits wrap: the last strip joins the first sample', () => {
    const t = track('clubsprint');
    const mesh = buildTrackMesh(t, { centreDash: false });
    const n = t.samples.length;
    // the mesh is n strips for a closed track; the last quad's far edge is at sample 0
    const bands0 = surfaceBands(t.samples[0]);
    expect(mesh.vertexCount).toBeGreaterThanOrEqual(n * bands0.length * 4 * 0.9);
    const last = mesh.vertexCount - 1;
    const x = mesh.positions[last * 3];
    const y = mesh.positions[last * 3 + 1];
    const s0 = t.samples[0];
    const dist = Math.hypot(x - s0.x, y - s0.y);
    expect(dist).toBeLessThan(s0.width / 2 + SHOULDER_M + 1);
  });

  it('colours: curb stripes alternate, edge lines are white, the start line is a checker', () => {
    const t = track('clubsprint');
    const smp = t.samples[10];
    const bands = surfaceBands(smp);
    const edge = bands.find((b) => b.edgeLine)!;
    expect(edge).toBeDefined();
    const white = bandColor(edge, 100, smp, t.startLine, true, t.length);
    expect(white[0]).toBeGreaterThan(0.8);
    const curb = { lo: -1, hi: 0, kind: 'curb' as const, shoulder: false, edgeLine: false };
    const a = bandColor(curb, 100, smp, t.startLine, true, t.length);
    const b = bandColor(curb, 102, smp, t.startLine, true, t.length);
    expect(a).not.toEqual(b);
    const main = bands.find((b) => !b.shoulder && !b.edgeLine)!;
    const chk = bandColor(main, t.startLine + 0.5, smp, t.startLine, true, t.length);
    const grey = Math.max(...chk) - Math.min(...chk) < 0.02;
    expect(grey && (chk[0] < 0.1 || chk[0] > 0.9)).toBe(true);
  });
});

describe('terrain heightfield', () => {
  it('sits below the road next to the shoulder, is finite, and hills only appear further out', () => {
    const t = track('dunes-rallycross');
    const terr = buildTerrain(t, { step: 12, margin: 120 });
    expect(terr.cols * terr.rows * 3).toBe(terr.positions.length);
    let checked = 0;
    for (let i = 0; i < terr.cols * terr.rows; i++) {
      const x = terr.positions[i * 3];
      const y = terr.positions[i * 3 + 1];
      const z = terr.positions[i * 3 + 2];
      expect(Number.isFinite(z)).toBe(true);
      const p = t.project(x, y);
      const c = t.centreAt(p.s);
      const edge = c.width / 2 + SHOULDER_M;
      if (Math.abs(p.lateral) <= edge) {
        const road = roadPoint(c, p.lateral).z;
        expect(z).toBeLessThanOrEqual(road - ROAD_CLEARANCE + 1e-3);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(terr.indices.length).toBe((terr.cols - 1) * (terr.rows - 1) * 6);
    // counter-clockwise seen from above, like the road
    const P = terr.positions;
    for (let tri = 0; tri < terr.indices.length / 3; tri += 13) {
      const i0 = terr.indices[tri * 3] * 3;
      const i1 = terr.indices[tri * 3 + 1] * 3;
      const i2 = terr.indices[tri * 3 + 2] * 3;
      expect((P[i1] - P[i0]) * (P[i2 + 1] - P[i0 + 1]) - (P[i1 + 1] - P[i0 + 1]) * (P[i2] - P[i0])).toBeGreaterThan(0);
    }
  });
});

describe('carGeometry from the VehicleSpec', () => {
  it('places the wheels at the axles at tyre radius, and the wing follows rear downforce', () => {
    for (const b of presetBuilds()) {
      const spec = compileBuild(b);
      const g = buildCarGeometry(spec);
      expect(g.wheels).toHaveLength(4);
      expect(g.wheels[0].cx).toBeCloseTo(spec.cgToFront, 12);
      expect(g.wheels[2].cx).toBeCloseTo(-(spec.wheelbase - spec.cgToFront), 12);
      expect(g.wheels[0].cy).toBeCloseTo(spec.trackFront / 2, 12);
      expect(g.wheels[3].cy).toBeCloseTo(-spec.trackRear / 2, 12);
      expect(g.wheels[0].radius).toBe(spec.tires.front.radius);
      expect(g.wheels[2].width).toBe(spec.tires.rear.width);
      // hub height: ground at −cgHeight, hub at ground + radius
      expect(g.wheels[0].cz).toBeCloseTo(-spec.cgHeight + spec.tires.front.radius, 12);
      const body = g.boxes.find((x) => x.role === 'body')!;
      expect(body.sx).toBeGreaterThanOrEqual(spec.length - 1e-9);
      expect(body.sy).toBeGreaterThanOrEqual(spec.width - 1e-9);
      const hasWing = g.boxes.some((x) => x.role === 'wing');
      expect(hasWing).toBe(spec.aero.liftAreaRear > 0.15);
      // compression moves the hub up, clamped to travel
      const w = g.wheels[0];
      expect(wheelHubZ(w, { compression: 0.02 }, 0.1)).toBeCloseTo(w.cz + 0.02, 12);
      expect(wheelHubZ(w, { compression: 5 }, 0.1)).toBeCloseTo(w.cz + 0.1, 12);
      expect(wheelHubZ(w, { compression: NaN }, 0.1)).toBeCloseTo(w.cz, 12);
    }
  });
});
