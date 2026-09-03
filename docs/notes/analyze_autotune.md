# Notes — build analysis + auto-tune (`src/design/analyze.ts`, `src/design/autotune.ts`)

Executable spec: `tests/analyze.test.ts` (31), `tests/autotune.test.ts` (18). Both modules are pure,
deterministic (no RNG anywhere), allocation-light and never return NaN for the default build, the
seven presets or 20 seeds of fully randomised continuous fields. `analyzeBuild` runs in 0.8–3.1 ms
per call (test budget 5 ms, averaged over 20 calls); `autoTune('all')` takes 5–15 ms.

Nothing here imports `sim/vehicle.ts` or `sim/ai.ts`. Every figure is the quasi-static /
steady-state equivalent of what the 6-DOF strut model does dynamically, computed from the same
tyre / brake / engine / drivetrain / aero modules the simulation uses.

## Reference conditions (`ANALYSIS` constants)

Dry asphalt, tyres at their `optimalTemp`, no wear, sea-level air, 22 °C ambient. Skidpad aero
at 25 m/s; braking tests from 100 km/h with pads at 150 °C (warm street pads, still-cold race
pads); aero balance and downforce at 200 km/h; repeated-stop test: 10 stops from 150 km/h with
20 s of 40 m/s cooling between them; ABS holds 0.95 × capacity; launch clutch holds
`idle + 0.5 (peakTorqueRpm − idle)` until 4 m/s; manual gearbox shifts at 0.97 × limiter.

## Semantics assumed (must match `vehicle.ts`)

- **Brake bias is a bias bar**: `spec.brakes.bias` is the front share of the *total* brake torque.
  With `mF`/`mR` the axles' `maxTorque` and `neutral = mF/(mF + mR)`: `bias ≥ neutral` → front line
  pressure 1, rear `((1 − bias)/bias)·mF/mR`; else rear 1, front `(bias/(1 − bias))·mR/mF`. Per-wheel
  torque = `maxTorque × pedal × pressure × effectiveness(temp)`; axle force demand = `2 × torque /
  radius`. So the front share equals `bias` exactly (at equal pad temperatures), the stronger side always
  sees the full pedal, and the balanced bias is simply the front axle's share of the tyre capacity at the
  braking limit — the disc sizes drop out of the balance and only set how hard the car can stop.
  `brakeLinePressures(bias, mF, mR)` is exported; `sim/vehicle.ts` carries an identical copy.
- **Longitudinal transfer** `dF = Fx_total × cgHeight / wheelbase` where `Fx_total` is the sum of the
  tyre forces (drag does not enter the transfer).
- **Lateral transfer per axle**
  `dF_axle = [Fy (h − hRoll) K_axle/(Kf + Kr) + Fy_axle × rollCentre_axle] / track_axle`, with
  `hRoll = lerp(rollCentreFront, rollCentreRear, cgToFront/wheelbase)` and `Fy_axle` split by the
  static axle weights. The inner wheel is floored at 0 (it lifts); the outer takes the rest.
- **Tyre capacity** `tirePeakMu(spec, load, optimalTemp, 0, camber, asphalt) × load`, lateral
  × `(1 + camberGain·g)`, longitudinal × `(1 − camberGain·|g|)` using the tyre module's exported
  `tireCamberFactors` / `tireCamberShape` (no formula duplicated). Internally the constant factors
  (temperature at optimum, wear 0, surface 1) are folded into `muBase` once per axle so a wheel
  capacity is `muBase × tireLoadFactor(load) × load × camberFactor`.
- Camber is the static camber; the analysis does not add roll-induced camber change.

## Metrics

