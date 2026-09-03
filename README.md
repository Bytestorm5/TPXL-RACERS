# RACERS

Design cars from **real physical parameters** — then race them together.

RACERS is a game — in the browser or as a desktop app — about the feeling of building a car and
finding out what it actually does on track, rendered in 3D. There are no abstract "handling: 74/100" stats anywhere in the game. Every choice you make
in the garage — tyre compound and pressure, brake disc size and pad compound, spring rates, gearing,
turbo boost, wing angle, where the engine sits — becomes a term in the simulation:

- Brakes are a **torque against grip**: too much torque or the wrong bias and a wheel locks; use them
  hard for ten corners and they fade, because the discs have a thermal model.
- Tyres have an **optimal load**, a temperature window, camber sensitivity and wear. A low-pressure
  front tyre that feels wonky in normal driving can come alive under trail-braking when the weight
  shifts forward — because the load moved it into its happy zone.
- A locked differential pushes wide on corner entry. An open one lights up the inside wheel on exit.
- The chassis is a 6-DOF rigid body on four struts: load transfer, dive and squat, body roll, wheel
  lift, jumps and rollovers all fall out of the same loop. Cars leave the ground over the crests and
  can end up on their roof.
- Track cars, rally cars, drift cars, muscle cars are not categories — they're what falls out of the
  parts you pick. Knobby tyres + soft long-travel springs + AWD + a 2-way diff *is* a rally car.

And if none of that means anything to you: the analysis panel explains what your car will do in plain
language ("rear axle locks before the front — this car will spin under braking"), and **auto-tune**
solvers will set your brake bias, gearing, tyre pressures, camber, aero and balance to sane values
for the car you built.

## Running it

```bash
npm install
npm run dev        # browser dev server → http://localhost:5173
npm test           # simulation test suite (the physics spec) + renderer geometry + UI smoke tests
npm run build      # typecheck + production build into dist/
npm run preview    # serve dist/ (http://localhost:4173)
npm run e2e        # browser drive-through with the real race (headless Chromium, see below)

npm run desktop:dev    # desktop app against the dev server (Electron)
npm run desktop:start  # build everything and run the desktop app
npm run desktop:dist   # package installers into release/ (win nsis/zip · mac dmg/zip · linux AppImage/tar.gz)
```

TypeScript + Vite; the 3D race view uses three.js (the only runtime dependency — the simulation and
the design layer have none); Node 22. The desktop app is an Electron shell around the same build:
saves live as JSON files in the app's user-data folder and you can drop your own track files in its
`tracks/` folder (`docs/TRACK_FORMAT.md`, *Loading your own tracks*). The e2e script needs a Chromium
binary (`/opt/pw-browsers/chromium` or `$CHROMIUM_PATH`); it builds, serves `vite preview --port 4174
--strictPort`, clicks through the garage and race setup, races on Clubsprint and Dunes Rallycross with
WebGL on SwiftShader and fails on any console error. Screenshots land in `scratch/shots/`.
`.github/workflows/ci.yml` runs the tests and build on every push and packages the desktop app on
tags (unsigned unless signing secrets are configured).

## How to play

1. **Garage** (`#/garage`) — pick a preset (Roadster S, Club Hatch, Track Weapon, Gravel Rally, Drift
   Missile, Muscle, Kei Racer, Ice Runner) or your own car. A 3D showroom shows the car as built
   (wider tyres, ride height, the wing and the colour update live; drag to orbit). Every slider
   re-runs the analysis: 0–100,
   top speed, skidpad g next to the g at which the car *rolls over*, braking distance and which axle
   locks first, brake temperature after ten stops, jump-landing load, downforce, the understeer
   gradient, an **estimated lap** on Clubsprint and Ridgeway (racing-line + speed-profile estimate,
   computed in the background after you stop dragging), engine and gearing charts, and a list of
   warnings each with an *Auto-fix*. *Auto-tune all* shows every proposed change before applying it.
   Presets are read-only: the first edit forks a copy into "Your cars". *Test drive* puts you alone on
   the selected track.
2. **Race setup** (`#/race`) — a track card per circuit/stage (minimap, length, surfaces, your best
   lap with this car), your car, laps, 0–7 opponents (the *Default line-up* is a performance spread of
   the presets), the AI skill and **Warm tyres at start** (on by default: tyres and brakes begin at
   working temperature — switch it off and cold slicks make lap 1 an adventure).
3. **Race** (`#/race/run`) — rendered in 3D: the road built from the track's own geometry (banking,
   crests, curbs, the start-line checker), rolling terrain, marker posts, cars sized from their
   builds, skid marks, dust on loose surfaces, and four cameras (C: chase · hood · overhead ·
   trackside). You start from the back of the grid; 3 s countdown with the field held
   on the brakes, then the race clock starts for everyone. The HUD shows position and standings (gap
   to the leader, laps down, reset count), lap and sector times with deltas to your previous lap,
   delta to your best lap this session,
   speed / gear / rpm with the red zone, pedals, tyre temperatures (blue cold → green in the window →
   red hot, with LOCK / SPIN / AIR flags), brake temperatures and fade, the surface under the car and
   the road's altitude, grade, bank and your ride height (or air time). Cars leave the ground over
   crests, roll in corners and, if they tip past 55°, are WRECKED — the race puts them back on the
   road after 2.5 s (R does it at once). Results come up when you finish; the others keep racing
   until the table is complete. Best laps are remembered per track and car.

