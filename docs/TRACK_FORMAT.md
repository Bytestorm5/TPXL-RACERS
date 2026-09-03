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
  (end one segment at the % the next one starts with) — a jump > 10 % warns.
- **Hairpin:** small radius, big angle: `{ "length": 69.1, "radius": 22, "turn": "left" }`
  is 180°. Beware `curvature × width > 1.6`: the inner edge radius approaches zero and
  the compiler warns that the edge folds.
- **Surface patch:** just a segment with a different `surface`; use `lanes` for partial-
  width patches (ice on the exit kerb, a dirt strip).

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
- `bounds`, `issues`, `startLine`, `ambientTemp`, `airDensity`.

## Validation summary

Errors: no segments; segment `length ≤ 0`; any width ≤ 0; unknown surface kind;
|bank| > 45°; |grade| > 30 %; `radius` together with `curvature`; `radius ≤ 0`;
lane span outside ±width/2; circuit closure error > `maxClosureError`; stage
`startLine` beyond the track length.

Warnings: `curvature × width > 1.6` (inner edge folds); bank changing faster than
8° per 10 m (within a segment, or jumping > 8° at a boundary); grade changing faster
than 10 % per 10 m (or jumping > 10 % at a boundary); segments shorter than the sample
step; circuit closure error between 2 m and `maxClosureError`.
