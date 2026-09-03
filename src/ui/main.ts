/**
 * RACERS UI entry: a tiny hash router over four screens.
 *   #/            landing
 *   #/garage      car designer with live analysis
 *   #/race        race setup (track / car / opponents)
 *   #/race/run    the race itself (canvas + HUD)
 */
import './style.css';
import { debugHook as garageDebug, mountGarage } from './garage';
import { h } from './dom';
import { mountLanding } from './landing';
import { mountRaceSetup } from './raceSetup';
import { mountRaceView, raceDebug } from './raceView';
import { ROUTES, type Nav, type Screen } from './screen';
import { Session } from './state';

const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

const session = new Session();
const nav: Nav = (hash) => {
  if (window.location.hash === hash) route();
  else window.location.hash = hash;
};

// Top bar (hidden on the race screen).
const navLinks: Array<[string, string]> = [
  [ROUTES.landing, 'RACERS'],
  [ROUTES.garage, 'Garage'],
  [ROUTES.setup, 'Race'],
];
const topbar = h(
  'nav',
  { class: 'topbar' },
  navLinks.map(([href, label], i) => h('a', { class: i === 0 ? 'brand' : 'navlink', href, dataset: { route: href } }, label)),
  h('span', { class: 'spacer' }),
  h('span', { class: 'small muted' }, 'physics-first racing · keyboard only is fine'),
);
const screenHost = h('main', { class: 'screen-host' });
app.append(topbar, screenHost);

let current: Screen | null = null;
let currentRoute = '';

function route(): void {
  const hash = window.location.hash || ROUTES.landing;
  const path = hash.replace(/\/+$/, '') || ROUTES.landing;
  if (current) {
    current.unmount();
    current = null;
  }
  currentRoute = path;
  document.body.classList.toggle('in-race', path === ROUTES.run);
  for (const a of topbar.querySelectorAll<HTMLAnchorElement>('a')) {
    a.classList.toggle('active', a.dataset.route === path);
  }
  try {
    switch (path) {
      case ROUTES.garage:
        current = mountGarage(screenHost, session, nav);
        break;
      case ROUTES.setup:
        current = mountRaceSetup(screenHost, session, nav);
        break;
      case ROUTES.run:
        current = mountRaceView(screenHost, session, nav);
        break;
      default:
        current = mountLanding(screenHost, session, nav);
    }
  } catch (err) {
    // A screen that fails to mount must never leave a blank page.
    console.error(err);
    screenHost.appendChild(
      h(
        'div',
        { class: 'screen error-panel' },
        h('h2', null, 'Something went wrong'),
        h('pre', { class: 'mono small' }, String((err as Error)?.stack ?? err)),
        h('button', { class: 'btn btn-primary', onclick: () => nav(ROUTES.landing) }, 'Back to start'),
      ),
    );
    current = { unmount: () => screenHost.replaceChildren() };
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();

// Debug / e2e hook — read-only view of the live state.
declare global {
  interface Window {
    __racers?: {
      route: () => string;
      session: Session;
      garage: typeof garageDebug;
      race: typeof raceDebug;
    };
  }
}
window.__racers = {
  route: () => currentRoute,
  session,
  garage: garageDebug,
  race: raceDebug,
};