| Metric | How |
| --- | --- |
| `massKg`, `frontWeightFraction`, `peakPowerKw`, `peakTorqueNm`, `powerToWeightWkg` | straight from the spec; front fraction `(wb − cgToFront)/wb`. |
| `accel0to100s` | Point-mass launch integration: 1 kHz for the first 5 s (clutch, traction limit, first shifts), 250 Hz after, cap 60 s. Per step: rpm from wheel speed (clutch rule below 4 m/s), auto-shift rule (`autoShiftGear`, evaluated every 5 ms) or 0.97 × limiter for manual boxes, `shiftTime` torque cut, full-throttle torque from a 20-rpm dense table of `engineTorque`, wheel force = T × ratio × efficiency / r, **driven-axle traction limit** per axle (`min(demand, capacity)` with the fixed AWD split) using longitudinal transfer warm-started from the previous step's force (a 1 kHz warm start *is* the converged "iterate once"), drag + rolling resistance from `aeroForcesInto` calibrated at one speed (everything in aero.ts scales with v²), effective mass = m + wheel & driveline inertia / r² + engine inertia × ratio² / r² while the clutch is locked. |
| `topSpeedKmh` | Best over gears of the highest speed where full-throttle wheel force still meets drag + rolling resistance (scan + bisection per gear). `topSpeedGearingLimited` when that gear is on the limiter with force to spare. `topSpeedDragLimitedKmh` is the ideal-CVT limit: `peakPower × efficiency / v = drag(v) + rr(v)`. |
| `skidpadG` | Damped fixed-point iteration (10 steps) on `ay = min(ayF, ayR)`; per axle `ay_axle = (cap_outer + cap_inner) / m_axle` with the loads at that `ay` (load sensitivity makes the outer wheel worth less — this is the mechanism). Also `skidpadFrontG/RearG`, `limitAxle`, `limitBalance = (ayR − ayF)/max(ayF, ayR)` (> 0 → front gives up first). |
| `understeerGradientDegPerG` | **Blend, positive = understeer**: `K = K_slip + K_limit`. `K_slip = (αF − αR) / (ay/g)` where each axle's slip angle is found by inverting the real tyre curves (`tireForcesInto`, bisection up to the peak slip angle) for the force it must produce at `ay = 0.9 × skidpad` with the loads at that `ay` — this contains the linear term (`Wf/Cf − Wr/Cr` with `C = corneringStiffnessPerLoad × W`, which reduces to `rad2deg(1/csF − 1/csR)` and is reported separately as `understeerLinearDegPerG`) plus the nonlinear load-transfer effect. `K_limit = 20 deg/g × limitBalance`: a front axle that saturates 5 % earlier reads as +1 deg/g. Why the limit term: with this tyre model the cornering stiffness is exactly proportional to load, so the classic weight-distribution understeer vanishes in the linear range and the whole character of a car lives in *which end lets go first*; the gain maps that onto the deg/g scale the warnings and intents use (default car ≈ +1.2 deg/g, ARB split alone spans roughly −1 … +2.5). Both parts are exported (`understeerSlipDegPerG`, `understeerLimitDegPerG`). |
| `lockupG`, `lockupAxle` | Pedal sweep by bisection: at each pedal the axle demands rise linearly, the loads (transfer at the resulting deceleration, aero at 27.8 m/s) are solved in 4 fixed-point passes, utilisation = demand / capacity. `lockupG` = deceleration (tyre forces / m g) at which the first axle reaches capacity; `balanced` when the two utilisations are within 4 %. `canLock = false` when full pedal cannot reach the tyres' limit (an info warning). `idealG` = both axles exactly at capacity. |
| `brakingDistance100m` | Full-pedal quasi-static stop from 27.8 m/s, 10 ms steps: an axle over capacity runs at 0.95 × capacity with ABS, or **locks** without: force = `tireSlideRatio × capacity`, nothing absorbed by the disc. With ABS and strong brakes the distance is bias-independent (both axles saturate) — physical. |
| `brakeTempAfterStopsC`, `brakeHotAxle` | 10 stops from 41.7 m/s using the same stop model in **threshold mode** (an ideal driver eases the pedal so the first axle sits at its limit — otherwise a non-ABS car locks both axles and the energy never reaches the discs); per step each disc absorbs `F_axle_reacted × v_mid / 2` W through `updateBrakeState` (pad effectiveness follows the disc temperature, so fading brakes stop slower and heat less — a real feedback), then 20 s of 40 m/s cooling in 1 s implicit steps. Reported: the hotter axle after the 10th stop. |
| `tractionUse1stGear` | `(peakTorque × overallRatio(1) × efficiency / r) / drivenTractionCapacity(0.5 g)`; AWD capacity = `min(capF/split, capR/(1 − split))`, the total force at which the first axle spins. |
| `aeroBalanceFront`, `downforce200N` | `aeroForcesInto` at 55.6 m/s and static ride heights (ground effect included). Zero downforce → balance reported as 0.5. |
| `rolloverG` | `(min(trackF, trackR)/2 / cgHeight) × (1 + downforce_25m/s / W) × (1 − 0.6 × rollAngle)` with `rollAngle = m × ay × (h − hRoll)/(Kf + Kr)` at the skidpad limit. The downforce factor is an addition to the brief's formula: the aero that produces a 1.5 g skidpad also presses the car down, and without it every real downforce car flags as a roller. |
| `jumpLandingG` | Worst axle of `(F0 + k × 0.55 × travel + bumpStop) / F0` with `F0` the static corner load and `bumpStop = 3k × 0.1 × travel` (a stop three times the spring rate over the last 10 % of travel — vehicle.ts had no bump-stop model to copy when this was written; align the constant later). Mentioned in the summary only when rally/snow tyres are fitted. |
| `lapTimeEstimateS` | Reserved optional hook, not computed. |

