# Notes — design layer (`src/design/parts.ts`, `src/design/compile.ts`, `src/sim/engine.ts`)

Executable spec: `tests/parts.test.ts` (19), `tests/engine.test.ts` (20), `tests/compile.test.ts`
(41). All formulas are tabulated player-facing in `docs/DESIGN_MODEL.md`. `compileBuild` is
deterministic, allocation-per-call only, never NaN (tests walk the whole spec recursively for the
default build and all seven presets, and for a build seeded with NaN/Infinity).

## What is implemented

- **`sim/engine.ts`** — `buildEngineSpec` synthesises a full-throttle torque curve from BMEP
  (torque = BMEP·disp/4π; NA BMEP = 1000 + 400·peakiness kPa, ×(1 + 0.01·(cyl − 4))) with an
  rpm envelope (lowEnd = 0.75 − 0.4·peakiness below the peak with a ^1.6 rise, quadratic fall to
  topEnd = 0.55 + 0.35·peakiness at the redline). Turbo multiplies BMEP by
  (1 + 0.85·boost·smoothstep(0.2·redline, 0.45·redline, rpm)); supercharger by (1 + 0.8·boost)
  from idle with a ×(1 − 0.06·boost) parasitic factor on torque. Curve tabulated every 250 rpm
  from idle (700 + 60·(8 − cyl), clamp 600..1100) to limiter (redline + 250); peaks scanned from
  the table. engineBraking = 0.10·peakTorque + 8·disp. `engineTorque` = throttle·curve −
  (1 − throttle)·braking·clamp(rpm/redline, 0, 1.5); fuel cut (positive part 0) above the
  limiter; positive part held at the idle value below idle; NaN-proof.
- **`design/parts.ts`** — all ten tyre compounds, five chassis sizes, three materials, four pad
  compounds, `FIELD_RANGES` for all 35 continuous paths (novice-readable hints), `defaultBuild()`
  (front-mid 2.5 L NA sport RWD mid-size, ~1397 kg, 54.1% front), `presetBuilds()` — Club Hatch,
  Track Weapon, Gravel Rally, Drift Missile, Muscle, Kei Racer, Ice Runner. Default and every
  preset are fixpoints of `normalizeBuild` (pinned by tests).
- **`design/compile.ts`** — `compileBuild` (masses/CG/inertia, per-axle tyre & brake specs,
  suspension, steering, aero, drivetrain, engine params from tune) and `normalizeBuild`.
  Exported extras: `DRIVER_MASS`, `TIRE_HEATING_BASE`; `parts.ts` exports `INTEGER_FIELDS`.

## Calibration landed (compiled, incl. 80 kg driver + fuel)

- Default 2.5 L sport RWD: 1397 kg, 54.1% front, 204 Nm, ~123 kW @ 6700.
- Club Hatch 1.6 FWD: ~1148 kg, ~57% front. Muscle 6.2 V8: ~1740 kg, 616 Nm, ~311 kW.
- Track Weapon (mid carbon, slicks): ~1099 kg, 42.0% front, liftAreaRear ≈ 2.5 m².
- `CHASSIS_SIZES.baseMass` was scaled by ~0.8 on 2026-09-03 (kei 620 → 500, compact 900 → 710,
  mid 1080 → 880, large 1300 → 1050, truck 1800 → 1450) because the first calibration compiled
  10–20 % over the design targets (hatch ~1335 kg vs ~1100 intended, default ~1597 vs ~1400). Nothing
  else in compile changed. Side effect: with less chassis mass at 0.5 wb the engine lump weighs more
  in the balance, so front-engine cars are ~1–1.5 points more nose-heavy and every balanced brake bias
  moved 0.015–0.03 forward (presets re-tuned, see `docs/notes/analyze_autotune.md`).
- Engine sanity pinned: 2.0 NA sport 190–230 Nm / 120–160 kW @ 6000–7000; 6.2 V8 street
  550–650 Nm / 300–360 kW.

## Deviations from the written brief (deliberate, small)

