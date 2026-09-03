# RACERS — notes for Claude Code sessions

Design cars from real physical parameters, race them together. TypeScript + Vite + Vitest, no
frameworks. The race is rendered in 3D with three.js (`src/render3d/`, the ONE runtime dependency —
the sim and design layers stay dependency-free); the garage/setup/HUD are vanilla DOM. Runs in the
browser and as a desktop app (Electron shell in `electron/`, see `docs/notes/desktop.md`).

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
- Rendering never feeds back into the sim: `src/render3d` reads `VehicleState`/`CompiledTrack` only.
  Sim → three.js frame mapping lives in `src/render3d/coords.ts` (tested); use it, don't re-derive.
- `node tests/e2e/ui_check.mjs` is the browser drive-through (headless Chromium, software WebGL);
  `npm run desktop:build` compiles the Electron shell (`desktop:dist` packages it).