## Warnings (severity / area / fix)

Every message names the physical cause and the knobs. Rear locks first → **danger** brakes `brakeBias`
(downgraded to warning on drift-compound rear tyres, where a rear that locks first is a slide-initiation
tool — the Drift Missile preset is deliberately 0.02 rearward of balanced).
Front locks with the rear below 85 % utilisation → warning `brakeBias`. Brakes too weak to lock →
info. Disc hotter than `fadeStartTemp` after ten stops → warning, **danger** below 75 % effectiveness
(no solver: ducts / discs / pads named). `coldFactor < 0.8` → info. `tractionUse1stGear > 1.6` →
warning `gears` (LSD / AWD / tyres named). Top gear on the limiter → warning `gears`; top gear the
engine cannot pull (a lower gear is faster) → warning `gears`; 1st gear taller than 65 km/h using
< 75 % of the grip → warning `gears`. `throttleResponse > 0.3` → turbo-lag info. Understeer > 4 →
info `balance`; oversteer < −1 → warning `balance`. `skidpadG > 0.9 × rolloverG` → **danger**
chassis, no fix (ride height / track / springs & bars named). Damping < 0.4 or > 1.0 → info
`dampers`. Static wheel load < 0.55 or > 1.8 × `optimalLoad` → warning `pressures`. Camber beyond
1.6 × optimal, or positive → info `camber`. Aero balance > 12 points from the weight distribution
*and* shifting the 200 km/h load balance by > 2 points → info, > 4 points → warning `aero`. Wing
> 0.5 on rally/snow tyres → info. Summary: two sentences from weight bias, limit balance, brakes
(lockup / fade), traction, 0–100 and top speed (+ jump landing on rally tyres).

## Auto-tune solvers (`autoTune(build, target, intent)`)

Works on a `normalizeBuild` copy; every change records `field`, `from`, `to`, one-line `why`;
repeated changes to a field are merged (first `from`, last `to`). All solvers read compiled
quantities and search numerically against `compileBuild` — none re-derives a compile formula.

- **brakeBias** — bisection over the bias range (0.5–0.9, step 0.005) on `analyzeLockup` for
  rear/front utilisation = 0.98 (2 % toward the front for safety; 1.0 for `drift`). One grid step is
  ~2 % of the rear torque near 0.75, so both grid neighbours of the root are evaluated and a *balanced*
  one is kept (front-first preferred). Under the bias-bar semantics the result is the dynamic front
  capacity share at the limit: 0.72–0.78 for the road-car presets, 0.63 for the low, rear-heavy Track
  Weapon; it does not depend on disc sizes (tested).
- **gears** — `overallTop = limiter × r / (1.04 × v_drag)`, `overallFirst = 1.25 × cap_0.5g × r /
  (peakTorque × eff)` (at least 1.8 × overallTop); the final drive is moved only when needed to put
  both ratios inside their ranges (top speed wins if both cannot fit); explicit geometric
  `gearRatios` written, gear count kept, `firstGear`/`topGear` sliders kept consistent with them.
- **balance** — target `{stable +2.5, neutral +1.0, lively +0.2, drift −1.0}` deg/g; golden-section
  on the front share of the (constant) total ARB, then on the spring split (constant sum, each spring
  moved at most ±40 %) only if the bars hit their range and the miss exceeds 0.15 deg/g. A total ARB
  below 0.2 is given 0.4 to search with.
- **pressures** — per axle, bisection on the compiled `optimalLoad(pressure)` for
  `1.25 × static wheel load`, first inside the penalty-free 150–260 kPa band, widening to the full
  range only if the static/optimal ratio would leave 0.6–1.7.
- **aero** — target `frontWeightFraction − 0.02`; splitter solved for `target × total`, then the wing
  for the rear that balances the front *actually achieved* (identical to keeping the total when the
  splitter can reach its target; the balance fixed point when it saturates at 1). Splitter-only cars
  match the front to the fixed underbody rear. No wing and no splitter → untouched.
- **camber** — 0.9 × the compound's `optimalCamberDeg`. **dampers** — 0.70 / 0.65.
- **all** — pressures, camber, aero, gears, balance, brakeBias, dampers, brakeBias. Idempotent on the
  default and all presets but the Drift Missile (second run: 0 changes; the Drift Missile re-snaps
  splitter, final drive and both bars by one slider step each — the aero total feeds the gears' drag
  limit which feeds the balance); on random builds a second run changes ≤ 4 fields (grid snapping).
  Novice test: 20 seeds × every continuous field uniform in `FIELD_RANGES` → 20/20 without a danger
  warning.

