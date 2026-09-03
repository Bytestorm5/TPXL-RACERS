# Notes — brakes + drivetrain (`src/sim/brakes.ts`, `src/sim/drivetrain.ts`)

Executable spec: `tests/brakes.test.ts` (25), `tests/drivetrain.test.ts` (54), plus the cross-module
`tests/physics_probe.test.ts`. Both modules are pure, deterministic, allocation-free in the hot path
(except the one result object the frozen `splitAxleTorque` signature requires) and never return
NaN/Infinity for any finite or non-finite input.

Verifier's change to the implementer's version (2026-09-03): the auto-shift downshift rule gained a
10 % hysteresis margin (`DOWNSHIFT_UPSHIFT_MARGIN`) — without it part-throttle driving hunted
between gears under ±3 % rpm noise on any gearbox with a ratio step above ~1.6 (43–79 wrong-way
shifts per sweep on a 4.2/2.2/1.4/1.0/0.8 box). Brakes were verified unchanged.

## Brakes

### What is implemented
- `brakeEffectiveness(spec, temp)` — 0..1 multiplier:
  `T <= 20 °C → coldFactor`; `20..coldBiteTemp → smoothstep up to 1`; `coldBiteTemp..fadeStartTemp → 1`;
  `fadeStartTemp..fadeEndTemp → smoothstep down to fadeMinFactor`; above → `fadeMinFactor`.
  Cold ramp and fade are **multiplied** (so overlapping bands stay continuous). `coldBiteTemp <= 20`
  ⇒ no cold penalty (street pads). `fadeEndTemp <= fadeStartTemp` ⇒ fade is a step at `fadeStartTemp`.
  `coldFactor`/`fadeMinFactor` are clamped to [0,1]; NaN temp is treated as 20 °C.
- `brakeTorque(spec, state, pedal) = maxTorque × clamp01(pedal) × effectiveness(temp)`, always ≥ 0
  (NaN pedal → 0, negative maxTorque → 0). It is a **magnitude**; the vehicle model applies it against
  the wheel's rotation.
- `updateBrakeState(spec, state, absorbedPower, speed, ambient, dt)` — lumped single-node disc+pad:

  `C·dT/dt = P·heatAbsorption − coolingCoeff·(1 + |v|/15)·(T − Tamb) − 1e-3·coolingCoeff·((T/100)^4 − (Tamb/100)^4)`

  Integrated with **implicit Euler on the linear convective term** (explicit source/radiative terms):
  `T' = (T + dt·(heating − radiative + k·Tamb)) / (1 + k·dt)`, `k = coolingCoeff(1+|v|/15)/C`.
  Unconditionally stable for any dt / heat capacity / cooling coefficient (explicit Euler would
  oscillate for C≈1, coolingCoeff 80, 70 m/s at 120 Hz). For realistic parameters (k·dt ≈ 1e-4) it is
  numerically identical to the spec's explicit form. Result clamped to `[Tamb − 1, 1200]`.
  Guards: dt ≤ 0/NaN → no-op; heatCapacity < 1 → 1; negative/NaN power → 0; |speed| capped at
  1000 m/s; NaN state temp → ambient; NaN ambient → `DEFAULT_AMBIENT_TEMP`.
- `exampleBrakeSpec(overrides?)` — 330 mm sport disc: 2800 Nm, 5000 J/°C, 25 W/°C, absorption 0.9,
  fade 450→700 °C to 0.35, cold 0.9 until 60 °C, 9 kg.
- Exported constants: `BRAKE_COLD_REFERENCE_TEMP`, `BRAKE_MAX_TEMP`, `BRAKE_MIN_BELOW_AMBIENT`,
  `BRAKE_COOLING_SPEED_SCALE`, `BRAKE_RADIATIVE_FACTOR`, `BRAKE_MIN_HEAT_CAPACITY`.