*Quick race* on the landing page is your current car against five presets, 3 laps of Clubsprint.

## Keyboard

| Key | Action |
| --- | --- |
| ↑ / W, ↓ / S | throttle, brake |
| ← → / A D | steer (smoothed) |
| Space | handbrake |
| E / Shift, Q / Ctrl | shift up / down (manual gearbox only; automatics shift for you) |
| R | reset onto the nearest centreline pose (zero speed, upright; counted as a reset) |
| T | telemetry panel: per-wheel utilisation, load, slip angle/ratio, temperature, ground contact, strut travel, brake/drive torque; body ax/ay/yaw rate/pitch/roll/z/vz/air time |
| C | camera: chase → hood → overhead → trackside |
| + / − (= / _) | camera distance |
| P | pause (no menu) |
| Esc | pause menu: resume / restart / race setup / garage / quit |
| F11 (desktop) | full screen |

Gamepad (standard mapping): left stick steers, RT / LT (or A / B) drive and brake, X handbrake,
RB / LB shift, Y camera, Back reset, Start pause menu. Garage and setup are ordinary focusable DOM:
Tab / Enter / Space work on car and track cards.

## Tracks

| id | Name | What it is for |
| --- | --- | --- |
| `speedbowl` | Speedbowl | 2.4 km banked oval — banking and top speed |
| `ridgeway` | Ridgeway | 4.9 km grand-prix circuit, the reference for analysis and lap estimates; launch-at-speed crest before the Kink, off-camber Final Corner |
| `pinecone-stage` | Pinecone Stage | 6.6 km point-to-point rally stage — loose surfaces, a full jump in the Kickers, off-camber Downhill Right |
| `clubsprint` | Clubsprint | 1.7 km tight club circuit — brakes and traction over power (Quick race runs here) |
| `glacier-loop` | Glacier Loop | 2.6 km snow/ice circuit — very low grip, snow tyres |
| `dunes-rallycross` | Dunes Rallycross | 1.5 km gravel/dirt rallycross loop — tabletop jump, mid-corner crest, off-camber dirt left, tarmac joker stretch, tight hairpin: the 6-DOF showcase, cars fly and can roll |

### Tracks are moddable

Tracks are JSON files describing a centreline as segments — curvature, width, banking, grade and
surface can each vary linearly across a segment, with optional lateral lanes (curbs, gravel strips).
Elevation, banked bowls, crests, gravel stages, ice loops are all expressible. See
[docs/TRACK_FORMAT.md](docs/TRACK_FORMAT.md) and the built-in tracks in `src/tracks/`.

## Status / known limitations

Verified in the browser (headless Chromium, `tests/e2e/ui_check.mjs`, real simulation): garage
editing and auto-tune, persistence, race setup, a 6-car two-lap race on Clubsprint with keyboard
input, telemetry, pause, reset and the results table, an 8-car race for the frame budget, and a
Gravel Rally run on Dunes Rallycross with the cars airborne over the tabletop. See
`docs/notes/ui.md` for the measured numbers.

- **Art** is procedural (boxes sized from the build, generated terrain, no trackside objects beyond
  posts and the gantry) and there are **no physical barriers** — leaving the road is grass/gravel,
  leaving the world is a reset. glTF car models and authored decor are the natural next steps.
- **Desktop installers** are unsigned until signing secrets are configured in CI.
- **Gaps between running cars** are a distance ÷ leader-speed estimate; only finished cars have exact
  gaps (shared race clock). Sectors are equal thirds of the lap by arc length, not authored splits.
- **AI race starts** were tidied late in development (launch traction control, reduced pack
  avoidance at low speed; a six-car Clubsprint start now keeps every car on the road in a probe),
  but a full grid on cold tyres or on gravel can still be scrappy for the first sector.
- **Delta to best** compares against your best lap of the *session* (progress-binned); the persisted
  record is a time only.
- **No barriers or scenery**: a car more than 40 m beyond the track edge for 3 s is put back on the
  road (counted as a reset), as is a car on its roof after 2.5 s.
- **AI** drivers follow a minimum-curvature line with a quasi-static speed profile; they avoid cars
  geometrically (no prediction), can get stuck on hopeless surfaces (a slick-shod car in sand) and
  are ~10 % slower than the garage's lap estimate. The estimate itself is optimistic by design.
- **Stages** have no staggered starts — everyone leaves at the green.
- **Cold tyres** (warm-up off) are punishing for the Track Weapon's slicks; that is the model, not a
  bug. Slicks spun for seconds overheat and lose grip for tens of seconds.
- **Test drive** from the garage is a 99-lap free run: there is no results screen, Esc → menu to leave.
- Skid marks are drawn for ≤ 6 cars only (per-frame budget).
- `localStorage` is used for cars, setup and best laps (`racers.*.v1`); private-mode / quota errors
  are ignored silently.

What the simulation deliberately simplifies is listed in [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the code is laid out and the simulation loop
- [docs/DESIGN_MODEL.md](docs/DESIGN_MODEL.md) — every garage knob → its physical effect
- [docs/TRACK_FORMAT.md](docs/TRACK_FORMAT.md) — the track standard for modders
- [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) — what the simulation deliberately simplifies
- [docs/notes/](docs/notes/) — per-module implementation notes (vehicle, race, AI, tracks, UI)