## Limitations / assumptions (for docs/ASSUMPTIONS.md)

- Warm tyres assumed everywhere: a cold-tyre or wet analysis would multiply `muBase` by the
  temperature / surface factors — the hooks exist (`axleTyre`), nothing exposes them yet.
- No lap-time estimate (`lapTimeEstimateS` reserved); no wear.
- Quasi-static: dampers only appear as warnings, transient weight transfer, yaw inertia and
  steering geometry are not analysed.
- The launch model is an ideal driver / traction control (`min(demand, capacity)`), one tyre radius
  for AWD (mean), no differential behaviour, no rev-drop on shifts beyond the torque cut.
- Braking-distance uses a common 150 °C pad temperature; the thermal test starts at ambient.
- Aero balance target and rollover use the compiled static ride heights (no aero-induced squat).
- The understeer gradient is a documented blend (above), not a linear-range measurement; its
  20 deg/g limit gain is a calibration choice, not physics.

## Brake bias semantics change (2026-09-03) and preset re-balance

The proportioning-valve semantics of the first version were replaced by the bias bar above (decision
by the coordinator; the vehicle model implements the same rule). `FIELD_RANGES['brakes.bias']` is now
0.5–0.9 in 0.005 steps and every curated build carries the value `autoTune(build, 'brakeBias')`
produces, so the presets are balanced out of the box:

| Build | old bias (prop. valve) | bias bar, first calibration | bias bar, current | note |
| --- | --- | --- | --- | --- |
| Roadster S (default) | 0.64 | 0.705 | 0.72 | balanced, front first by 2 % |
| Club Hatch | 0.68 | 0.745 | 0.765 | |
| Track Weapon | 0.60 | 0.635 | 0.63 | balanced (low CG, 42 % front: little transfer) |
| Gravel Rally | 0.60 | 0.74 | 0.755 | |
| Drift Missile | 0.70 | 0.72 | 0.735 | balanced would be 0.755; 0.02 rearward on purpose (rear locks first → warning, not danger) |
| Muscle | 0.66 | 0.745 | 0.775 | |
| Kei Racer | 0.66 | 0.745 | 0.765 | |
| Ice Runner | 0.60 | 0.725 | 0.745 | |

### Chassis re-mass (2026-09-03)

`CHASSIS_SIZES.baseMass` was scaled by ~0.8 (kei 620 → 500, compact 900 → 710, mid 1080 → 880,
large 1300 → 1050, truck 1800 → 1450) so the compiled cars land on their design targets. With less
chassis mass sitting at mid-wheelbase, the engine lump counts for more in the balance: front-engine
cars are ~1–1.5 points more nose-heavy, so every balanced bias moved 0.015–0.03 forward. The
"current" column above is `autoTune(build, 'brakeBias')` re-run on the lighter cars (rounded to the
0.005 slider step); the Drift Missile stays 0.02 rearward of its balanced 0.755.

| Build | mass before | mass after | front % before → after |
| --- | --- | --- | --- |
| Roadster S (default) | 1597 kg | 1397 kg | 53.6 → 54.1 |
| Club Hatch | 1335 kg | 1148 kg | 56.3 → 57.4 |
| Track Weapon | 1219 kg | 1099 kg | 42.8 → 42.0 |
| Gravel Rally | 1438 kg | 1252 kg | 57.6 → 58.7 |
| Drift Missile | 1624 kg | 1427 kg | 58.3 → 59.5 |
| Muscle | 1990 kg | 1740 kg | 60.4 → 61.9 |
| Kei Racer | 982 kg | 865 kg | 57.6 → 58.6 |
| Ice Runner | 1403 kg | 1213 kg | 57.1 → 58.2 |

## Open issues for the integrator

1. The bump-stop constant in `jumpLandingG` should be aligned with vehicle.ts once its strut model
   is final.
2. `BuildAnalysis.metrics` gained optional fields (`rolloverG`, `jumpLandingG`, `limitBalance`,
   `limitAxle`, `skidpadFrontG/RearG`, `understeerLinear/Slip/LimitDegPerG`,
   `topSpeedDragLimitedKmh`, `topSpeedGearingLimited`, `firstGearLimiterKmh`, `brakeHotAxle`,
   `lockupFront/RearUtilisation`, `lapTimeEstimateS`) — the UI must treat them as optional.
3. `brakeLinePressures` exists twice by design (design/analyze.ts and sim/vehicle.ts); a shared
   sim-side helper the designer may import would remove the duplication if the layering rule is relaxed.
