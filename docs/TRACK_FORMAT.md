# RACERS track format (v1) — modder reference

A track is a single JSON file: a list of **segments** laid end-to-end along a centreline.
Each segment is a clothoid-like piece — curvature, width, bank and grade may each be a
constant or vary linearly over the segment. That is enough to author straights, arcs,
hairpins, banked bowls, crests and surface changes in a few lines. No decor, no meshes.

Load order: `validateTrack(spec)` reports problems, `compileTrack(spec)` produces the
runnable track (it validates too — see `issues` on the result). Types live in
`src/sim/trackTypes.ts`; the built-in tracks in `src/tracks/*.json` are working examples.

## Coordinates, units and sign conventions

| Thing | Convention |
|---|---|
| World frame | x east, y north, z up. Metres everywhere. |
| Heading | Radians internally; 0 = +x (east), **counter-clockwise positive**. The centreline starts at `start` (default origin, heading 0). |
| `s` | Arc length along the centreline from the start, in metres. |
| Curvature | 1/m. **Positive = left turn.** `radius` + `turn: 'right'` compiles to negative curvature. |
| Lateral offset | Metres from the centreline, **positive = LEFT** of the direction of travel. |
| Bank | **Degrees** in the spec. Positive = the **right edge is higher** — a road banked to help a *left* turn. So the left side of a positively banked road is *lower*: `z(lateral) = z_centre − lateral·tan(bank)`. |
| Grade | **Percent** in the spec: `5` means 5 % uphill (rises 5 m per 100 m of track). Compiled to radians as `atan(grade/100)`. |

## TrackSpec fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `format` | `1` | required | Format version. |
| `id`, `name` | string | required | Machine id / display name. |
| `author`, `description` | string | — | Credits and a one-liner for the track select screen. |
| `closed` | boolean | required | `true` = circuit (laps, wraps around), `false` = point-to-point stage. |
| `start` | `{x?,y?,z?,heading?}` | `{0,0,0,0}` | Pose of the first centreline point. |
| `startLine` | number (m) | `0` | Arc length of the start/finish line. For stages this is where cars start. Must be ≤ track length for stages; wraps for circuits. |
| `gridSpacing` | number (m) | `8` | Distance between grid rows (see Grid below). |
| `defaultWidth` | number (m) | required | Track width where a segment doesn't override it. |
| `defaultSurface` | SurfaceKind | required | Surface of the main width. |
| `defaultShoulder` | SurfaceKind | required | Surface beyond the width (run-off). |
| `ambientTemp` | °C | `22` | Air/track ambient temperature. |
| `sampleStep` | number (m) | `1` | Centreline sampling resolution. Leave at 1 unless you know why. |
| `closureBlend` | number (m) | `max(50, 20 % of length)` | Over how many final metres a circuit's closure error is smoothed away. |
| `maxClosureError` | number (m) | `25` | Closure error above this is a validation **error**. |
| `segments` | TrackSegment[] | required | The track itself, in driving order. |

Surface kinds: `asphalt`, `concrete`, `wet_asphalt`, `curb`, `gravel`, `dirt`, `grass`,
`sand`, `snow`, `ice` (see `src/sim/surface.ts` for their grip/drag numbers).

## TrackSegment fields

Every "Ramp" value is either a number (constant) or `[startValue, endValue]`
(linear from the segment start to its end).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `length` | number (m) | required | Length along the centreline. Must be > 0. |
| `curvature` | Ramp (1/m) | `0` | Positive = left. Prefer `radius` for readability. |
| `radius` + `turn` | Ramp (m) + `'left'\|'right'` | — | Convenience for `curvature = ±1/radius`. A radius ramp `[r0, r1]` interpolates the *radius* linearly. Mutually exclusive with `curvature`; radius must be > 0. `turn` defaults to `'left'` if omitted. |
| `width` | Ramp (m) | `defaultWidth` | Total width, centred on the centreline. |
| `bank` | Ramp (deg) | `0` | Positive = right edge higher. Keep |bank| ≤ 45°. |
| `grade` | Ramp (%) | `0` | Positive = uphill. Keep |grade| ≤ 30 %. |
| `surface` | SurfaceKind | `defaultSurface` | Main-width surface. |
| `shoulder` | SurfaceKind | `defaultShoulder` | Beyond-the-width surface. |
| `lanes` | TrackLane[] | — | Lateral strips that override `surface` inside their span. |
| `name` | string | — | "Turn 1", "Crest" — used by UI/telemetry. |

