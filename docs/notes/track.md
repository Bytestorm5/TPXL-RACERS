# Module notes — track (src/sim/track.ts, src/tracks/*)

Author: track-standard agent. Status: complete; `npx tsc --noEmit` and
`npx vitest run tests/track.test.ts` (23 tests) pass.

## What was implemented

- `validateTrack(spec)` — structural checks + closure check for circuits (full list at
  the bottom of docs/TRACK_FORMAT.md).
- `compileTrack(spec)` — the full `CompiledTrack`: sampled centreline, `centreAt`,
  `project` (spatial hash + hint window + sub-sample refinement), `poseAt`, `gridSlot`,
  `sampleAt` (RoadQuery), `bounds`, `issues`, `startLine`, ambient/air density.
- Five built-in tracks in `src/tracks/*.json`, exported as `BUILTIN_TRACKS` from
  `src/tracks/index.ts`: speedbowl (2 400.0 m banked oval), ridgeway (4 817.0 m GP
  reference circuit), pinecone-stage (6 440.4 m rally stage, open), clubsprint
  (1 671.3 m club track), glacier-loop (2 579.1 m snow/ice). All compile with **zero
  issues**; circuit closure errors before blending: 0.001–0.038 m (checked by solving
  the loop geometry numerically at design time, not guessed).
- docs/TRACK_FORMAT.md — modder-facing reference.

## Key formulas

- **Heading integration**: within a segment curvature is linear in s, so
  Δθ = (κ₀+κ₁)/2·Δs is *exact* per integration piece; pieces are split at segment
  boundaries and at every sample step.
- **Position integration**: exact circular chord — `chord = Δs·sinc(Δθ/2)` along the
  mid-heading θ+Δθ/2. Exact (machine precision) for constant curvature, 2nd order for
  clothoid ramps; the arc test pins 1e-6 relative accuracy.
- **Elevation**: dz/ds = grade%/100 (trapezoid; exact for linear percent ramps). So `s`
  is *plan* (horizontal) arc length; see assumptions.
- **Closure blend**: correction (Δx, Δy, Δz, Δθ measured start-minus-end) is applied
  weighted by `smoothstep(L−B, L, s)` over the final B = `closureBlend` metres
  (default max(50, 0.2·L)), then the duplicate end sample is dropped. Error ≤ 2 m is
  silent, ≤ maxClosureError (25) warns, above that errors (but still compiles).
- **Road plane at a point** (`sampleAt`): local plane through the centreline point:
  `grad = tan(grade)·t̂ + tan(bank)·r̂`, t̂ = (cos θ, sin θ), r̂ = (sin θ, −cos θ);
  `z = z_c − lateral·tan(bank)`; `gradeAlong = atan(grad·ĥ)`,
  `bankAcross = atan(grad·right(ĥ))` for the *query* heading ĥ. Signs verified by test:
  +5 % grade driven forward → +atan(0.05), backwards → −atan(0.05); +10° banked left
  turn driven with the track → bankAcross = +10°, against → −10°; positive bank lowers
  the left side.
- **Projection**: uniform spatial hash (8 m cells) over samples with expanding-ring
  search for the global path; hinted path scans samples within ±30 m of the hint and
  bails to global when the local minimum sits on the window boundary or ends up farther
  than 0.6·width off the centreline. Refinement: chord projection onto the two adjacent
  polyline segments, then ≤ 12 fixed-point iterations `s ← s + (p−C(s))·t̂(s)` against
  the *interpolated* pose — this makes `project` the exact inverse of `poseAt`
  (round-trip < 0.05 m in s, < 0.01 m in lateral on every built-in, tested).
  Convergence needs |lateral·curvature| < 1; past a corner's centre of curvature the
  chord result is kept. 100k hinted calls run in well under 300 ms (tested).

## Simplifications / assumptions (for docs/ASSUMPTIONS.md — Track section)

- `s` is plan arc length; grade tilts the road but does not stretch s (dz/ds =
  grade/100, not sin·…). Consistent everywhere (compiler, queries, tests).
- Between samples the centreline is a straight chord with lerped heading/curvature/z;
  max radial error vs the true arc is κ·step²/8 (≈ 6 mm at R = 20 m, 1 m step).
- The closure blend shifts positions/headings/elevation without re-integrating, so in
  the blend zone heading ≠ exact tangent of the shifted polyline (bounded by
  error·1.5/blendLength — negligible for legal closure errors) and sample spacing there
  differs slightly from `s` deltas.
- Closed tracks quietly use an *effective* sample step `L/round(L/step)` so the seam
  interval equals every other interval (samples stay uniform; `samples[i].s = i·step`
  still holds with that effective step).
- A radius ramp `[r0, r1]` interpolates radius linearly (so curvature is 1/lerp(r), not
  a true clothoid — visually indistinguishable at track scale).
- Bank rotates the road about the centreline: the width is not foreshortened in plan and
  edge elevation is ±(w/2)·tan(bank). Curvature × width > 1.6 warns (inner edge
  degenerates).
- Lane spans are validated against ±width/2 (a lane cannot live outside the track).
- Degenerate specs (no segments / zero length) still compile to a 1-sample track so
  callers never crash; the issues list carries the errors.
- `sampleAt` has no hint parameter, so it keeps a 128-entry LRU (8 m cell → last s)
  plus the last result as fallback hint. Same x,y cell repeatedly queried = local
  search only. This makes it cheap at 120 Hz but means `sampleAt` is not pure —
  callers on the sim thread only (it is deterministic regardless; no RNG anywhere).
- Grid: rows every gridSpacing/2 alternating ±width/4; stages place non-fitting slots
  single-file *ahead* of the start line (s ≥ 0 guaranteed) — with startLine 0 the whole
  field starts ahead of the line, rally-style.
- `bounds` covers centre ± width/2 only (shoulders extend beyond bounds).

## For other module authors

- `compileTrack(spec)` **is** the `RoadQuery` you need: pass it wherever a `RoadQuery`
  goes; `ambientTemp` and `airDensity` are on it.
- `sampleAt(x, y, heading)` resolves `gradeAlong`/`bankAcross` along **your** heading —
  don't re-project gravity yourself. `surface` is already the `SurfaceProps` object
  (lanes/curbs/shoulder resolved).
- For per-wheel queries call `sampleAt` at each contact patch; repeated nearby calls hit
  the cache. If you track a car's own `s`, prefer `project(x, y, lastS)` and keep
  `lastS` yourself — that is the fastest path.
- `project(...).lateral` is positive LEFT of the track direction; `RoadSample.lateral`
  likewise. AI: `poseAt(s, lateral)` gives you racing-line targets; `centreAt(s).width`
  varies along the track, don't cache halfWidth globally.
- Stage grids: `gridSlot(i)` can place cars *ahead* of `startLine` (see above) — timing
  should start when the car crosses `startLine`, not at spawn.
- The five built-ins: use `ridgeway` as the lap-time reference; `speedbowl` Turn 1/2
  core bank is exactly 24° (`deg2rad(24)`), reached 60 m into each turn.
