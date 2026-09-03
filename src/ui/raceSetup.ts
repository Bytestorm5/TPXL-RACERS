/**
 * RACE SETUP screen (#/race): pick a track (minimap from compileTrack samples), your car,
 * laps, opponents, AI skill and the warm-tyres option. Persists to racers.setup.v1.
 */
import type { CarBuild } from '../design/types';
import { desktop } from './desktop';
import { clear, h, toast } from './dom';
import { fmtLap } from './format';
import { ROUTES, type Nav, type Screen } from './screen';
import { MAX_OPPONENTS, type Session } from './state';
import { drawMinimap, SURFACE_LABEL, trackSurfaces } from './trackRender';
import { fq, U } from './units';

export function mountRaceSetup(root: HTMLElement, session: Session, nav: Nav): Screen {
  const setup = session.setup;
  if (!session.findCar(setup.playerCarId)) setup.playerCarId = session.defaultPlayerCar().id;
  setup.opponents = setup.opponents.filter((id) => session.findCar(id)).slice(0, MAX_OPPONENTS);
  setup.aiSkill = Number.isFinite(setup.aiSkill) ? Math.max(0.3, Math.min(1, setup.aiSkill)) : 0.8;
  if (typeof setup.preheatTyres !== 'boolean') setup.preheatTyres = true;

  const save = (): void => session.saveSetup();

  // ---------------------------------------------------------------- tracks
  const trackGrid = h('div', { class: 'track-grid' });
  const cards = new Map<string, HTMLElement>();
  const bestLine = new Map<string, HTMLElement>();
  const builtinIds = new Set(session.trackSpecs.filter((t) => !session.userTracks.some((u) => u.spec === t)).map((t) => t.id));
  const renderTrackCards = (): void => {
    clear(trackGrid);
    cards.clear();
    bestLine.clear();
    for (const spec of session.trackSpecs) {
      const track = session.getTrack(spec.id);
      const canvas = h('canvas', { class: 'minimap' });
      const best = h('div', { class: 'small mono muted' });
      bestLine.set(spec.id, best);
      const user = !builtinIds.has(spec.id);
      const card = h(
        'div',
        {
          class: 'track-card',
          tabindex: 0,
          role: 'button',
          dataset: { track: spec.id, user: String(user) },
          onclick: () => selectTrack(spec.id),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectTrack(spec.id);
            }
          },
        },
        canvas,
        h('div', { class: 'track-name' }, spec.name, h('span', { class: 'tag' }, spec.closed ? 'circuit' : 'stage'), user ? h('span', { class: 'tag accent' }, 'mod') : null),
        h('div', { class: 'small mono muted' }, `${fq(U.distLong(track.length), 2)} · ${fq(U.temp(spec.ambientTemp ?? 22))}${user && spec.author ? ` · by ${spec.author}` : ''}`),
        h('div', { class: 'surface-tags' }, trackSurfaces(track).map((s) => h('span', { class: `stag stag-${s}` }, SURFACE_LABEL[s]))),
        h('p', { class: 'track-desc' }, spec.description ?? ''),
        best,
      );
      cards.set(spec.id, card);
      trackGrid.appendChild(card);
      requestAnimationFrame(() => drawMinimap(canvas, track, 250, 150));
    }
  };
  renderTrackCards();

  // ---------------------------------------------------------------- mods (desktop shell only)
  const bridge = desktop();
  const modsList = h('ul', { class: 'mods-list small' });
  const renderMods = (): void => {
    clear(modsList);
    if (session.userTracks.length === 0) modsList.appendChild(h('li', { class: 'muted' }, 'No track files yet. Drop a *.json track (docs/TRACK_FORMAT.md) in the folder and reload.'));
    for (const t of session.userTracks) {
      modsList.appendChild(
        t.spec
          ? h('li', null, h('span', { class: 'mono' }, t.file), ` → ${t.spec.name}`)
          : h('li', { class: 'mod-error' }, h('span', { class: 'mono' }, t.file), ` — ${t.error}`),
      );
    }
  };
  const modsPanel = bridge
    ? h(
        'div',
        { class: 'mods' },
        h('div', { class: 'panel-title' }, 'Track mods', h('span', { class: 'small muted mono' }, session.userTracksDir)),
        modsList,
        h(
          'div',
          { class: 'mods-buttons' },
          h('button', { class: 'btn btn-small', type: 'button', onclick: () => bridge.tracks.openFolder() }, 'Open tracks folder'),
          h(
            'button',
            { class: 'btn btn-small', type: 'button', dataset: { action: 'reload-tracks' }, onclick: () => {
              const n = session.reloadUserTracks();
              renderTrackCards();
              renderMods();
              if (!session.hasTrack(setup.trackId)) setup.trackId = session.trackSpec(setup.trackId).id;
              selectTrack(setup.trackId);
              toast(`${n} user track${n === 1 ? '' : 's'} loaded`, { kind: 'ok' });
            } },
            'Reload tracks',
          ),
        ),
      )
    : null;
  if (bridge) renderMods();

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
  const gridNote = h('div', { class: 'field-hint', dataset: { role: 'grid-note' } });
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
    const n = setup.opponents.length;
    oppCountLabel.textContent = String(n);
    if (oppCount.value !== String(n)) oppCount.value = String(n);
    gridNote.textContent = n === 0 ? 'Solo run: just you and the clock.' : `${n + 1} cars on the grid (you start from the back, slot ${n + 1}).`;
  };
  /** Fill the line-up to n cars: the default spread first (skipping cars already in), then cycle the presets. */
  const fillOpponents = (n: number): void => {
    while (setup.opponents.length > n) setup.opponents.pop();
    const defaults = session.defaultOpponents();
    let k = 0;
    while (setup.opponents.length < n) {
      const fromDefaults = defaults.find((id) => !setup.opponents.includes(id));
      const presets = session.presets;
      setup.opponents.push(fromDefaults ?? presets[k++ % presets.length].id);
    }
  };
  oppCount.addEventListener('input', () => {
    fillOpponents(Math.max(0, Math.min(MAX_OPPONENTS, Math.round(Number(oppCount.value)) || 0)));
    renderOpponents();
    save();
  });
  const defaultLineup = h(
    'button',
    { class: 'btn btn-small', type: 'button', dataset: { action: 'default-lineup' }, title: 'Club Hatch · Kei Racer · Muscle · Gravel Rally · Track Weapon', onclick: () => {
      setup.opponents = session.defaultOpponents();
      renderOpponents();
      save();
    } },
    'Default line-up',
  );
  renderOpponents();

  const skill = h('input', { type: 'range', min: 0.3, max: 1, step: 0.05, value: setup.aiSkill, 'aria-label': 'AI skill' });
  const skillLabel = h('span', { class: 'mono' }, setup.aiSkill.toFixed(2));
  const skillNote = h('div', { class: 'field-hint' });
  const describeSkill = (): void => {
    const s = setup.aiSkill;
    const usage = Math.round((0.8 + 0.17 * s) * 100);
    skillNote.textContent = `${s >= 0.95 ? 'Flat out' : s >= 0.75 ? 'Quick' : s >= 0.5 ? 'Steady' : 'Cautious'}: the AI plans with ~${usage}% of the grip it estimates. Each opponent further down the line-up drives 2.5% more cautiously than the one before.`;
  };
  skill.addEventListener('input', () => {
    setup.aiSkill = Math.max(0.3, Math.min(1, Number(skill.value) || 0.8));
    skillLabel.textContent = setup.aiSkill.toFixed(2);
    describeSkill();
    save();
  });
  describeSkill();

  const preheat = h('input', { type: 'checkbox', checked: setup.preheatTyres, 'aria-label': 'Warm tyres at start', dataset: { role: 'preheat' } });
  preheat.addEventListener('change', () => {
    setup.preheatTyres = preheat.checked;
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
      preheatTyres: setup.preheatTyres,
    };
    save();
    nav(ROUTES.run);
  };

  const el = h(
    'div',
    { class: 'screen setup' },
    h('section', { class: 'setup-tracks' }, h('div', { class: 'panel-title' }, 'Track'), trackGrid, modsPanel),
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
        gridNote,
        oppList,
        defaultLineup,
      ),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'field-head' }, h('label', null, 'AI skill'), skillLabel),
        skill,
        skillNote,
      ),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'check' }, preheat, 'Warm tyres at start'),
        h('div', { class: 'field-hint' }, 'Tyres and brakes start at working temperature (a formation-lap stand-in). Off: everything starts at ambient — cold slicks are treacherous on lap 1.'),
      ),
      h('button', { class: 'btn btn-primary btn-big', dataset: { action: 'start-race' }, onclick: start }, 'Start race'),
      h('p', { class: 'small muted' }, 'Keyboard: ↑/W throttle · ↓/S brake · ←→/A D steer · Space handbrake · E/Q shift · C camera · R reset · T telemetry · Esc pause. Gamepad: left stick steers, triggers drive, bumpers shift, Y camera.'),
    ),
  );
  root.appendChild(el);
  selectTrack(setup.trackId);
  return { unmount: () => el.remove() };
}