### Lanes (curbs, patches)

A lane is `{ "span": [from, to], "surface": kind }` with `from`/`to` in metres from the
centreline, positive left. Spans must lie within the track width (±width/2). The first
lane whose span contains the query's lateral offset wins; outside all lanes you get the
segment `surface` (on track) or `shoulder` (off track).

A 1.5 m curb on the **inside of a left turn** (inside = left = positive lateral, for a
13 m wide track): `{ "span": [5, 6.5], "surface": "curb" }`.
On the inside of a **right** turn: `{ "span": [-6.5, -5], "surface": "curb" }`.

## The closure rule (circuits)

You are not expected to close a loop to the millimetre. The compiler measures the gap
between the end of the last segment and the start pose (position, heading and elevation)
and, for `closed: true`, distributes the correction smoothly (smoothstep weighting —
zero at the blend start, full at the line) over the final `closureBlend` metres:

- error ≤ 2 m: fixed silently;
- 2 m < error ≤ `maxClosureError`: fixed, but you get a **warning** — tighten your geometry;
- error > `maxClosureError` (default 25 m): a validation **error**. The track still
  compiles (so you can look at it), but fix it before shipping.

**How to make a loop close:** the signed turn angles must sum to **+360°** (counter-
clockwise loop) or −360° (clockwise). A segment's turn angle is `length / radius`
(radians) — so a 90° left of radius 50 needs `length = 50 × π/2 ≈ 78.54`. Then opposite
straights must match: everything east must be cancelled by everything west, same for
north/south. Easiest recipe: use only 90°/180° turns so every leg is axis-aligned, make
opposing legs equal, then let the blend absorb the last centimetres. Elevation must also
return to the start: the sum of `mean(grade%) × length` over all segments should be ≈ 0.

## Grid

`gridSlot(i)` (index 0 = pole) places cars **behind the start line** in two staggered
columns: slot *i* sits at `s = startLine − 8 − i × gridSpacing/2`, even indices at
lateral +width/4, odd at −width/4. On circuits the grid happily wraps past s = 0.
On stages slots never go below s = 0: slots that would, line up single-file **ahead**
of the line (lateral 0) at `s = startLine + 2 + k × gridSpacing`. With the default
`startLine: 0` on a stage, the whole field lines up this way, rally-style.

## Recipes

- **Bank a corner:** don't jump straight to full bank — ramp it over ~40–60 m on entry
  and exit. Three segments: `bank: [0, 24]` (entry), `bank: 24` (core), `bank: [24, 0]`
  (exit), all with the same radius. Jumps of more than 8° per 10 m earn a warning.
- **Crest / jump-feeling hill:** a short segment whose grade ramps from up to down, e.g.
  `{ "length": 40, "grade": [6, -6] }`. Keep grade continuous across segment borders
  (end one segment at the % the next one starts with) — a jump > 10 % warns. For crests
  that actually launch the car see *Jumps, crests and off-camber corners* below.
- **Hairpin:** small radius, big angle: `{ "length": 69.1, "radius": 22, "turn": "left" }`
  is 180°. Beware `curvature × width > 1.6`: the inner edge radius approaches zero and
  the compiler warns that the edge folds.
- **Surface patch:** just a segment with a different `surface`; use `lanes` for partial-
  width patches (ice on the exit kerb, a dirt strip).

## Jumps, crests and off-camber corners

The vehicle is a 6-DOF body on struts: it really leaves the ground over a crest and
really rolls on an off-camber corner. The road is a piecewise-linear grade/bank profile
sampled every metre, so these features are just grade and bank ramps — the trick is
getting the numbers right.

**Sign rules (worth re-reading):**

- `grade` + = uphill. A car launches where the grade *falls* quickly (up → down).
- `bank` + = **right edge higher**. A corner is *helped* when the outside edge is higher:
  a **left** turn wants **positive** bank, a **right** turn wants **negative** bank.
- Therefore **off-camber = outside edge lower**: an off-camber **left** turn has
  **negative** bank, an off-camber **right** turn has **positive** bank.

**Rate limits (warning thresholds — the built-ins ship with zero warnings):** within a
segment grade may change at most 10 % per 10 m and bank 8° per 10 m, so a change of Δ
points needs a segment at least Δ metres long (0 → +16 % needs ≥ 16 m). At a segment
*boundary* a step of up to 10 points of grade (8° of bank) is allowed — the check is
"more than 10". That boundary step is the only way to author a sharp takeoff edge, see
below; keep it ≤ 6 points so a future tightening of the rule does not bite.

