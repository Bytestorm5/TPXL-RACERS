/**
 * RACE SETUP screen (#/race): pick a track (minimap from compileTrack samples), your car,
 * laps, opponents and AI skill. Persists to racers.setup.v1.
 */
import type { CarBuild } from '../design/types';
import { clear, h } from './dom';
import { fmtLap } from './format';
import { ROUTES, type Nav, type Screen } from './screen';
import { MAX_OPPONENTS, type Session } from './state';
import { drawMinimap, SURFACE_LABEL, trackSurfaces } from './trackRender';

export function mountRaceSetup(root: HTMLElement, session: Session, nav: Nav): Screen {
  const setup = session.setup;
  if (!session.findCar(setup.playerCarId)) setup.playerCarId = session.defaultPlayerCar().id;
  if (setup.opponents.length === 0) setup.opponents = session.presets.slice(0, 5).map((p) => p.id);

  const save = (): void => session.saveSetup();

  // ---------------------------------------------------------------- tracks
  const trackGrid = h('div', { class: 'track-grid' });
  const cards = new Map<string, HTMLElement>();
  const bestLine = new Map<string, HTMLElement>();
  for (const spec of session.trackSpecs) {
    const track = session.getTrack(spec.id);
    const canvas = h('canvas', { class: 'minimap' });
    const best = h('div', { class: 'small mono muted' });
    bestLine.set(spec.id, best);
    const card = h(
      'div',
      {
        class: 'track-card',
        tabindex: 0,
        role: 'button',
        dataset: { track: spec.id },
        onclick: () => selectTrack(spec.id),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectTrack(spec.id);
          }
        },
      },
      canvas,
      h('div', { class: 'track-name' }, spec.name, h('span', { class: 'tag' }, spec.closed ? 'circuit' : 'stage')),
      h('div', { class: 'small mono muted' }, `${(track.length / 1000).toFixed(2)} km · ${spec.ambientTemp ?? 22} °C`),
      h('div', { class: 'surface-tags' }, trackSurfaces(track).map((s) => h('span', { class: `stag stag-${s}` }, SURFACE_LABEL[s]))),
      h('p', { class: 'track-desc' }, spec.description ?? ''),
      best,
    );
    cards.set(spec.id, card);
    trackGrid.appendChild(card);
    requestAnimationFrame(() => drawMinimap(canvas, track, 250, 150));
  }

  const lapsInput = h('input', { type: 'number', class: 'num', min: 1, max: 50, step: 1, value: setup.laps, 'aria-label': 'Laps' });
  const lapsNote = h('div', { class: 'field-hint' });
  lapsInput.addEventListener('change', () => {
    const v = Math.max(1, Math.min(50, Math.round(Number(lapsInput.value) || 1)));
    setup.laps = v;
    lapsInput.value = String(v);
    save();
  });

  function selectTrack(id: string): void {
    setup.trackId = id;
    for (const [tid, card] of cards) card.classList.toggle('active', tid === id);
    const spec = session.trackSpec(id);
    lapsInput.disabled = !spec.closed;
    lapsNote.textContent = spec.closed ? 'Race distance in laps.' : 'Point-to-point stage: one run, timed from the start line to the end.';
    refreshBest();
    save();
  }

  function refreshBest(): void {
    for (const [tid, el] of bestLine) {
      const b = session.getBest(tid, setup.playerCarId);
      el.textContent = b ? `Best lap (this car): ${fmtLap(b)}` : 'No lap recorded with this car yet.';
    }
  }

  // ---------------------------------------------------------------- cars
  const carOption = (c: CarBuild, selected: string): HTMLOptionElement =>
    h('option', { value: c.id, selected: c.id === selected }, `${c.name}${session.isPreset(c.id) ? ' (preset)' : ''}`);

  const playerSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Your car', onchange: () => {
      setup.playerCarId = playerSelect.value;
      refreshBest();
      save();
    } },
    session.allCars().map((c) => carOption(c, setup.playerCarId)),
  );

  const oppList = h('div', { class: 'opp-list' });
  const oppCount = h('input', { type: 'range', min: 0, max: MAX_OPPONENTS, step: 1, value: setup.opponents.length, 'aria-label': 'Number of opponents' });
  const oppCountLabel = h('span', { class: 'mono' }, String(setup.opponents.length));
  const renderOpponents = (): void => {
    clear(oppList);
    setup.opponents.forEach((id, i) => {
      const sel = h(
        'select',
        { class: 'select small', 'aria-label': `Opponent ${i + 1}`, onchange: () => {
          setup.opponents[i] = sel.value;
          save();
        } },
        session.allCars().map((c) => carOption(c, id)),
      );
      oppList.appendChild(h('div', { class: 'opp-row' }, h('span', { class: 'mono muted' }, `${i + 1}`), sel));
    });
  };
  oppCount.addEventListener('input', () => {
    const n = Math.round(Number(oppCount.value));
    oppCountLabel.textContent = String(n);
    while (setup.opponents.length > n) setup.opponents.pop();
    while (setup.opponents.length < n) {
      const presets = session.presets;
      setup.opponents.push(presets[setup.opponents.length % presets.length].id);
    }
    renderOpponents();
    save();
  });
  renderOpponents();

  const skill = h('input', { type: 'range', min: 0.3, max: 1, step: 0.05, value: setup.aiSkill, 'aria-label': 'AI skill' });
  const skillLabel = h('span', { class: 'mono' }, setup.aiSkill.toFixed(2));
  skill.addEventListener('input', () => {
    setup.aiSkill = Number(skill.value);
    skillLabel.textContent = setup.aiSkill.toFixed(2);
    save();
  });

  const start = (): void => {
    const spec = session.trackSpec(setup.trackId);
    session.pending = {
      mode: 'race',
      trackId: setup.trackId,
      laps: spec.closed ? setup.laps : 1,
      playerCarId: setup.playerCarId,
      opponents: [...setup.opponents],
      aiSkill: setup.aiSkill,
    };
    save();
    nav(ROUTES.run);
  };

  const el = h(
    'div',
    { class: 'screen setup' },
    h('section', { class: 'setup-tracks' }, h('div', { class: 'panel-title' }, 'Track'), trackGrid),
    h(
      'aside',
      { class: 'setup-side' },
      h('div', { class: 'panel-title' }, 'Race'),
      h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('label', null, 'Your car')), playerSelect, h('a', { class: 'small link', href: ROUTES.garage }, 'Edit in the garage ▸')),
      h('div', { class: 'field' }, h('div', { class: 'field-head' }, h('label', null, 'Laps')), lapsInput, lapsNote),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'field-head' }, h('label', null, 'Opponents'), oppCountLabel),
        oppCount,
        oppList,
      ),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'field-head' }, h('label', null, 'AI skill'), skillLabel),
        skill,
        h('div', { class: 'field-hint' }, '1.0 uses ~97% of the estimated grip, 0.5 about 80%.'),
      ),
      h('button', { class: 'btn btn-primary btn-big', dataset: { action: 'start-race' }, onclick: start }, 'Start race'),
      h('p', { class: 'small muted' }, 'Keyboard: ↑/W throttle · ↓/S brake · ←→/A D steer · Space handbrake · E/Q shift · R reset · T telemetry · Esc pause'),
    ),
  );
  root.appendChild(el);
  selectTrack(setup.trackId);
  return { unmount: () => el.remove() };
}
