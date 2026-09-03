# Notes — tyres + aero (`src/sim/tire.ts`, `src/sim/aero.ts`)

Executable spec: `tests/tire.test.ts` (81), `tests/aero.test.ts` (17), plus the cross-module
`tests/physics_probe.test.ts`. Both modules are pure, deterministic and allocation-free in the hot
path (`tireForcesInto`, `aeroForcesInto`, `updateTireState`), and never return NaN for any finite
or non-finite input.

Verifier's changes to the implementer's version (2026-09-03): stiffness cap + stiffness-independent
post-peak decay (the pure magic formula did not honour `slideMuRatio` for stiff / low-slide specs),
−0 → +0 on the idle axis, per-axis capacities in the result, ±Infinity clamps (0 × ∞ = NaN in the
thermal update), and a thermal retune of `exampleTireSpec` (it never left ambient).

## Tyres

### Grip coefficient
`muPeak = peakMu × loadFactor × tempFactor × wearFactor × surfaceFactor`, floored at 0.
`maxForce = muPeak × load`. Camber is *directional* and does not enter `muPeak` (see below).

- **Load** (`tireLoadFactor`), `r = load / optimalLoad`:
  `r ≥ 1 → 1 − loadSensitivity·(r − 1)` floored at 0.25; `r < 1 → 1 − underloadPenalty·(1 − r)²`.
  Maximum exactly at `optimalLoad`. Consequence of the linear falloff: the *total* force
  `mu·load` still rises with load up to `r* = (1 + s)/(2s)` (≈ 3.8× optimal for `s = 0.15`) and
  falls beyond it; compile should therefore put `optimalLoad` near the static wheel load so the
  game's 1–2.5× transfers stay on the rising side. `optimalLoad ≤ 0` disables the effect.
- **Temperature** (`tireTempFactor`): `floor + (1 − floor)·exp(−ln2·((T − Topt)/window)²)` — 1 at
  `optimalTemp`, `(1 + floor)/2` at `± tempWindow` (0.775 for the 0.55 floor), → `coldGripFloor`
  far away. Symmetric: over-heating costs the same as being cold. `tempWindow ≤ 0` disables.
- **Wear**: `1 − wearGripLoss·clamp01(wear)`.
- **Surface**: `surface.grip × surfaceAffinity[kind]` (default affinity 1).

### Slip curve
Normalised slips `sx = κ / κ_pk`, `sy = tan α / tan α_pk`, where the peaks are the spec's
`peakSlipRatio` / `peakSlipAngle` × `surface.peakSlipScale` (`tirePeakSlip` exposes them — use them
as ABS / traction targets). `σ = hypot(sx, sy)`. Clamps: `|κ| ≤ 1e3`, `|α| ≤ π/2`, `|tan α| ≤ 20`,
peak slip angle ≤ 1.2 rad, peak slips ≥ 1e-3.

Sliding ratio on this surface: `slide = slideMuRatio + (1 − slideMuRatio)·surface.slideRetention`,
kept in `[0.05, 0.995]` (`tireSlideRatio`).

One normalised force shape `f(σ)` per axis (`tireNormalisedForce(σ, k, slide)`):
- **Rise, σ ≤ 1** — Pacejka magic formula `sin(C·atan(Bσ − E(Bσ − atan Bσ)))` with
  `C = 2 − (2/π)·asin(slide)`, `B = k / C` where `k = stiffnessPerLoad × peakSlip / muPeak` is the
  normalised linear slope (`f'(0) = k`; clamped to `[0.3, 500]`), and `E` chosen so `f(1) = 1`,
  `f'(1) = 0`. That is only possible while `atan(B) < tan(π/(2C))`; for `slide < ~0.63` this caps the
  usable stiffness at `k_max = C·tan(tan(π/(2C)))` (≈ 5.6 at slide 0.4, 4.4 at 0.3, 3.2 at 0.05 —
  realistic tyres have `k ≈ 1–3`, so the cap rarely bites; when it does, the linear slope is
  reduced rather than letting the peak drift below σ = 1).
- **Decay, σ > 1** — `slide + (1 − slide)/sqrt(1 + ((σ − 1)/1)²)`. C¹ with the rise (both flat at
  the peak), independent of stiffness. Excess over `slide` is 71 % at σ = 2, 45 % at 3, 24 % at 5,
  13.5 % at a locked wheel (σ ≈ 8), 7 % at 60° of slip angle, ~0 at the `tan` clamp. This replaces the
  pure magic-formula tail, which decays at the same rate for typical specs (slide 0.75, k ≈ 2) but
  hardly decays at all for stiff / low-slide specs (a locked wheel on a `slideMuRatio 0.4` compound
  still gave 0.99 × peak).

Forces: `fx = f_x(σ)·longCap·sx/σ`, `fy = −f_y(σ)·latCap·sy/σ` (friction ellipse: the force vector
follows the normalised slip vector, so longitudinal slip steals lateral force and vice versa).
Signs: `fx` has the sign of `slipRatio`; `fy` the opposite sign of `slipAngle`. The idle axis is
exactly `+0`. Everything is odd and continuous through zero slip; below `σ = 1e-12` the output is
exactly zero.

### Camber
`g(camber) = 1 − ((camber − optimalCamber)/optimalCamber)²` clamped to `[−1, 1]`: 0 at zero camber,
1 at `optimalCamber`, 0 at twice it, −1 far beyond or for the wrong sign. `|optimalCamber| < 1e-6`
disables. Ellipse axes: `latCap = maxForce·(1 + camberGain·g)`, `longCap = maxForce·(1 − camberGain·|g|)`
(both floored at 0). So at optimal camber `|fy|` can reach `maxForce·(1 + camberGain)` and
`utilisation` exceeds 1 there — **use `longCapacity` / `latCapacity` from the result** (added to
`TireForcesResult`; equal to `maxForce` at zero camber) rather than `maxForce` for lockup /
wheelspin decisions. Bound: `|F| ≤ max(latCap, longCap) ≤ maxForce·(1 + camberGain)`.

