/**
 * UI smoke tests (node, no DOM): the editor covers every FIELD_RANGES path exactly once,
 * localStorage validators reject garbage, and the race-config builder compiles every entry.
 * (Browser behaviour is exercised by tests/e2e/ui_check.mjs, which is not part of vitest.)
 */
import { describe, expect, it } from 'vitest';
import { FIELD_RANGES, presetBuilds } from '../src/design/parts';
import { fieldLabel, getPath, SECTIONS, setPath } from '../src/ui/fields';
import { isBestFile, isCarBuildLike, isCarsFile, isSetupFile, KEYS, loadJson, saveJson, setStorageBackend, storageKind } from '../src/ui/storage';
import { buildRaceConfig } from '../src/ui/raceView';
import { loadUserTracks, Session } from '../src/ui/state';
import { BUILTIN_TRACKS } from '../src/tracks/index';
import { fmtDelta, fmtLap, fmtStep, humanizePath } from '../src/ui/format';
import { TABS } from '../src/ui/fields';
import { TAB_CHART_TITLES } from '../src/ui/garage';
import { detectUnitSystem, fieldUnits, localizeText, setUnitPreference, U, units } from '../src/ui/units';

describe('garage field descriptors', () => {
  it('cover every continuous FIELD_RANGES path exactly once', () => {
    const seen = new Map<string, number>();
    for (const s of SECTIONS) {
      for (const f of s.fields) {
        if (f.kind === 'range') seen.set(f.path, (seen.get(f.path) ?? 0) + 1);
      }
    }
    for (const path of Object.keys(FIELD_RANGES)) {
      expect(seen.get(path), `missing slider for ${path}`).toBe(1);
    }
    expect(seen.size).toBe(Object.keys(FIELD_RANGES).length);
  });

  it('select options match the preset values actually in use', () => {
    const presets = presetBuilds();
    for (const s of SECTIONS) {
      for (const f of s.fields) {
        if (f.kind !== 'select') continue;
        const allowed = new Set(f.options.map((o) => String(o.value)));
        for (const p of presets) {
          const v = getPath(p, f.path);
          expect(allowed.has(String(v)), `${f.path} = ${String(v)} in ${p.name}`).toBe(true);
        }
      }
    }
  });

  it('getPath/setPath round-trip and labels resolve', () => {
    const b = presetBuilds()[0];
    setPath(b, 'tires.front.pressure', 199);
    expect(getPath(b, 'tires.front.pressure')).toBe(199);
    expect(fieldLabel('brakes.bias')).toBe(FIELD_RANGES['brakes.bias'].label);
    expect(fieldLabel('tires.rear.compound')).toBe('Rear compound');
    expect(humanizePath('tires.front.compound')).toBe('Front compound');
  });
});

describe('garage tabs', () => {
  it('every section belongs to exactly one tab and every tab has at least one chart', () => {
    const seen = new Map<string, number>();
    for (const t of TABS) for (const sid of t.sections) seen.set(sid, (seen.get(sid) ?? 0) + 1);
    for (const s of SECTIONS) expect(seen.get(s.id), `section ${s.id} not in a tab`).toBe(1);
    expect(seen.size).toBe(SECTIONS.length);
    for (const t of TABS) {
      expect(TAB_CHART_TITLES[t.id]?.length ?? 0, `tab ${t.id} has no chart`).toBeGreaterThan(0);
      const areas = new Set(t.sections.map((sid) => SECTIONS.find((s) => s.id === sid)!.area));
      expect(areas.size, `tab ${t.id} mixes warning areas`).toBe(1);
      expect([...areas][0]).toBe(t.area);
    }
  });
});

