# Simulation assumptions & simplifications

This is a game. We model the terms that produce the *feel* and the design trade-offs and we skip the
rest. Every simplification we knowingly make lives here so we can revisit it. Agents/contributors:
append to the relevant section when you simplify something. (Merged from every module's
`docs/notes/*.md` by the integrator; the notes keep the derivations and the per-module detail.)

## Global
- The chassis is a 6-DOF rigid body (x, y, z, yaw, pitch, roll) resting on four massless
  spring/damper struts. Load transfer, dive/squat, body roll, jumps (struts reach full droop → no
  contact → ballistic flight) and rollovers (inner wheels lift, CG passes over the outer contact
  line) all emerge from that one model. Wheels themselves have no vertical mass (no wheel hop).
- Attitude is a quaternion internally; the reported Euler angles are ill-conditioned (but finite)
  only at exactly ±90° of pitch. Above 55° of tilt the struts are switched off and the car is a
  tumbling box whose eight corners collide with the ground (penalty springs), so a rollover tumbles
  and settles; the car is then `wrecked` and reset by the race manager.
- Fixed 120 Hz step with internal 240 Hz substeps, semi-implicit Euler.
- No fuel consumption effects on mass mid-race, no engine temperature, no damage.
- Deterministic: no `Math.random()` anywhere in `src/sim`; the only randomness is the seeded
  per-driver variation of the AI (`makeRng`). Replays are bit-identical on a freshly compiled track;
  a compiled track's `sampleAt` hint cache can shift a shared track's answer at the ~1e-9 level.
- Pre-heated race starts (`RaceConfig.preheatTyres`, default true) are a formation-lap simplification:
  tyres start at `optimalTemp − 15 °C` and brakes at 120 °C, and a car put back on the road by a
  reset comes back at working temperature too (raise-only) — cold slicks on a gravel climb would
  otherwise strand it at the same spot forever. With `preheatTyres: false` everything starts at
  ambient and cold compounds are treacherous on lap 1.

## Design layer (build → spec)
- All part masses are point masses on the wheelbase line: the CG is 1-D longitudinal plus a scalar
  height; no lateral asymmetry (the driver sits on the centreline).
- Part positions are fixed fractions of the wheelbase (engine −0.12 / 0.18 / 0.72 / 1.08 for
  front / front-mid / mid / rear, gearbox 0.35 or 0.92, chassis 0.5, driver 0.45, fuel 0.85, wheels at
  the axles); no packaging conflicts. The default engine position is front-mid (a pure front engine
  lands ~57 % front with these positions).
- Tyre scaling laws are power-law heuristics around the 205 / 220 kPa / 17" reference (see
  DESIGN_MODEL.md), not measured carcass data; the overall wheel diameter is held ≈ 0.67 m so gearing
  is rim-independent.
- Brake torque = fixed 25 kN clamp × pad μ × 40 % of the disc diameter — pedal / master-cylinder
  hydraulics are not modelled; ducts only raise the convective coefficient.
- Roll stiffness = 0.5 × spring rate × track² + slider × 50 kNm/rad; no motion ratios, no geometry
  change with ride height beyond `rollCentre = 0.3 × ride`.
- Aero coefficients are additive in splitter / wing / underbody; wing and splitter drag is folded
  into `dragArea` (the aero module models no induced drag); the base body has slight lift
  (−0.05 / −0.04 lift-area factors). Lowering the car reduces drag (±5 %), the opposite of the
  original brief's sign.
- `compileBuild` normalises first: an out-of-range build silently compiles to its clamped self.
- `CHASSIS_SIZES.baseMass` was re-tuned downward by ~0.8 (2026-09-03) so compiled cars land on
  their design targets (Club Hatch ~1148 kg, default ~1397 kg); the presets' brake bias was
  re-solved for the lighter, slightly more nose-heavy cars.

## Tyres
- Single contact-patch model, no relaxation length, no transient slip: forces respond instantly to
  slip. The vehicle model owns the low-speed slip regularisation (1.5 m/s).
