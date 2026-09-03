/** Landing page (#/ and unknown routes). */
import { h } from './dom';
import { ROUTES, type Nav, type Screen } from './screen';
import type { Session } from './state';

export function mountLanding(root: HTMLElement, session: Session, nav: Nav): Screen {
  const quick = (): void => {
    session.pending = session.quickRace();
    nav(ROUTES.run);
  };
  const el = h(
    'div',
    { class: 'screen landing' },
    h(
      'div',
      { class: 'hero' },
      h('h1', { class: 'title' }, 'RACERS'),
      h('p', { class: 'tagline' }, 'Design a car from real physical parameters. Then find out what it actually does.'),
      h(
        'div',
        { class: 'hero-buttons' },
        h('button', { class: 'btn btn-primary btn-big', dataset: { action: 'garage' }, onclick: () => nav(ROUTES.garage) }, 'Garage'),
        h('button', { class: 'btn btn-big', dataset: { action: 'quick-race' }, onclick: quick }, 'Quick race'),
        h('button', { class: 'btn btn-big btn-ghost', onclick: () => nav(ROUTES.setup) }, 'Race setup'),
      ),
      h(
        'p',
        { class: 'how' },
        h('b', null, 'How it works. '),
        'There are no fake stats. Every slider in the garage — tyre pressure, disc diameter, spring rate, ',
        'wing angle, where the engine sits — is a term in the physics: brakes are torque against grip and fade ',
        'when the discs get hot, tyres have an optimal load and a temperature window, a locked differential pushes ',
        'on entry. The analysis panel tells you in plain words what your car will do ("rear locks first — this car ',
        'spins under braking"), and if you get lost, ',
        h('b', null, 'Auto-tune'),
        ' sets the bias, gearing, pressures, camber, aero and balance to sane values for the car you built.',
      ),
      h(
        'p',
        { class: 'keys small muted' },
        'Quick race: your car vs five presets, 3 laps of Clubsprint. ',
        'Drive with ↑/↓ (or W/S), steer ←/→ (or A/D), Space handbrake, E/Q shift, R reset, T telemetry, Esc pause.',
      ),
    ),
  );
  root.appendChild(el);
  return { unmount: () => el.remove() };
}
