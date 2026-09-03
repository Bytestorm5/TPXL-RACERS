# RACERS — design model (build → spec formulas)

How every `CarBuild` field becomes a physical `VehicleSpec` term (`design/compile.ts`,
`design/parts.ts`, `sim/engine.ts`). No abstract stats: each row says what the knob does
physically and why a player should care. `compileBuild()` first runs `normalizeBuild()`, so
out-of-range saves still compile to a legal car.

Reference tyre for all compound base figures: **205 mm, 220 kPa, 17"**. `wr = width/205`,
`pr = 220/pressure`.

## Chassis

| Build field | Physical effect | Why you care |
| --- | --- | --- |
| `chassis.size` | Wheelbase, track, length, width, frontal area, base CG height and **baseMass** (bare steel chassis + body + interior) from `CHASSIS_SIZES`. kei 620 kg → truck 1800 kg. | Everything scales from here: a bigger car is heavier, drags more air, corners on a longer wheelbase (stable but lazier). |
| `chassis.material` | Chassis mass × factor: steel 1.0, aluminium 0.82, carbon 0.66. | The single biggest lightening lever; carbon removes ~370 kg from a mid chassis. |
| `chassis.weightReduction` (0..1) | Chassis mass × (1 − 0.15 × wr); CG height − 0.02 m × wr. | Stripping the interior: less mass everywhere *and* a slightly lower CG. |
| `chassis.enginePosition` | Engine lump placed at −0.12 / +0.18 / +0.72 / +1.08 of the wheelbase behind the front axle (front / front-mid / mid / rear); gearbox at 0.35 (front layouts) or 0.92 (mid/rear); yaw inertia × 0.9 (mid), 0.97 (front-mid), 1.05 (front/rear). | Sets the weight distribution: front ≈ 56–58% front, front-mid ≈ 53%, mid ≈ 43%, rear ≈ 40% — i.e. which axle's tyres are pressed hard, and how eagerly the car rotates. |
| `chassis.ballastMass` / `ballastPosition` | Point mass at position (1 − p)/2 of the wheelbase (+1 = front axle, −1 = rear axle); CG height − 0.05 m × (ballast/200) (floor-mounted). | Move the balance without changing parts — at the price of total mass. |
| `chassis.fuel` (kg) | Point mass at 0.85 of the wheelbase (tank behind the CG). | More fuel = heavier and slightly more rearward. (No consumption mid-race yet.) |
| — | Driver: fixed 80 kg at 0.45 of the wheelbase. | Always aboard. |

**Totals.** `mass` = chassis + engine + gearbox + 4 × (wheel + disc) + driver + fuel + ballast.
`cgToFront = wheelbase × Σ(mᵢ·posᵢ)/Σmᵢ`. `cgHeight = size.cgHeight + (avgRide − 0.120)·0.8 −
0.02·weightReduction − 0.05·(ballast/200)`. `yawInertia = mass · (0.16·wb² + 0.06·W²) ·
layoutFactor`. Unsprung mass per wheel = wheel + disc + 12 kg (hub/upright).

## Engine (`sim/engine.ts`)

| Build field | Physical effect | Why you care |
| --- | --- | --- |
| `displacement` (L) | Torque = BMEP(kPa) × disp / 4π. Engine mass = 55 + 40 × disp + 5 × cyl (+18 turbo / +22 SC). | Torque scales linearly with litres — and so does the lump you must carry (at the engine position). |
| `cylinders` | BMEP × (1 + 0.01 × (cyl − 4)); idle = 700 + 60 × (8 − cyl), clamped 600–1100 rpm. | Marginal breathing gain, more mass; small engines idle high. |
| `tune` | Torque-peak rpm fraction {eco 0.35, street 0.5, sport 0.62, race 0.75} and peakiness {0.3, 0.5, 0.7, 0.95}. Base NA BMEP = 1000 + 400 × peakiness. Below the peak the curve starts at lowEnd = 0.75 − 0.4 × peakiness; above it it falls to topEnd = 0.55 + 0.35 × peakiness at the redline (quadratic). | The cam trade: a race tune adds top-end power and holds torque to the redline, but is *weak below ~40% rpm* — pair it with short gears and revs. |
| `redline` | Curve extends to redline; limiter (fuel cut) at redline + 250 rpm. | Power = torque × rpm: revs are power *only if the tune keeps torque alive up there*. |
| `aspiration` + `boost` (bar) | Turbo: BMEP × (1 + 0.85 × boost × smoothstep(0.2·redline, 0.45·redline, rpm)) — no boost below spool; throttle response 0.05 + 0.25 × boost (lag). Supercharged: BMEP × (1 + 0.8 × boost) from idle, torque × (1 − 0.06 × boost) parasitic, response 0.08. NA: response 0.05. | Turbo = biggest numbers, but laggy and dead off-boost. Blower = instant, linear, slightly less at the top. |
| `flywheel` | Crank inertia = (0.08 + 0.05 × disp) × {light 0.6, standard 1, heavy 1.6}. | Light = revs snap up/down (fast shifts, easier to break traction); heavy = smooth launches. |
| — | Curve tabulated every 250 rpm idle→limiter; engine braking = 0.10 × peakTorque + 8 × disp, scaled with rpm (×1.5 cap), fuel cut above limiter, positive torque held at the idle value below idle. | Closed-throttle drag is real: big engines slow the car noticeably on lift. |