- One temperature per tyre (no surface / core / carcass split, no across-tread gradient); cooling is
  linear in `(T − ambient)` with a `(1 + v/20)` speed term and a per-compound `coolingScale` (thick
  slick tread holds its heat: 0.7–0.8; road tyres 1.0–1.1). Rolling-resistance power heats the tyre
  in full (it is hysteresis) — this is what keeps the undriven axle of a FWD car off ambient.
- Heating counts the slip power with the sliding speed of each axis saturated at 3 m/s
  (`TIRE_HEAT_SLIP_SPEED_CAP`): at the grip peak all of the slip energy warms the tyre, a burnout or a
  locked wheel sliding at 10–30 m/s mostly abrades and smokes the surface layer. On loose surfaces
  only `1 − slideRetention` of the slip power reaches the rubber (gravel 0.4, ice 0.2): the stones
  move, the tyre does not cook. Wear still counts the full slip power. Calibration (AI on
  clubsprint): the Track Weapon's medium slicks settle around their 92 °C optimum, sport tyres
  ~10–15 °C below their 70 °C optimum, a 2 s burnout costs ~20 °C; a FWD car still runs its driven
  fronts ~30 °C hotter than its rears.
- Grip window is ASYMMETRIC: below the optimum a Gaussian on `coldGripFloor` (glassy rubber, 0.4–0.8
  by compound), above it a wider Gaussian (1.6 × `tempWindow`) on `hotGripFloor` (greasy rubber,
  0.70–0.85) — a tyre 40 °C over its optimum keeps ~85–90 % of its grip, one 40 °C under keeps
  55–75 %. No graining / blistering hysteresis, no thermal wear. (The first model was symmetric
  with one floor: three hard stops on warm slicks then cut grip to ~50 %, which read as "the tyres
  glide"; hot rubber does not do that — it goes off, gradually.)
- One temperature per tyre with an effective thermal mass of ≈ 1.5 kJ/°C (`TIRE_HEATING_BASE`
  0.65e-3 °C/J) — about a kilogram of tread, not the whole tyre: the surface layer is what the grip
  responds to. Heating and cooling are scaled together, so the hot-lap equilibrium is calibrated,
  while a single 200 km/h stop on warm slicks costs ~20 °C (the surface spike a real tyre shows),
  not the 30–40 °C a heavier model with the same equilibrium would need.
- Load sensitivity linear in load ratio above the optimum (floor 0.25), quadratic penalty below.
  Compile puts `optimalLoad` near the static corner load so the game's 1–2.5× transfers stay on the
  rising side of total force.
- Camber is a static ellipse scaling — no camber thrust at zero slip; the vehicle model passes the
  roll-induced camber (`static ± (roll + bank)`).
- Sliding friction is speed-independent (`slideMuRatio` a constant); the post-peak decay is a fixed
  shape in normalised slip. The magic-formula rise cannot carry `k > k_max(slide)` for sliding
  ratios below ~0.63 — stiffness is silently capped there.
- Wear only from slip energy (no thermal wear, no flat-spotting); it reduces grip linearly.
- Surfaces scale grip, peak slip and slide retention; no wet / dry transition, no rubbering-in, no
  marbles. Roughness only adds load noise.
- Slicks keep only 55–60 % of their grip on grass / gravel and 40–50 % when cold: a slick-shod car
  at ambient temperature cannot climb an 8 % grass or gravel slope at all (grip below grade plus
  rolling resistance) — that is physics, not a bug; warm it climbs slowly.

## Brakes
- Single thermal node per wheel (disc + pad share one temperature); no pad / disc gradient, no
  caliper or fluid temperature, so no "boiled fluid" long pedal — only pad fade.
- Convective cooling linear in `(T − Tamb)`, multiplied by `(1 + |v|/15)`; the radiative term uses
  the game formula `1e-3·coolingCoeff·((T/100)⁴ − (Tamb/100)⁴)` in °C (not Kelvin) and is small
  (≈ 0.75 % of convection at 900 °C) — convection was tuned to carry the load instead.
- Cold bite: a fixed 20 °C reference regardless of ambient; below 20 °C the pad sits at `coldFactor`.
- Effectiveness has no hysteresis (glazing, bedding-in and pad wear are not modelled).
- Temperature ceiling 1200 °C, floor ambient − 1 °C (hard clamps, not physics).
- Brake bias is a bias bar: `bias` is the front share of the TOTAL torque; the stronger axle sees full
  line pressure and the other is reduced (`brakeLinePressures`, implemented identically in
  `design/analyze.ts` and `sim/vehicle.ts` — the designer never imports the sim; a test pins both
  copies equal). A locked wheel's energy goes into the tyre, not the disc.

## Engine & drivetrain
- Torque curve is a static BMEP × envelope synthesis: no VE map, no intake / exhaust modelling;
  cylinder count is a 1 %-per-cylinder BMEP nudge plus the idle rpm. Boost is a BMEP multiplier with
  a fixed smoothstep spool band (0.2–0.45 × redline) — no boost dynamics beyond the first-order
  `throttleResponse` lag (0.05 + 0.25 × boost for a turbo). Supercharger parasitic loss is a
  multiplicative `1 − 0.06 × boost` on torque.
- Fuel cut above the limiter is a hard zero on the positive part (no soft-limiter bounce); engine
  braking scales linearly with rpm, capped at 1.5 × redline, and never depends on gear. Below idle the
  curve holds the idle torque — the vehicle model owns the idle governor and the launch clutch.
- Ideal, lossless differentials (`left + right = axle torque`); gearbox / final-drive losses are one
  efficiency factor applied to torque magnitude in both directions (coast too).
- Reverse ratio = 1.1 × first gear; no reverse entry in `gearRatios`. Gearbox mass / inertia are
  affine in gear count; geometric ratio spread when no explicit ratios are given.
- AWD is a fixed front / rear torque split; no centre differential, no torque vectoring, no inter-axle
  speed coupling.
- LSD is a torque-sensing clutch pack with no preload (zero input torque ⇒ zero transfer) and a
  regularised (tanh) speed response instead of pure Coulomb friction; the speed reference scales with
  wheel speed so a straight line never engages it and a hairpin fully engages it. Grip sensing uses
  the tyre's peak capacity; in the quasi-static vehicle model an open diff with one wheel spinning
  gives the other no more than the spinning wheel's sliding capacity.
- Auto-shift is a static rule on rpm / throttle only (no speed prediction, no downshift blip, no
  kick-down beyond the part / full threshold at 0.5); one gear per call. The vehicle shifts an
  automatic on the driven-wheel (output-shaft) rpm like a TCU, with hysteresis (no downshift for
  1.5 s after an upshift, 3 s after a wheelspin-induced one; no non-limiter upshift within 0.5 s of a
  downshift) — wheelspin ends a burnout by upshifting.
- Launch clutch and idle governor: below 4 m/s with throttle the engine is held at
  `idle + throttle·(peakTorqueRpm − idle)` and its torque at that rpm passes through the slipping
  clutch; a slipping clutch transmits no engine braking. No torque converter, no clutch pedal.
- Reflected engine inertia (`I_engine·ratio²`) enters the wheelspin integration while the clutch is
  engaged, so a burnout revs up over ~1 s instead of snapping to the limiter.

## Suspension & load transfer
- Massless wheels: no unsprung mass, no wheel hop, no tyre vertical stiffness (only a 12 ms
  enveloping filter on surface roughness). Consequence: high-frequency road input reaches the damper
  directly, so more damping transmits *more* load scatter over 0.5–8 m waves — the "steadier with
  more damping" effect needs unsprung mass, which the model deliberately excludes; damping does
  settle the body faster after a step.
- Struts are vertical (body −z) massless links: no motion ratios, no camber / toe change with travel
  beyond the roll camber, no anti-dive / anti-squat; roll centres enter only as the height at which
  the lateral tyre force acts and as the jacking term of the strut force. Strut compression is
  measured to the local road plane.
- Strut force = preload + spring·Δ + damper·Δ′ + anti-roll bar + bump stop + jacking, clamped ≥ 0;
  the bump stop is 8 × the spring rate beyond 55 % of the travel, full droop at −45 % (the wheel
  hangs, no load). `design/analyze.ts` uses the same stop model for the jump-landing factor and the
  roll angle at the limit.
- Contact forces are assembled in the road plane (normal load along the road normal, longitudinal
  force along the wheel heading projected into the plane, lateral force at roll-centre height); the
  wheel angular-momentum reaction `I·dω/dt` acts on the body.
- Quasi-static wheel torque balance with a regularised slip (1.5 m/s): wheel ω is kinematic in the
  grip regime and integrated only while spinning; ω snaps when a wheel returns to grip. Engine-braking
  overload parks the tyre on the friction-ellipse boundary instead of at full slip (a lift-off
  oversteer cliff otherwise); propulsive torque that opposes a slow creep (hill start, reverse) spins
  the wheel up instead of being treated as engine braking.
- Jump landings from ~3 m produce 20–40× static wheel loads for a few substeps (8 kJ per corner
  cannot be absorbed in 0.14 m of travel at 4× static) — finite and drivable; the tyre and brake
  thermal models are bounded (temperature clamps, saturated heating slip speed) and the analysis
  never sees them.
- Roughness: value noise at 0.5 m with a red spectrum on loose surfaces, low-passed by the tyre
  enveloping filter; it scatters loads by 4–8 % on gravel and does not launch the car by itself.
- Static friction hold below 0.05 m/s (with the brake held or a near-level road, and
  `m·|g_xy| ≤ Σ μN`); below 1.5 m/s the lateral velocity and yaw rate relax to the kinematic
  (parking) values.
- No aero pitch moment (downforce at the axles only), no lift, no yaw aero.

## Aero
- Uses `vx` only (no yaw / sideslip effect, no wind); the ground-effect multiplier applies to all
  downforce (compile sets the sensitivity ≈ 0.1 for wings-only cars); negative lift areas are
  clamped to 0 — lift is not modelled; drag does not change with ride height or downforce level
  (no induced drag — compile folds wing drag into `dragArea`); air density is whatever the track
  says (no altitude / temperature model).

## Track
- `s` is plan (horizontal) arc length; grade tilts the road but does not stretch `s`
  (`dz/ds = grade/100`). Consistent everywhere (compiler, queries, tests).
- Between samples the centreline is a straight chord with lerped heading / curvature / z; the max
  radial error vs the true arc is `κ·step²/8` (≈ 6 mm at R = 20 m, 1 m step). A radius ramp
  interpolates the radius linearly (not a true clothoid).
- The closure blend shifts positions / headings / elevation over the final `closureBlend` metres
  without re-integrating (heading ≠ exact tangent there, bounded by `error·1.5/blendLength`);
  closed tracks quietly use an effective sample step `L/round(L/step)` so the seam interval equals
  every other interval.
- Bank rotates the road about the centreline: the width is not foreshortened in plan and the edge
  elevation is `±(w/2)·tan(bank)`. `curvature × width > 1.6` warns (the inner edge folds). Lane spans
  must lie inside `±width/2`.
- `project` is exact for any `|lateral·curvature| < 1` (Newton on the interpolated pose with a
  bisection fallback); inside a corner's centre of curvature `s` is ambiguous by construction and the
  nearest polyline point is returned. Hairpins down to width/R ≈ 1.6 are usable.
- `sampleAt` has no hint parameter, so it keeps a 128-entry LRU (8 m cell → last `s`) plus the last
  result as a fallback hint: cheap at 120 Hz but not pure (deterministic, sim thread only).
- Grid: rows every `gridSpacing/2` alternating ±width/4 behind the line; stages place non-fitting
  slots single-file *ahead* of the start line (with `startLine 0` the whole field starts ahead of the
  line, rally-style). `bounds` covers centre ± width/2 only (shoulders extend beyond).
- Degenerate specs (no segments / zero length) still compile to a 1-sample track; the issues list
  carries the errors. Warnings cap grade changes at 10 %/10 m and bank at 8°/10 m within a segment
  (plus a ≤ 10-point / 8° boundary step, the only way to author a sharp take-off edge); the six
  built-ins ship with zero warnings and the tabletop / crest recipes in TRACK_FORMAT.md work within
  those limits, so the rule is kept as is.
- No scenery, walls or barriers: leaving the world is handled by the race manager's off-world
  watchdog (40 m beyond the edge for 3 s → reset).

## AI
- The racing line is the minimum-curvature path within the width (not minimum-time); curbs are
  treated as drivable, lanes are ignored; the same line for every car width (margin only).
- The speed profile is quasi-static: steady-state per-axle capacity, no yaw-inertia or roll-transient
  terms — `DYNAMIC_FACTOR = 0.9` is the calibration for that; tyres are assumed at
  `optimalTemp − 15 °C` and unworn, and the driver scales the grip-limited part of the profile with
  the live temperature / wear factor of the colder axle; no brake fade in the plan.
- Crest flight is a point-mass ballistic estimate from the lip tangent; the 45 m flight limit is a
  design choice matching the built-in landing zones; airborne steering is frozen (no mid-air yaw
  control), only the pitch is corrected with brake / throttle.
- The driver is a set of proportional laws with latches (no state estimation, no learning);
  avoidance is geometric (no prediction of the other car's path); reverse manoeuvres are time-boxed.
  Traction control is crude: cut the throttle while any driven wheel is `spinning`, recover slowly;
  the floor is surface-aware (6 % on asphalt, ~36 % on gravel, ~41 % on snow) because a spinning
  tyre keeps most of its grip on loose surfaces and a car must keep crawling up a gravel climb.
- Gear shifting for manual boxes is rpm-threshold only (no engine-braking downshift blip logic);
  automatics are left to the vehicle's TCU.
- Stuck detection uses the throttle the speed controller *asked for* (not the TC-cut value) so a
  car crawling on cold tyres still escalates through hill start → reverse → `stuckFor`; the race
  manager re-poses a driver reporting `stuckFor > 10 s` like a wreck.
- `estimateLapTime` is ∫ds/v along the line plus the shift torque-cut time; the AI itself laps
  5–20 % slower than the estimate (anticipation, throttle caps, cold tyres) — it is a ranking tool.

## Collisions
- Cars are two ground-plane circles (front / rear, radius width/2 + 0.1); no polygon contact, no 3D
  (a jumping car clears another only when its CG is > 1 m higher). Positional correction (60 % of the
  overlap per substep, split by inverse mass) plus a normal impulse with restitution 0.25 and a
  Coulomb tangential impulse (μ 0.3); no damage, no deformation, no FX beyond `lastImpact`.
- Contacts are resolved sequentially (one pass per substep) — stable for ≤ 8 cars at 120 Hz.
- Pitch / roll are ignored by the contact model (planar): a rolled-over car still collides as its
  footprint. Hull-ground contact (rollovers, bottoming) is a penalty spring / damper with regularised
  Coulomb friction; no deformation, no damage.

## Race & timing
- The race clock starts at the green light; the countdown (3 s) holds every car on the brake; a
  rolling start skips the countdown entirely. Stages have no staggered (rally) starts.
- Lap crossings are detected on the lap fraction with 0.25 / 0.75 hysteresis (a car would have to
  jump half a lap in one substep to be missed); reversing over the line undoes the crossing rather
  than penalising the driver; a reset can never gain distance. Grid slots sit behind the line, so the
  first crossing starts lap 1 and counts nothing.
- Sectors are thirds of the arc length, not authored sector lines.
- A finished car's position is frozen; cars still running are ordered by progress, so their gap is a
  distance / speed estimate until they finish (the UI does that estimate).
- Resets (player key, wreck watchdog after 2.5 s, off-world watchdog, stuck AI after 10 s) re-pose
  the car on the centreline at its nearest / last on-track `s`, keep tyre and brake temperatures,
  wear, odometer and time (raised to the pre-heat temperatures when the race is pre-heated), zero the
  input and count in `timing.resets`. A reset never lands on a grade steeper than 5 %: it backs off
  (never forward) up to 100 m to the flattest spot, because a car re-posed at rest on a 16 % gravel
  ramp may not be able to move off and would be reset onto the same ramp forever.

## Analysis (design/analyze.ts, autotune.ts)
- Warm tyres assumed everywhere (`optimalTemp`, no wear, dry asphalt): a cold-tyre or wet analysis
  would multiply the axle grip by the temperature / surface factors — the hooks exist, nothing
  exposes them yet. Consequence: `autoTune('pressures')` picks low pressures for grip without seeing
  the extra heat they generate; on a hot lap the tuned car is within ~2 % of the untuned one.
- No lap-time estimate is computed inside `analyzeBuild` (`lapTimeEstimateS` stays reserved: the
  AI's `estimateLapTime` needs a racing line and ~30 ms per track, well over the 5 ms analysis
  budget — it belongs in a lazily computed garage metric); no wear.
- Quasi-static: dampers only appear as warnings; transient weight transfer, yaw inertia and steering
  geometry are not analysed. The launch model is an ideal driver / traction control
  (`min(demand, capacity)`), one tyre radius for AWD (mean), no differential behaviour, no rev drop on
  shifts beyond the torque cut.
- Braking distance uses a common 150 °C pad temperature; the repeated-stop thermal test starts at
  ambient. Aero balance and rollover use the compiled static ride heights (no aero-induced squat).
- The understeer gradient is a documented blend (slip-angle term at 90 % of the limit plus a
  `20 deg/g × limitBalance` limit term), not a linear-range measurement; the 20 deg/g gain is a
  calibration choice, not physics.
- Rollover threshold = static stability factor × (1 + downforce/weight) × (1 − 0.6 × roll angle at
  the limit), with the roll angle solved against the same bump-stop model as the vehicle (a soft tall
  car sits on its stops at ~6–12°, not at the 30° a linear spring predicts). The simulation lifts the
  inner wheels of such a car within ~10 % of the analysed threshold; whether it tips in a manoeuvre
  also depends on the transient, which the analysis does not model.
- A rear axle that locks first is a `danger` — downgraded to a `warning` on drift-compound rear tyres,
  where it is a slide-initiation tool (the Drift Missile preset is deliberately 0.02 rearward of
  balanced); the summary says so plainly.

## Rendering (src/render3d) — visual only, nothing here changes the physics
- The 3D view draws the sim's own road plane (`z = z_c − lateral·tan(bank)` between 1 m samples, chord
  interpolated) and the terrain 0.35 m below it; surface roughness (`roads.ts`, 6 cm at 0.5 m
  wavelength) is felt through the struts but not displaced in the mesh — it would alias on 1 m samples.
- Cars are procedural boxes sized from the VehicleSpec (length, width, wheelbase, tracks, CG height,
  ride heights, tyre radius/width, wing from rear downforce area). No damage, no deformation; a
  collision only flashes the body (`lastImpact > 500 N·s`).
- Wheel spin is integrated from `omega` at the frame rate for the picture only; the sim keeps its own
  wheel state. Suspension travel shown is `compression` clamped to ±travel.
- Skid marks and dust are drawn from `locked` / `spinning` / `utilisation > 0.98` and the contact
  surface; they never feed back. Both are skipped with more than 8 cars.
- Marker posts and the start gantry are decor: there are **no physical barriers** anywhere (cars only
  collide with each other; leaving the world triggers the off-world reset). A 3D scene makes that
  visible — adding walls means adding a contact term to `vehicle.ts` / `race.ts`, not to the renderer.
- Sky, sun direction and the terrain hills are fixed per environment palette (temperate / snow /
  desert by the default shoulder surface); there is no time of day and no weather (the sim has a
  `wet_asphalt` surface but no rain).
- A software rasterizer (SwiftShader / llvmpipe) gets a low preset (no shadows, no MSAA, half
  resolution); the fixed-step loop still caps `dt` at 66 ms so a slow renderer means slow motion,
  never a physics change.