**When does a car get light or fly?** A grade change of Δg (rad) spread over L metres
bends the road with a vertical radius R ≈ L/Δg. A car at speed v follows the road only
while v²/R < g ≈ 9.81 m/s²: at v²/R ≈ 0.5 g the struts unload by half (mid-corner that
means a slide), at v²/R ≥ g the wheels leave the ground. At the maximum warning-free ramp
rate (10 %/10 m) R ≈ 100 m, so a *pure ramp* only launches a car above √(g·R) ≈ 31 m/s
= 113 km/h — the road keeps rising under a +16 % lip for 16 more metres and a 90 km/h
car simply follows it. Fine for ridgeway's `Crest` (GP speeds) or a fast downhill kicker,
useless for a rallycross car. For a real lip put a **boundary step** at the takeoff edge:
`grade: 16` on the table, the next segment starting at `[10, …]`. The road then falls
away from the takeoff tangent by `0.06·x + ½·(ramp rate)·x²` — about 1.07 m after 10 m
with the recipe below — and a car is airborne as soon as its ballistic drop `g·x²/(2v²)`
is smaller than that: ≈ 80 km/h here; at 100 km/h it flies ~28 m, at 120 km/h ~47 m,
peaking `v·sin(atan(0.16))` ≈ 4.4 m/s → ~1 m above the lip. Land on a downslope
(−6…−10 %) that is long enough for the fastest car you expect, then ramp back to flat;
landing on flat or uphill is harsh.

**Recipe — tabletop jump (dunes-rallycross, `Tabletop Ramp` … `Landing Out`):**

```jsonc
{ "length": 180, "name": "Start Straight" },                 // the run-up: straight, ≥ 120 m
{ "length": 18, "grade": [0, 16], "name": "Tabletop Ramp" }, // 0 → +16 % (8.9 %/10 m)
{ "length": 6,  "grade": 16,      "name": "Tabletop" },      // hold the lip — cars leave here
{ "length": 19, "grade": [10, -8], "name": "Tabletop Drop" },// 6-point edge, then 18 pts/19 m
{ "length": 28, "grade": -8,      "name": "Landing" },       // downslope landing, ≥ 45 m past the lip
{ "length": 8,  "grade": [-8, 0], "name": "Landing Out" }    // back to flat before the corner
```

Place it on a straight where cars arrive at 80–120 km/h and leave ≥ 50 m of straight
after `Landing Out` so the car has settled before it must turn. As written the table is
elevation-neutral to 3 cm (1.44 + 0.96 + 0.19 − 2.24 − 0.32 m); if you change a length,
re-sum `mean(grade) × length` or the compiler reports the difference as closure error.

**Recipe — crest (ridgeway `Crest`, pinecone `Kicker Jump`):** a single segment whose grade
goes from the climb value to the descent value at (nearly) the maximum rate, with the
neighbours continuing those grades: `{ "length": 15, "grade": [6, -7] }` after a +6 %
climb and before a −7 % section (R ≈ 115 m: airborne above ~120 km/h, which a GP car
has there). Pinecone's kicker adds the lip step for lower speeds: `[-6, 12]` over 40 m,
then `{ "length": 17, "grade": [6, -10] }`, then a `[-10, -7]` landing. For a mid-corner
crest put the ramp on a segment that keeps the corner's `radius` (dunes `Sweeper Crest`:
`{ "length": 17, "radius": 80, "turn": "left", "grade": [8, -8] }`, R ≈ 106 m) — the car
unloads by half at 80 km/h while it is still turning, which on gravel is a slide.
Bracket a crest with the *approach* and *landing* grades so the elevation sums to what
you want; a symmetric `[g, -g]` crest is elevation-neutral only if the surroundings are.

**Recipe — off-camber corner (dunes `Turn 2`, pinecone `Downhill Right`, ridgeway `Final
Corner Entry`):** three segments with the same radius and turn: entry `bank: [0, b]`,
core `bank: b`, exit `bank: [b, 0]`, where `b` is **negative for a left turn** and
**positive for a right turn** (see the sign rules). Ramp lengths ≥ 1.25 m per degree
(15 m for 6°, 20 m for 4° is comfortable). −6° on dirt costs roughly 10 % of cornering
speed and loads the outside struts hard. A subtler trap is a corner that *becomes*
helpful mid-way (ridgeway's Final Corner: 30 m at −2°, then a fourth segment
`bank: [-2, 6]` between entry and core builds the +6° the driver expected from the
start). Check with `compileTrack(spec).poseAt(s, ±width/2).z`: on an off-camber stretch
the outside edge must be the lower one.