## Drivetrain

| Build field | Physical effect | Why you care |
| --- | --- | --- |
| `layout` | Torque split front 1 / 0 / awdFrontSplit (FWD/RWD/AWD); efficiency 0.92 / 0.90 / 0.85; gearbox mass 45 + 4 × gears, +55 AWD, −8 FWD. | AWD grips off the line and on loose stuff, but pays ~5–7% of the power and +55 kg. |
| `awdFrontSplit` | Fraction of torque to the front axle (AWD only). | Front-biased = stable/ploughy, rear-biased = rotates on throttle. |
| `gears`, `firstGear`, `topGear`, `gearRatios?`, `finalDrive` | Explicit ratios (if the list length matches `gears`), else a geometric spread first→top. Drivetrain inertia = 0.4 + 0.1 × gears. | Short 1st launches hard (until the tyres say no); tall top sets top speed; more gears keep the engine in its band. |
| `frontDiff` / `rearDiff` | open → {open}; lsd_1way → {lsd 0.5/0}; lsd_1_5way → {lsd 0.5/0.25}; lsd_2way → {lsd 0.6/0.6}; locked → {locked}. | Open = inside wheel spins on exit; 1-way locks only under power; 2-way also stabilises entry; locked = maximum traction, hates turning while gripping. |
| `gearbox` | shiftTime 0.12 s (auto) / 0.22 s (manual); autoShift flag. | Auto shifts faster and for you; manual is for control (and drift clutch-kicks later). |

## Tyres (per axle)

| Build field | Physical effect | Why you care |
| --- | --- | --- |
| `compound` | All base grip/thermal/wear figures from `TIRE_COMPOUNDS` — see the ladder: street 0.95 → slick_soft 1.45 peak mu, with progressively narrower and hotter temperature windows, faster heating and wear. Rally/snow tyres carry `surfaceAffinity` > 1 on loose surfaces; drift keeps 95% of grip while sliding. | The single biggest grip decision — and a *window*, not a number: a slick_soft below 84 °C grips like a street tyre. |
| `width` (mm) | optimalLoad × wr; peakMu × wr^0.08; loadSensitivity × wr^−0.5; underloadPenalty × wr^0.5; cornering/long stiffness × wr^0.3; heating × 1/wr; wear × 1/wr; cooling × wr^0.3; mass = 7 + 0.04 × width + 0.6 × rim. | Wider works harder before giving up and lasts longer — but is heavier, slower to warm and lazy when unloaded (a wide rear on a light rear axle is dead rubber). |
| `pressure` (kPa) | optimalLoad × pr^0.6; underloadPenalty × pr^0.7; peakSlipAngle × pr^0.2; heating × pr^0.5; rolling resistance × pr^0.5; stiffness × (p/220)^0.25; peakMu × (1 − 0.12·max(0,(p−260)/60) − 0.10·max(0,(150−p)/30)). | Lower pressure needs more load to work but grips harder when loaded (and runs hotter); higher is crisper and cooler but over ~260 kPa the patch shrinks. |
| `camber` (deg) | Static camber (rad) vs the compound's `optimalCamber`; lateral grip up to +camberGain at the optimum, longitudinal grip pays the same. | Lean the tyre into corners for side grip; too much costs braking and traction. |
| `rim` (inch) | radius = rim/2 × 25.4 mm + sidewall, sidewall = clamp(0.335 − 0.0127 × rim, 0.045, 0.14) (overall Ø ≈ 0.67 m); optimalLoad × (rim/17)^0.1; wheel mass +0.6 kg/inch; **disc must fit: ≤ rim × 25.4 − 60 mm**. | Bigger rims = crisper low-profile response and room for big brakes, at unsprung-mass cost. |

## Brakes