describe('display units', () => {
  it('auto-detects imperial for US locales only', () => {
    expect(detectUnitSystem('en-US')).toBe('imperial');
    expect(detectUnitSystem('en_us')).toBe('imperial');
    expect(detectUnitSystem('es-US')).toBe('imperial');
    expect(detectUnitSystem('en-GB')).toBe('metric');
    expect(detectUnitSystem('de')).toBe('metric');
    expect(detectUnitSystem('my-MM')).toBe('imperial');
    expect(detectUnitSystem('')).toBe('metric');
    // no argument → the runtime's own locale (Node reports navigator.language too)
    expect(['metric', 'imperial']).toContain(detectUnitSystem());
  });

  it('converts at the display boundary and back for the garage fields', () => {
    setUnitPreference('imperial');
    try {
      expect(units()).toBe('imperial');
      expect(U.speed(10).value).toBeCloseTo(22.369, 2);
      expect(U.speed(10).unit).toBe('mph');
      expect(U.temp(100).value).toBeCloseTo(212, 9);
      expect(U.mass(1000).value).toBeCloseTo(2204.6, 1);
      expect(U.pressure(220).value).toBeCloseTo(31.9, 1);
      expect(U.torque(100).value).toBeCloseTo(73.76, 2);
      expect(U.power(74570).value).toBeCloseTo(100, 1);
      expect(U.dist(100).unit).toBe('ft');
      const mm = fieldUnits('mm', 10);
      expect(mm.unit).toBe('in');
      expect(mm.from(mm.to(225))).toBeCloseTo(225, 9);
      const kpa = fieldUnits('kPa', 5);
      expect(kpa.from(kpa.to(220))).toBeCloseTo(220, 9);
      const rate = fieldUnits('N/mm', 1);
      expect(rate.unit).toBe('lb/in');
      expect(rate.to(100)).toBeCloseTo(571, 0);
      expect(fieldUnits('deg', 0.1).unit).toBe('deg'); // unchanged
      expect(localizeText('top speed 200 km/h, discs reach 350 °C, 1200 kg, stops in 40 m')).toBe('top speed 124 mph, discs reach 662 °F, 2646 lb, stops in 131 ft');
      expect(localizeText('0–100 in 4.5 s at 250 kPa')).toBe('0–62 mph in 4.5 s at 36.3 psi');
    } finally {
      setUnitPreference('metric');
    }
    expect(U.speed(10).unit).toBe('km/h');
    expect(fieldUnits('mm', 10).unit).toBe('mm');
    expect(localizeText('200 km/h')).toBe('200 km/h');
    setUnitPreference('auto');
  });
});

describe('storage validators', () => {
  it('accept real builds and reject garbage', () => {
    const cars = presetBuilds();
    expect(isCarBuildLike(cars[0])).toBe(true);
    expect(isCarsFile({ format: 1, cars })).toBe(true);
    expect(isCarsFile({ format: 2, cars })).toBe(false);
    expect(isCarsFile({ format: 1, cars: [{ id: 'x' }] })).toBe(false);
    expect(isCarBuildLike(null)).toBe(false);
    expect(isSetupFile({ format: 1, trackId: 'clubsprint', laps: 3, playerCarId: 'a', opponents: ['b'], aiSkill: 0.8 })).toBe(true);
    expect(isSetupFile({ format: 1, trackId: 'clubsprint', laps: 3, playerCarId: 'a', opponents: ['b'], aiSkill: 0.8, preheatTyres: false })).toBe(true);
    expect(isSetupFile({ format: 1, trackId: 'clubsprint', laps: 3, playerCarId: 'a', opponents: ['b'], aiSkill: 0.8, preheatTyres: 'yes' })).toBe(false);
    expect(isSetupFile({ format: 1, trackId: 'clubsprint', laps: '3', playerCarId: 'a', opponents: [], aiSkill: 0.8 })).toBe(false);
    expect(isBestFile({ format: 1, best: { 'clubsprint|a': 61.2 } })).toBe(true);
    expect(isBestFile({ format: 1, best: { 'clubsprint|a': -1 } })).toBe(false);
  });
});

describe('storage backend (desktop bridge shape)', () => {
  it('reads and writes through an injected backend and drops invalid saves', () => {
    const files = new Map<string, string>();
    setStorageBackend({ get: (k) => files.get(k) ?? null, set: (k, v) => void files.set(k, v), remove: (k) => void files.delete(k) });
    try {
      expect(storageKind()).toBe('browser');
      saveJson(KEYS.best, { format: 1, best: { 'clubsprint|x': 70 } });
      expect(loadJson(KEYS.best, isBestFile)?.best['clubsprint|x']).toBe(70);
      files.set(KEYS.best, '{"format":1,"best":{"a":-5}}');
      expect(loadJson(KEYS.best, isBestFile)).toBeNull();
      expect(files.has(KEYS.best)).toBe(false); // invalid file removed
      files.set(KEYS.setup, 'not json');
      expect(loadJson(KEYS.setup, isSetupFile)).toBeNull();
      // a Session persists its cars through the same backend
      const s = new Session();
      expect(files.has(KEYS.cars)).toBe(true);
      expect(isCarsFile(JSON.parse(files.get(KEYS.cars)!))).toBe(true);
      s.setBest('clubsprint', s.selectedCarId, 66);
      expect(JSON.parse(files.get(KEYS.best)!).best[`clubsprint|${s.selectedCarId}`]).toBe(66);
    } finally {
      setStorageBackend(null);
    }
    expect(storageKind()).toBe('none');
  });
});