### Slip power and thermal / wear state
`slipPower = |speed| × (|fx·κ| + |fy·tan α|)` (W). Because `κ` is normalised by the caller's
`max(|vx|, eps)`, pass the **same** `speed = max(|vx|, eps)` you used in the slip-ratio denominator so
a burnout at a standstill still dissipates `fx × |ω r − vx|`; with `speed = 0` slip power is 0.
`|speed|` is capped at 1e4 m/s and `load` at 1e7 N internally.

`updateTireState(spec, state, out, load, speed, ambient, dt)` (explicit Euler, mutates `state`):
```
rollingHeat = load × rollingResistance × |v| × 0.5                         (W, hysteresis)
temp += heatingPerJoule × (slipPower + rollingHeat) × dt
        − min(1, coolingRate × (1 + |v|/20) × dt) × (temp − ambient)
temp ∈ [ambient − 5, 250];  wear += wearPerJoule × slipPower × dt, wear ∈ [0, 1]
```
The cooling fraction is capped at 1 so no dt can overshoot ambient (unconditionally stable).
`dt ≤ 0`/NaN → no-op; non-finite temp → ambient; NaN ambient → 22 °C.

The loop forces → temp → mu → forces is a linear ODE with bounded input: it always converges. The
probe test runs 10 min at constant peak slip (settles within 0.5 °C) and a 15.5 s
corner/brake/straight cycle.

### `exampleTireSpec()` — a performance road tyre
peakMu 1.0 @ 3500 N, loadSensitivity 0.15, underloadPenalty 0.25, peak 7° / 0.12, slide 0.75,
stiffness 16 /rad and 20, optimum 80 ± 35 °C, floor 0.55, **heatingPerJoule 7e-4, coolingRate 0.03**
(retuned: the implementer's 2.5e-5 / 0.02 left the tyre at ambient + 2 °C when driven flat out, so
the temperature window never mattered), wearPerJoule 1e-8, wearGripLoss 0.3, rolling 0.012,
r 0.32 m, 205 wide, optimal camber −2.5°, camberGain 0.08, 18 kg.

Behaviour pinned by tests: hard lap cycle → 55–95 °C (in window); gentle cruise → 35–40 °C (cold,
≈ 0.7 grip: warming up is a thing); a 150 °C tyre loses 90 % of its excess within 60 s at 10 m/s;
rolling alone at 40 m/s warms it ~7 °C; a 10-minute limit stint wears ~0.04.

### Assumptions / simplifications (for docs/ASSUMPTIONS.md → Tyres)
- Single contact-patch model, no relaxation length, no transient slip: forces respond instantly to
  slip. The vehicle model owns any low-speed slip regularisation.
- One temperature per tyre (no surface/core/carcass split, no across-tread gradient); cooling is
  linear in `(T − ambient)` with a `(1 + v/20)` speed term; rolling hysteresis heat is half the
  rolling-resistance power.
- Grip window is a symmetric Gaussian on a floor — no graining/blistering hysteresis.
- Load sensitivity linear in load ratio above optimum (floor 0.25), quadratic penalty below.
- Camber is a static ellipse scaling — no camber thrust at zero slip, no camber change with roll
  unless the vehicle model passes an effective camber.
- Sliding friction is speed-independent (`slideMuRatio` is a constant), the post-peak decay is a
  fixed shape in normalised slip.
- The magic-formula rise cannot carry `k > k_max(slide)` for sliding ratios below ~0.63 — stiffness
  is silently capped there.
- Wear only from slip energy (no thermal wear, no flat-spotting); it reduces grip linearly.
- Surfaces scale grip, peak slip and slide retention; no wet/dry transition, no rubbering-in.

### For the vehicle-model author
- Reuse one `createTireOutput()` per wheel and call `tireForcesInto`; then `updateTireState` with
  the same load / speed once per step.
- Compare drive/brake force demand against `out.longCapacity × radius` (Nm) — that is also the
  capacity to feed `splitAxleTorque`.
- A wheel you decide is locked or spinning should be evaluated at the sliding slip
  (`slipRatio = ∓1` or a large value) — the curve already returns `≈ slide × capacity` there and the
  lateral authority drops accordingly through the ellipse.
- `tirePeakSlip(spec, surface)` gives ABS / TC targets per surface.

## Aero (`aero.ts`)
```
q         = 0.5 · airDensity · vx²
drag      = q · dragArea                                 (magnitude, ≥ 0; apply against sign(vx))
ground    = clamp(1 + rideHeightSensitivity · (ref − (hF + hR)/2)/ref, 0.2, 2.5)
downFront = max(0, q · liftAreaFront · ground),  downRear = max(0, q · liftAreaRear · ground)
```
`totalDownforce(spec, v, ρ)` = front + rear at the reference ride height (for analyze).
Guards: NaN speed / non-positive density → q = 0; non-finite ride heights, `refRideHeight ≤ 0` or NaN
sensitivity → ground = 1; NaN areas → 0.

Assumptions (for docs/ASSUMPTIONS.md → Aero): uses `vx` only (no yaw/sideslip effect, no wind);
the ground-effect multiplier applies to **all** downforce (compile sets sensitivity ≈ 0 for
wings-only cars); negative lift areas are clamped to 0 — **lift is not modelled**; drag does not
change with ride height or downforce level (no induced drag — the compile step should fold wing
drag into `dragArea`); air density is whatever `RoadQuery.airDensity` says (no altitude/temperature
model).
