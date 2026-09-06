# Notes — desktop shell (`electron/**`, `scripts/desktop-*.mjs`, `src/ui/desktop.ts`)

Electron (Chromium) around the unchanged Vite build. Chosen over Tauri because the game needs a
predictable WebGL stack on all three desktops; the OS webviews (WKWebView, WebKitGTK) are weaker and
inconsistent for WebGL, Chromium is what the e2e already tests.

```
electron/main.ts      window, menu (fullscreen F11, reload, devtools, open tracks/save folder), IPC
electron/preload.ts   contextBridge → window.racersDesktop (storage · tracks · app)
electron/tsconfig.json  CommonJS build into dist-electron/ (sandboxed preloads must be CJS)
scripts/desktop-build.mjs  tsc + writes dist-electron/package.json {"type":"commonjs"}
scripts/desktop-dev.mjs    vite dev server + electron with VITE_DEV_SERVER_URL
electron-builder.yml  packaging: win nsis/zip, mac dmg/zip, linux AppImage/tar.gz → release/
src/ui/desktop.ts     the bridge's TypeScript shape; desktop() is null in the browser
```

Scripts: `desktop:dev`, `desktop:build`, `desktop:start` (build + run), `desktop:dist` (build +
package), `desktop:typecheck`. `package.json` `main` points at `dist-electron/main.js`.

## Security posture

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, no remote module. The preload
exposes exactly: `storage.get/set/remove(key)`, `tracks.list()/openFolder()`, `app.info()/
toggleFullscreen()`. Storage keys are validated against `^[a-zA-Z0-9._-]{1,64}$` in the main process
(they become file names), values are capped at 8 MB, track files at 4 MB. `window.open` targets go to
the system browser and are denied in-app.

## Storage

`src/ui/storage.ts` has one backend interface (`get/set/remove` of strings): localStorage in the
browser, the bridge in the shell (JSON files `<userData>/storage/<key>.json`, read synchronously
once at start-up, written fire-and-forget). Validators and the silent-reset behaviour are unchanged;
`setStorageBackend` injects one for tests (tests/ui_smoke.test.ts). `storageKind()` says which is
active. `RACERS_USER_DATA=<dir>` relocates `userData` (portable installs, smoke tests).

## User tracks (mods)

`<userData>/tracks/*.json` (a README.txt is written on first run; menu → *Open tracks folder*). The
main process parses each file and returns `{file, spec}` or `{file, error}`; the renderer
(`loadUserTracks` in `src/ui/state.ts`) guards the shape, runs `validateTrack`, rejects duplicate ids
and ids that shadow a built-in, and lists every file with its outcome on the *Race setup* screen
(“Track mods” panel with *Open tracks folder* / *Reload tracks*). Loadable tracks get a card tagged
**mod**; saved setups pointing at a track that disappeared fall back to Clubsprint.

## Input

The gamepad (`src/ui/gamepad.ts`, standard mapping, polled per frame) works in the browser and the
shell alike; nothing desktop-specific was needed.

## Smoke mode

`electron . --smoke=<png> [--hash=#/race]` loads the app, waits 6 s, writes a screenshot of the window
and exits 0 (2 if the page logged console errors). Used under Xvfb here:
`xvfb-run -a npx electron . --no-sandbox --smoke=scratch/shots/electron-race.png --hash=#/race/run`.
Verified: landing, the setup screen with a user track + a broken file listed, and the race screen
rendering in 3D (software GL in the container). Saves landed in `storage/racers.cars.v1.json`.

## Packaging and CI

`.github/workflows/ci.yml`: every push runs `npm test`, `npm run build`, `desktop:typecheck` on
Ubuntu (Electron's binary download skipped); tags `v*` and manual runs package on Ubuntu, Windows and
macOS and upload the installers as artifacts. **No code signing / notarisation is configured** —
installers show the usual first-launch warnings until `CSC_LINK` / `CSC_KEY_PASSWORD` (and the Apple
notarisation variables) are added as secrets; electron-builder picks them up without config changes.
Auto-update is not set up (electron-updater would need a publish target).

Not verified here: the packaged installers themselves (electron-builder needs the platform tool
chains; the CI matrix does that).