describe('user track files (desktop tracks folder)', () => {
  it('loads valid specs, reports parse/validation errors and rejects duplicate ids', () => {
    const good = { ...BUILTIN_TRACKS[3], id: 'my-track', name: 'My Track' };
    const res = loadUserTracks([
      { file: 'good.json', spec: good },
      { file: 'broken.json', error: 'Unexpected token' },
      { file: 'notatrack.json', spec: { hello: 1 } },
      { file: 'dup.json', spec: { ...good } },
      { file: 'shadow.json', spec: { ...good, id: BUILTIN_TRACKS[0].id } },
      { file: 'invalid.json', spec: { ...good, id: 'bad', segments: [{ length: -5 }] } },
    ]);
    expect(res.map((r) => r.spec !== null)).toEqual([true, false, false, false, false, false]);
    expect(res[1].error).toMatch(/Unexpected token/);
    expect(res[2].error).toMatch(/not a RACERS track/);
    expect(res[3].error).toMatch(/duplicate/);
    expect(res[4].error).toMatch(/duplicate/);
    expect(res[5].error).toMatch(/segment/i);
    // in the browser the session has no user tracks and only the built-ins
    const s = new Session();
    expect(s.userTracks).toEqual([]);
    expect(s.trackSpecs.length).toBe(BUILTIN_TRACKS.length);
    expect(s.hasTrack('clubsprint')).toBe(true);
    expect(s.hasTrack('nope')).toBe(false);
  });
});

describe('session & race config (no localStorage in node)', () => {
  it('creates a default player car and compiles a race config for every built-in track', () => {
    const s = new Session();
    expect(s.cars.length).toBeGreaterThan(0);
    expect(s.findCar(s.selectedCarId)).toBeDefined();
    for (const t of s.trackSpecs) {
      const cfg = buildRaceConfig(s, { mode: 'race', trackId: t.id, laps: 2, playerCarId: s.selectedCarId, opponents: s.presets.map((p) => p.id), aiSkill: 0.9, preheatTyres: true });
      expect(cfg.entries.length).toBe(1 + s.presets.length);
      // opponents fill the grid in line-up order, the player starts from the back
      expect(cfg.entries[cfg.entries.length - 1].driver.kind).toBe('player');
      expect(cfg.entries.filter((e) => e.driver.kind === 'player').length).toBe(1);
      expect(cfg.laps).toBe(t.closed ? 2 : 1);
      expect(cfg.preheatTyres).toBe(true);
      const names = new Set(cfg.entries.map((e) => e.name));
      expect(names.size).toBe(cfg.entries.length);
      expect(cfg.entries[cfg.entries.length - 1].name).toBe(s.findCar(s.selectedCarId)!.name);
      for (const e of cfg.entries) {
        expect(Number.isFinite(e.spec.mass)).toBe(true);
        if (e.driver.kind === 'ai') {
          expect(e.driver.skill).toBeGreaterThanOrEqual(0.3);
          expect(e.driver.skill).toBeLessThanOrEqual(1);
        }
      }
    }
    const cold = buildRaceConfig(s, { mode: 'race', trackId: 'clubsprint', laps: 1, playerCarId: s.selectedCarId, opponents: [], aiSkill: 0.8, preheatTyres: false });
    expect(cold.preheatTyres).toBe(false);
    expect(cold.entries.length).toBe(1);
  });

  it('defaults to a performance spread of presets with warm tyres', () => {
    const s = new Session();
    const d = s.defaultSetup();
    expect(d.preheatTyres).toBe(true);
    expect(d.opponents.length).toBe(5);
    expect(new Set(d.opponents).size).toBe(5);
    for (const id of d.opponents) expect(s.isPreset(id)).toBe(true);
    expect(d.opponents).not.toContain('preset_drift_missile');
    expect(d.opponents).not.toContain('preset_ice_runner');
    expect(s.quickRace().opponents).toEqual(d.opponents);
    expect(s.quickRace().preheatTyres).toBe(true);
  });

  it('records best laps only when faster', () => {
    const s = new Session();
    expect(s.setBest('clubsprint', 'car', 70)).toBe(true);
    expect(s.setBest('clubsprint', 'car', 75)).toBe(false);
    expect(s.setBest('clubsprint', 'car', 69.5)).toBe(true);
    expect(s.getBest('clubsprint', 'car')).toBe(69.5);
    expect(s.setBest('clubsprint', 'car', NaN)).toBe(false);
  });
});

describe('formatting', () => {
  it('formats lap times and deltas', () => {
    expect(fmtLap(61.234)).toBe('1:01.234');
    expect(fmtLap(5.5, 1)).toBe('0:05.5');
    expect(fmtLap(9.99, 1)).toBe('0:10.0'); // pad after rounding, not before
    expect(fmtLap(59.96, 1)).toBe('1:00.0');
    expect(fmtLap(125.0005, 3)).toBe('2:05.001');
    expect(fmtLap(null)).toBe('--:--.---');
    expect(fmtDelta(0.42)).toBe('+0.42');
    expect(fmtDelta(-1.034)).toBe('−1.03');
    expect(fmtStep(0.705, 0.005)).toBe('0.705');
    expect(fmtStep(3, 1)).toBe('3');
  });
});
