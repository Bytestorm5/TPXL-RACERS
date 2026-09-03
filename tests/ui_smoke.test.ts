/**
 * UI smoke tests (node, no DOM): the editor covers every FIELD_RANGES path exactly once,
 * localStorage validators reject garbage, and the race-config builder compiles every entry.
 * (Browser behaviour is exercised by tests/e2e/ui_check.mjs, which is not part of vitest.)
 */
import { describe, expect, it } from 'vitest';
import { FIELD_RANGES, presetBuilds } from '../src/design/parts';
import { fieldLabel, getPath, SECTIONS, setPath } from '../src/ui/fields';
import { isBestFile, isCarBuildLike, isCarsFile, isSetupFile } from '../src/ui/storage';
import { buildRaceConfig } from '../src/ui/raceView';
import { Session } from '../src/ui/state';
import { fmtDelta, fmtLap, fmtStep, humanizePath } from '../src/ui/format';

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

describe('storage validators', () => {
  it('accept real builds and reject garbage', () => {
    const cars = presetBuilds();
    expect(isCarBuildLike(cars[0])).toBe(true);
    expect(isCarsFile({ format: 1, cars })).toBe(true);
    expect(isCarsFile({ format: 2, cars })).toBe(false);
    expect(isCarsFile({ format: 1, cars: [{ id: 'x' }] })).toBe(false);
    expect(isCarBuildLike(null)).toBe(false);
    expect(isSetupFile({ format: 1, trackId: 'clubsprint', laps: 3, playerCarId: 'a', opponents: ['b'], aiSkill: 0.8 })).toBe(true);
    expect(isSetupFile({ format: 1, trackId: 'clubsprint', laps: '3', playerCarId: 'a', opponents: [], aiSkill: 0.8 })).toBe(false);
    expect(isBestFile({ format: 1, best: { 'clubsprint|a': 61.2 } })).toBe(true);
    expect(isBestFile({ format: 1, best: { 'clubsprint|a': -1 } })).toBe(false);
  });
});

describe('session & race config (no localStorage in node)', () => {
  it('creates a default player car and compiles a race config for every built-in track', () => {
    const s = new Session();
    expect(s.cars.length).toBeGreaterThan(0);
    expect(s.findCar(s.selectedCarId)).toBeDefined();
    for (const t of s.trackSpecs) {
      const cfg = buildRaceConfig(s, { mode: 'race', trackId: t.id, laps: 2, playerCarId: s.selectedCarId, opponents: s.presets.map((p) => p.id), aiSkill: 0.9 });
      expect(cfg.entries.length).toBe(1 + s.presets.length);
      expect(cfg.entries[0].driver.kind).toBe('player');
      expect(cfg.laps).toBe(t.closed ? 2 : 1);
      const names = new Set(cfg.entries.map((e) => e.name));
      expect(names.size).toBe(cfg.entries.length);
      for (const e of cfg.entries) {
        expect(Number.isFinite(e.spec.mass)).toBe(true);
        if (e.driver.kind === 'ai') {
          expect(e.driver.skill).toBeGreaterThanOrEqual(0.3);
          expect(e.driver.skill).toBeLessThanOrEqual(1);
        }
      }
    }
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
