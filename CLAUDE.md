# RACERS — notes for Claude Code sessions

Browser game: design cars from real physical parameters, race them together. TypeScript + Vite +
Canvas 2D + Vitest, zero runtime dependencies, no frameworks.

- `npm test` runs the physics suite — it is the executable spec; never weaken a scenario to get green
  unless it is physically wrong, and say so in docs/ASSUMPTIONS.md.
- `npm run build` = typecheck + vite build. Node 22.
- Read `docs/ARCHITECTURE.md` first. Contracts live in `src/sim/types.ts`, `src/sim/trackTypes.ts`,
  `src/design/types.ts` — treat existing exported shapes as frozen API; add, don't rename.
- Hard rules: the sim never reads a `CarBuild` (only `VehicleSpec`); no abstract 0–100 stats — every
  knob maps to a physical term; deterministic sim (no `Math.random()` in `src/sim` — use `makeRng`);
  SI units, body frame x forward / y LEFT / CCW positive.
- Every deliberate simplification goes in `docs/ASSUMPTIONS.md`. Garage-knob→physics formulas are
  documented in `docs/DESIGN_MODEL.md`; the modding track format in `docs/TRACK_FORMAT.md`.
- Per-module implementation notes (sign conventions, caller contracts) are in `docs/notes/`.