## Loading your own tracks (desktop app)

The desktop build scans `<user data>/tracks/*.json` at start-up (menu → *Game → Open tracks folder*,
or the *Track mods* panel on the Race setup screen; *Reload tracks* re-scans without a restart). Each
file must be a single `TrackSpec` (format 1). Files that fail to parse or that `validateTrack`
rejects are listed with the reason; ids must be unique and cannot reuse a built-in id. Warnings
(closure error above 2 m, sharp hairpins) still load. In the browser build only the built-in tracks
in `src/tracks/` are available — add a file there and an entry in `src/tracks/index.ts`.

The 3D view builds the road mesh straight from the compiled samples: width, lanes (curbs), banking
and grade all appear as authored; the shoulder is a 7 m band of the `shoulder` surface, the terrain
beyond it is generated.

## Worked example

A ~482 m test loop: two straights and two 180° left turns (radius 50 → turn length
50·π ≈ 157.08), the second corner banked, a curb on the inside of Turn 1.

```jsonc
{
  "format": 1,
  "id": "paperclip",
  "name": "Paperclip",
  "author": "you",
  "description": "Two straights, two hairpins.",
  "closed": true,          // a circuit: the compiler will close the loop
  "startLine": 40,         // 40 m into the first straight
  "defaultWidth": 12,
  "defaultSurface": "asphalt",
  "defaultShoulder": "grass",
  "segments": [
    { "length": 84, "name": "Front Straight" },
    { "length": 157.08, "radius": 50, "turn": "left", "name": "Turn 1",
      "lanes": [ { "span": [4.5, 6], "surface": "curb" } ] },   // inside curb (left)
    { "length": 84, "name": "Back Straight", "grade": [0, 2] }, // gentle rise…
    { "length": 157.08, "radius": 50, "turn": "left", "name": "Turn 2",
      "bank": [0, 10], "grade": [2, -2] }                       // …banked, cresting corner
  ]
}
```

Check: turn angles 180° + 180° = 360° ✓; straights are equal and opposite ✓; elevation:
the rise is 84 × mean(1 %) ≈ 0.84 m and Turn 2's grade `[2, -2]` averages to zero, so
~0.84 m is left over — under 2 m, silently blended. This example compiles with an empty
issue list. Two deliberate rough edges to be aware of: bank ends at 10° and grade at
−2 % exactly at the finish line, wrapping onto the flat Front Straight. Boundary-jump
warnings only check consecutive segments in the list (not the wrap-around), so this
passes — but on a real track, ramp bank and grade back before the final segment ends.

## What the compiler gives you (`CompiledTrack`)

- `length`, `samples` (one per `sampleStep`, uniform; circuits drop the duplicate end
  sample so `samples[0]` seamlessly follows the last one);
- `centreAt(s)` — interpolated centreline sample (wraps on circuits, clamps on stages);
- `project(x, y, hintS?)` — nearest-centreline arc length, signed lateral offset
  (+left) and distance; pass the previous result as `hintS` to make it O(1);
- `poseAt(s, lateral)` / `gridSlot(i)` — world poses;
- `sampleAt(x, y, heading)` — the `RoadQuery` used by the physics: surface under the
  point, `gradeAlong`/`bankAcross` resolved along the *query* heading, elevation, and
  on-track state;
- `bounds`, `issues`, `startLine`, `ambientTemp`, `airDensity`;
- `closureError` / `closureHeadingError` — the circuit's raw closure gap (m / rad)
  measured *before* the blend (0 for stages), for editors and diagnostics.

## Validation summary

Errors: no segments; segment `length ≤ 0`; any width ≤ 0; unknown surface kind;
|bank| > 45°; |grade| > 30 %; `radius` together with `curvature`; `radius ≤ 0`;
lane span outside ±width/2; circuit closure error > `maxClosureError`; stage
`startLine` beyond the track length.

Warnings: `curvature × width > 1.6` (inner edge folds); bank changing faster than
8° per 10 m (within a segment, or jumping > 8° at a boundary); grade changing faster
than 10 % per 10 m (or jumping > 10 % at a boundary); segments shorter than the sample
step; circuit closure error between 2 m and `maxClosureError`.
