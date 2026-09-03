# Module notes — track (src/sim/track.ts, src/tracks/*)

Author: track-standard agent. Status: complete; `npx tsc --noEmit` and
`npx vitest run tests/track.test.ts` (27 tests) pass.

## What was implemented

- `validateTrack(spec)` — structural checks + closure check for circuits (full list at
  the bottom of docs/TRACK_FORMAT.md).
- `compileTrack(spec)` — the full `CompiledTrack`: sampled centreline, `centreAt`,
  `project` (spatial hash + hint window + sub-sample refinement), `poseAt`, `gridSlot`,
  `sampleAt` (RoadQuery), `bounds`, `issues`, `startLine`, ambient/air density.
- Six built-in tracks in `src/tracks/*.json`, exported as `BUILTIN_TRACKS` from
  `src/tracks/index.ts`: speedbowl (2 400.0 m banked oval), ridgeway (4 817.0 m GP
  reference circuit), pinecone-stage (6 440.4 m rally stage, open), clubsprint
  (1 671.3 m club track), glacier-loop (2 579.1 m snow/ice), dunes-rallycross
  (1 587.2 m gravel/dirt rallycross loop with a 250 m tarmac joker, tabletop jump and
  an R18 hairpin). All compile with **zero issues**; circuit closure errors before
  blending: 0.001–0.038 m (checked by solving the loop geometry numerically at design
  time, not guessed).
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
  than 0.6·width off the centreline. Refinement solves the along-track residual
  `f(s) = (p−C(s))·t̂(s) = 0` against the *interpolated* pose (position and heading both
  lerped between samples) — this makes `project` the exact inverse of `poseAt`
  (round-trip < 0.05 m in s, < 0.01 m in lateral on every built-in, tested):
  1. chord projection onto the two polyline segments adjacent to the nearest sample —
     only within ~½·|lateral·κ|·step of the root, because the chord normal is not the
     lerped heading (0.25 m at |lateral·κ| = 0.5 with a 1 m step);
  2. Newton with the analytic slope `f′ = −C′·t̂ + ((p−C)·n̂)·θ′ ≈ −(1 − lateral·κ)`,
     converging in 2–3 iterations for any |lateral·κ| ≲ 0.9 (budget 8, tolerance 1e-7 m,
     step clamped to ±3 sample steps). The earlier fixed-point `s ← s + f` contracted only
     at rate |lateral·κ| per iteration and stalled beyond ≈ 0.35 within its budget, falling
     back to the raw chord estimate — a 0.12–0.25 m error on tight hairpins, which forced
     built-in authors onto gentler hairpins (dunes: R18 on 11 m, |lateral·κ| = 0.31);
  3. if Newton is ill-conditioned (|f′| < 0.1) or has not converged, bisection on a sign
     change of f bracketed within ±1…4 steps of the chord estimate (f is monotone through
     the projection wherever it exists);
  4. no bracket ⇒ the point is at/inside the centre of curvature (|lateral·κ| ≥ 1) where s
     is genuinely ambiguous — the chord result is kept.
  Tested exact (< 1e-4 m) on R10/10 m and R8/8 m hairpins (|lateral·κ| = 0.5 at the
  edges) and at |lateral·κ| = 0.8, hinted and unhinted, stage and circuit (incl. across the
  seam). Authors may now use hairpins down to width/R ≈ 1.6 (the fold warning) without
  degrading `project`. 100k hinted calls run in well under 300 ms (tested; ~110 ms, the
  cost is the ±30 m sample scan, not the refinement).

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
- The six built-ins: use `ridgeway` as the lap-time reference; `speedbowl` Turn 1/2
  core bank is exactly 24° (`deg2rad(24)`), reached 60 m into each turn.
- `project` is exact for any |lateral·curvature| < 1 (inside the fold radius). Inside a
  corner's centre of curvature s is ambiguous by construction; the result there is the
  nearest polyline point, still finite and on the right part of the track.