| Build field | Physical effect | Why you care |
| --- | --- | --- |
| `discFront/Rear` (mm) | maxTorque = 2 × padMu × 25 kN × (0.4 × Ø); disc mass = 8 × (Ø/330)^2.2; heatCapacity = discMass × 460 + 300 J/°C; coolingCoeff = 12 + 12 × (Ø/330); wheel inertia + 0.5 × discMass × (Ø/2000)². | Bigger = more torque and more metal to soak heat — but unsprung mass, and it must fit the rim. |
| `pads` | mu, fade band and cold behaviour from `BRAKE_PADS`: street 0.38 fades 350–550 °C but works ice-cold; race 0.50 fades 600–850 °C but has only 60% bite until 150 °C. | Street pads on track = fade by lap 3; race pads on the road = scary first stop. |
| `pads = carbon_ceramic` | Disc mass × 0.5, heat capacity per kg 800 J/°C, fade 800–1100 °C. | Endless fade resistance and less unsprung mass. |
| `bias` (0.5..0.9) | Bias bar: the front share of the **total** brake torque. The stronger axle (by `maxTorque`) gets full line pressure, the other is reduced so front/(front + rear) = bias exactly: with `neutral = mF/(mF+mR)`, `bias ≥ neutral` → rear pressure `((1−bias)/bias)·mF/mR`, else front pressure `(bias/(1−bias))·mR/mF`. | Braking throws load forward, so the balanced value ≈ the front axle's share of the tyre grip under hard braking (≈ 0.70–0.75 for most road cars, lower for low, rear-heavy cars such as the Track Weapon at 0.635): too much front → front lockup (plough), too little → rear lockup (spin). `autoTune('brakeBias')` finds it. |
| `abs` | Pass-through flag; the sim holds ~peak slip. | Safety vs the last few % and threshold-braking skill. |
| `ducts` (0..1) | coolingCoeff + 70 × ducts. | The cheap fix for fade. |
| — | handbrakeTorque = 0.45 × rear maxTorque. | Drift entries, hairpins. |

## Suspension & steering

| Build field | Physical effect | Why you care |
| --- | --- | --- |
| `springFront/Rear` (N/mm) | Wheel rate ×1000 → N/m; axle roll stiffness = 0.5 × rate × track² + ARB. | The axle with the larger share of total roll stiffness takes more lateral load transfer → that end breaks away first. Front-stiff = understeer, rear-stiff = oversteer. |
| `arbFront/Rear` (0..1) | + slider × 50 000 Nm/rad of roll stiffness. | Roll control without ride harshness; same balance lever as springs. |
| `damperFront/Rear` (0.2..1.2) | Damping ratio per axle: how fast load transfer settles. | Soft = smooth mid-corner weight shifts (rally); stiff = instant response (track). |
| `rideHeightFront/Rear` (mm) | CG height ± 0.8 × Δride; underbody downforce × ground effect around ref 0.10 m; travel = 0.06 + 0.4 × ride; roll centre = 0.3 × ride; drag ± 5%. | Low = less weight transfer + more ground effect + a touch less drag; high = travel for curbs, gravel and jumps-to-be. |
| `steeringLock` (deg) | Max road-wheel angle (rad); Ackermann 0.6, speed-limited lock (45 m/s → 30%) fixed. | Hairpins and drift angle; irrelevant in fast corners. |

## Aero

| Build field | Physical effect | Why you care |
| --- | --- | --- |
| `body` | Base Cd: streamlined 0.28, standard 0.33, boxy 0.42. | Free top speed (or the lack of it). |
| `splitter` (0..1) | liftAreaFront + 0.45 × splitter × frontalArea; Cd + 0.03 × splitter. | Front grip at speed — balances the wing. Body base lift is −0.05 (slight lift with no aero). |
| `wing` (0..1) | liftAreaRear + 0.9 × wing × frontalArea; Cd + 0.13 × wing. | Big rear grip, big drag: the classic downforce-vs-top-speed trade. Base rear lift −0.04. |
| `underbody` | none: +0.02 Cd, ride sensitivity 0.1; flat: +0.05/+0.10 front/rear lift area factors, sensitivity 0.4; diffuser: −0.01 Cd, +0.12/+0.35, sensitivity 0.9 (ref ride 0.10 m). | The diffuser is the low-drag downforce — but it lives and dies by ride height. |
| ride height (avg) | dragArea × (1 + clamp(0.1 × (avg − 0.12)/0.12, ±0.05)). | Lower car = slightly cleaner air. |

## normalizeBuild rules

Every continuous field is clamped into `FIELD_RANGES` (non-finite → range min; gears/rims
rounded); NA engines get boost 0; disc Ø ≤ rim × 25.4 − 60 mm; `gearRatios` of the wrong
length (or non-positive) are dropped, valid ones sorted descending; `awdFrontSplit` is
canonicalised to 0.5 for non-AWD; cylinders snap to {3,4,5,6,8,10,12}. Returns a new build.