### Behaviour pinned by tests (numbers from the example spec)
- One 150 km/h → 0 stop (1400 kg, this disc absorbing 60 % of the car's KE over 4 s) raises the disc
  by ~128 °C.
- Ten such stops at a 14 s cadence (4 s braking + 10 s back up to speed): coolingCoeff 25 → peak
  697 °C, effectiveness 0.35 (fully faded). coolingCoeff 80 (ducts) → peak 313 °C, effectiveness 1.
  At a 24 s cadence the stock disc peaks at 506 °C (effectiveness 0.92) — fade onset is gradual.
- Cooling is monotonic toward ambient, never below ambient − 1; 60 m/s cools ~5× faster than standing still.

### Assumptions / simplifications (for docs/ASSUMPTIONS.md → Brakes)
- Single thermal node per wheel (disc + pad share one temperature); no pad/disc gradient, no caliper
  or fluid temperature, so no "boiled fluid" long pedal — only pad fade.
- Convective cooling linear in (T − Tamb), multiplied by (1 + |v|/15); the radiative term uses the
  spec's game formula `1e-3·coolingCoeff·((T/100)^4 − (Tamb/100)^4)` in °C (not Kelvin) and is small
  (≈0.75 % of convection at 900 °C). Real radiation would be much larger; convection was tuned to
  carry the load instead.
- Cold bite: a fixed 20 °C reference regardless of ambient; below 20 °C the pad sits at `coldFactor`.
- Effectiveness has no hysteresis (glazing, bedding-in and pad wear are not modelled).
- Temperature ceiling 1200 °C, floor ambient − 1 °C (hard clamps, not physics).

### For the vehicle-model author
- `absorbedPower` = `brakeTorque × |wheelOmega|` (W) of the torque **actually reacted by the disc**.
  For a locked wheel (omega ≈ 0) pass 0 — that energy goes into the tyre.
- Call `updateBrakeState` once per wheel per step with the car's ground speed (m/s, sign ignored).
- `brakeTorque` uses `state.temp` of the same wheel; bias is applied by the caller
  (`pedal_front = pedal × bias`, `pedal_rear = pedal × (1 − bias)` per `VehicleSpec.brakes.bias`).

## Drivetrain

### What is implemented
- `overallRatio(spec, gear)`: gears 1..n → `gearRatios[g−1] × finalDrive`; 0 → 0;
  −1 → `−(gearRatios[0] × 1.1) × finalDrive` (negative). Out-of-range → clamped to nearest valid gear;
  non-integer → rounded; NaN → 0 (neutral). Helper `clampGear` exported.
- `rpmFromWheelSpeed(spec, gear, wheelOmega) = wheelOmega × ratio × 60/(2π)`; neutral → 0 (caller
  substitutes idle). Inverse `wheelOmegaFromRpm` exported.
- `driveTorqueAtWheels(spec, engineTorque, gear) = engineTorque × ratio × efficiency` (signed),
  `splitFrontRear(spec, total)` — fixed `frontTorqueSplit`, no centre diff.
- `splitAxleTorque(diff, T, capL, capR, ωL, ωR)` — see below.
- `autoShiftGear(drivetrain, engine, gear, rpm, throttle)` — see below.
- `wheelTorqueCurve(drivetrain, engine, gear, wheelRadius, samples = 64)` → `[speed m/s, wheel Nm]`
  from idle to limiter on a uniform grid **plus the torque-curve knots** (peak exact), efficiency included.
  Neutral → `[]`; reverse → negative speeds/torques.
- `exampleDrivetrainSpec(overrides?)`: RWD, [3.6, 2.2, 1.5, 1.15, 0.95, 0.8], final 3.9, shift 0.15 s,
  efficiency 0.9, rear LSD 0.5/0.3, front open, autoShift, inertia 0.5, mass 90.
- `exampleEngineSpecForTests(overrides?)`: 2.0 L NA, 201 Nm @ 4800, ~128 kW @ 6800, idle 900,
  redline 7200, limiter 7400. **Does not import engine.ts.**

### Differential contract (important for vehicle.ts)
Sign: torque > 0 drives forward, < 0 is engine braking. Capacities are ≥ 0 Nm at the wheel
(`tyre maxForce × radius`); negative/NaN → 0. Returned `left + right === axleTorque` **always**
(an ideal diff conserves torque; efficiency is applied upstream in `driveTorqueAtWheels`), and
neither output ever flips sign relative to the input.

`spinLeft`/`spinRight` ≡ "this hub receives more torque magnitude than its tyre can react". The
excess stays **in the returned torque** so the vehicle model can integrate it into wheel spin-up
(positive torque) or lock-up tendency (engine braking). Nothing is silently dropped.

- **Open**: `left = right = T/2`. Flags whichever wheel(s) exceed capacity (normally the weaker;
  both if both exceed, e.g. both in the air). This is the exact physics of an ideal open diff
  (equal hub torques); the "axle can only react 2 × min(cap)" limit emerges dynamically **only** if
  the vehicle model integrates the spinning wheel's ω with its inertia and derives engine rpm from
  the mean driven-wheel speed, so the spinning wheel runs the engine into the limiter and torque
  collapses — the classic one-wheel-peel. The vehicle stub (`vehicle.ts`) describes a *quasi-static*
  torque balance instead. **In a quasi-static model you must apply the limit yourself**: when
  exactly one wheel of an open axle is flagged, the gripping wheel's usable drive torque is
  `min(its returned torque, slide × cap_weak)` where `slide = tireSlideRatio(spec, surface)` (a
  spinning tyre reacts its *sliding* capacity, and an open diff can give the other side no more).
  Otherwise an open diff is nearly as good as an LSD. For an LSD in a quasi-static model use the
  returned torques as-is (the transfer is already applied; the flagged wheel's excess is the spin).
- **LSD** (`lock = T ≥ 0 ? powerLock : coastLock`, clamped 0..1; `half = |T|/2`):
  1. *Grip sensing*: `excess = half − cap_weak`; move `min(lock × excess, cap_strong − half)` from the
     weaker (lower-capacity) wheel to the stronger one. The weaker wheel keeps
     `cap_weak + (1 − lock) × excess`; at `lock = 1` that is exactly `min(half, cap_weak)`; at
     `lock = 0` it is an open diff. Both over capacity ⇒ no headroom ⇒ both spin.
  2. *Speed sensing* (the clutch pack): the **faster** wheel gives up to `lock × half` to the slower
     one, algebraically, scaled by `tanh(Δω / ω_ref)` with
     `ω_ref = max(1 rad/s, 0.03 × |mean ω|)`. Under power in a corner this biases torque to the slower
     inner wheel (the LSD "push"); under coast it puts more engine braking on the faster outer wheel
     (entry stability). It never pushes the receiving wheel past its capacity, so it cannot itself
     create wheelspin. Maximum torque difference between the wheels is `lock × |T|`
     (`lock 0.5` ⇔ torque-bias ratio 3:1, matching real clutch LSDs).
  Total transfer clamped to `±lock × half`. `lockSpeeds` is always `false` for an LSD.
  Example (`lock 0.5`, `T = 800`, both wheels gripping, right 3 rad/s faster at 60 rad/s):
  left 585 / right 215. Corner exit (`T = 1600`, inner cap 300, outer cap 900): inner 700 (spins),
  outer 900 (at its limit).
- **Locked**: proportional to capacity (`T × cap_i / (capL + capR)`), `lockSpeeds = true`, **both**
  flags when `|T| > capL + capR`. Both capacities 0 → 50/50, both spin. One wheel in the air → all
  torque to the grounded wheel (no spin while within its grip).
- `T = 0` → zeros, no flags, `lockSpeeds` only for locked.

Stiffness warning for a fully dynamic wheel model: the LSD speed term has slope
`dτ/dΔω ≈ lock × half / ω_ref` (≈ 220 Nm per rad/s at `half = 800`, `lock 0.5`, 20 m/s). That is of
the same order as the tyre's own slip stiffness at that speed, so whatever you do to keep the tyre
integration stable at 120 Hz (relaxation length, semi-implicit ω update) also covers this term. A
"decision" model that sets ω kinematically has no feedback loop and needs nothing extra.

### Auto-shift rules (stateless; call once per step when `shiftTimer <= 0`; one gear step per call)
- Neutral / reverse / NaN gear → returns 1. Result always within 1..n.
- `throttle ≥ 0.5` (full-throttle rule): upshift when `rpm ≥ 0.985 × limiterRpm`, **or** when
  `rpm > peakTorqueRpm` and `torque(rpm) × ratio_cur ≤ torque(rpm × ratio_next/ratio_cur) × ratio_next`
  (the next gear would push at least as hard), via `interpTable(engine.torqueCurve)`.
- `throttle < 0.5`: upshift when `rpm > 1.15 × peakTorqueRpm` (or at 0.985 × limiter as a backstop
  for engines whose 1.15 × peak exceeds the limiter).
- Downshift when `rpm < max(1.8 × idleRpm, 0.45 × redlineRpm)` **and** the lower gear lands
  `< 0.92 × limiterRpm` **and** the lower gear would not satisfy the upshift rule even at
  `1.10 × landing rpm` (`DOWNSHIFT_UPSHIFT_MARGIN` — hysteresis wider than any plausible rpm noise).
  A limiter upshift can never be followed by an immediate downshift because `0.92 < 0.985`.
  Side effect: on a box with a wide 1→2 step (ratio > ~1.55) the part-throttle 2→1 downshift happens
  somewhat below the 0.45 × redline threshold (e.g. ~2630 rpm instead of 3240 for a 4.2/2.2 pair),
  never below `1.8 × idle`.
- With the example car every full-throttle upshift happens at ~7290 rpm (1→2 at 63 km/h, 2→3 at
  103, 3→4 at 150, 4→5 at 196, 5→6 at 237 km/h with r = 0.32 m) and lands between 4460 and 6140 rpm.
  The probe suite sweeps wheel speed up and down with ±3 % rpm noise at throttle 0 / 0.3 / 0.6 / 1
  on four gearboxes (close, example, wide, very wide) × two engines and requires every shift to be in
  the direction of travel; holding any fixed wheel speed with noise settles within ≤ 5 shifts. The
  peaky-engine test demonstrates the torque-crossing rule shifting early.

### Assumptions / simplifications (for docs/ASSUMPTIONS.md → Engine & drivetrain)
- Ideal, lossless differentials: `left + right = axle torque`; gearbox/final-drive losses are one
  efficiency factor applied to torque magnitude in both directions (coast too).
- Reverse ratio = 1.1 × first gear; no gear for it in `gearRatios`.
- AWD is a fixed front/rear torque split (`frontTorqueSplit`); no centre differential, no
  torque-vectoring, no inter-axle speed coupling.
- LSD is a torque-sensing clutch pack with no preload (zero input torque ⇒ zero transfer) and a
  regularised (tanh) speed response instead of pure Coulomb friction; the speed reference scales with
  wheel speed so a straight line never engages it and a hairpin fully engages it.
- Wheel-capacity-based grip sensing uses the tyre's peak capacity, not the sliding value; the
  weaker wheel is identified by capacity (tie → the wheel spinning faster in the torque direction).
- Auto-shift is a static rule on rpm/throttle only (no speed prediction, no downshift blip, no
  kick-down on throttle stab beyond the part/full threshold at 0.5); one gear per call; the caller
  owns `shiftTimer` and torque interruption (`shiftTime`).
- No clutch: the vehicle model must handle launch (e.g. rpm = max(idle, kinematic rpm) in 1st).
