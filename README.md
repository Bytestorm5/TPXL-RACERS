# RACERS

Design cars from **real physical parameters** — then race them together.

RACERS is a browser game about the feeling of building a car and finding out what it actually does
on track. There are no abstract "handling: 74/100" stats anywhere in the game. Every choice you make
in the garage — tyre compound and pressure, brake disc size and pad compound, spring rates, gearing,
turbo boost, wing angle, where the engine sits — becomes a term in the simulation:

- Brakes are a **torque against grip**: too much torque or the wrong bias and a wheel locks; use them
  hard for ten corners and they fade, because the discs have a thermal model.
- Tyres have an **optimal load**, a temperature window, camber sensitivity and wear. A low-pressure
  front tyre that feels wonky in normal driving can come alive under trail-braking when the weight
  shifts forward — because the load moved it into its happy zone.
- A locked differential pushes wide on corner entry. An open one lights up the inside wheel on exit.
- Track cars, rally cars, drift cars, muscle cars are not categories — they're what falls out of the
  parts you pick. Knobby tyres + soft long-travel springs + AWD + a 2-way diff *is* a rally car.

And if none of that means anything to you: the analysis panel explains what your car will do in plain
language ("rear axle locks before the front — this car will spin under braking"), and **auto-tune**
solvers will set your brake bias, gearing, tyre pressures, camber, aero and balance to sane values
for the car you built.

## Running it

```bash
npm install
npm run dev        # dev server
npm test           # simulation test suite (the physics spec)
npm run build      # typecheck + production build
```

Keyboard: arrows/WASD drive, Space handbrake, E/Q shift, R reset, T telemetry, Esc pause.

## Tracks are moddable

Tracks are JSON files describing a centreline as segments — curvature, width, banking, grade and
surface can each vary linearly across a segment, with optional lateral lanes (curbs, gravel strips).
Elevation, banked bowls, crests, gravel stages, ice loops are all expressible. See
[docs/TRACK_FORMAT.md](docs/TRACK_FORMAT.md) and the built-in tracks in `src/tracks/`.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the code is laid out and the simulation loop
- [docs/DESIGN_MODEL.md](docs/DESIGN_MODEL.md) — every garage knob → its physical effect
- [docs/TRACK_FORMAT.md](docs/TRACK_FORMAT.md) — the track standard for modders
- [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) — what the simulation deliberately simplifies