1. **Drag vs ride height sign.** The brief's literal `dragArea = CdA × (1 − 0.1·(avg−0.12)/0.12)`
   makes a *raised* car slipperier. Implemented as `× (1 + clamp(0.1·(avg−0.12)/0.12, ±0.05))`
   so lowering the car reduces drag (physical, and the monotonic test pins it).
2. **Default engine position is `front-mid`**, not `front`. With the prescribed part positions a
   pure-front engine (block CG 12% of wb *ahead* of the front axle) lands ~57% front — outside
   the required 52–56% band for a front-engine RWD. Front-mid (S2000-style, still a front
   engine) lands 53.6%. Tests additionally pin the ordering front > front-mid > mid > rear.
3. **Supercharger parasitic loss** is multiplicative: torque × (1 − 0.06 × boost), everywhere.
4. `peakRpm` is clamped to [idle + 250, redline − 250] and the shape floored at 0.05 so hostile
   params can't divide by zero or go negative; `buildEngineSpec` defensively clamps all inputs.

## Assumptions / simplifications (for docs/ASSUMPTIONS.md)

### Engine & drivetrain (append)
- Torque curve is a static BMEP × envelope synthesis: no VE map, no intake/exhaust modelling;
  cylinder count is a 1%-per-cylinder BMEP nudge + idle rpm. Boost is a BMEP multiplier with a
  fixed smoothstep spool band (0.2–0.45 × redline) — no boost dynamics beyond the first-order
  `throttleResponse` lag (0.05 + 0.25 × boost for turbo).
- Fuel cut above limiter is a hard zero on the positive part (no soft limiter bounce); engine
  braking scales linearly with rpm, capped at 1.5 × redline, and never depends on gear.
- Below idle the curve holds the idle torque — the vehicle model owns the idle governor/clutch.
- Gearbox mass/inertia are affine in gear count; geometric ratio spread when no explicit ratios.

### Design layer (new section or Global)
- All part masses are point masses on the wheelbase line: CG is 1-D longitudinal + a scalar
  height; no lateral asymmetry (driver sits on the centreline).
- Part positions are fixed fractions of the wheelbase (engine −0.12/0.18/0.72/1.08, gearbox
  0.35/0.92, chassis 0.5, driver 0.45, fuel 0.85, wheels at the axles); no packaging conflicts.
- Tyre scaling laws are power-law heuristics around the 205/220/17 reference (documented in
  DESIGN_MODEL.md), not measured carcass data; overall wheel diameter is held ≈ 0.67 m so
  gearing is rim-independent.
- Brake torque = fixed 25 kN clamp × pad mu × 40% of disc diameter — pedal/master-cylinder
  hydraulics are not modelled; ducts only raise the convective coefficient.
- Roll stiffness = 0.5 × spring rate × track² + slider × 50 kNm/rad; no motion ratios, no
  geometry change with ride height beyond rollCentre = 0.3 × ride.
- Aero coefficients are additive in splitter/wing/underbody; wing/splitter drag is folded into
  `dragArea` (the aero module models no induced drag); base body has slight lift (−0.05/−0.04
  lift-area factors).
- `compileBuild` normalises first: an out-of-range build silently compiles to its clamped self.

## For other module authors

- `TIRE_HEATING_BASE = 7e-4` °C/J matches the retuned `exampleTireSpec` calibration in
  `docs/notes/tire.md`; compound `heatingScale` spans 0.5 (drift) … 1.45 (slick_soft).
- `optimalLoad` lands near the static corner load for road cars (default: 3512 N optimal vs
  ~3705 N static front) — on the rising side of total force, per the tyre module's guidance.
- analyze/autotune: `FIELD_RANGES` is the search space (dotted paths into CarBuild;
  `INTEGER_FIELDS` lists the integer ones); `normalizeBuild` is idempotent and safe to call on
  anything; `compileBuild(build)` already includes it.
- The compiled `drivetrain.mass` is the gearbox lump only (engine mass lives in `engine.mass`);
  both are already inside `VehicleSpec.mass` — don't add them again.
- Diff choice mapping: lsd_1way {0.5, 0}, lsd_1_5way {0.5, 0.25}, lsd_2way {0.6, 0.6},
  locked {1, 1} (powerLock/coastLock are ignored by the sim for locked diffs).
