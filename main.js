/* ============================================================================
 * ReliefGrid — application bootstrap, shell/nav routing.
 * ----------------------------------------------------------------------------
 * ReliefGrid is a two-sided product on one shared map + dataset:
 *   - the "seeker" shell (js/seeker.js) — a simple, mobile-first experience
 *     for people looking for help right now
 *   - the "gov" shell (js/gov.js) — a denser dashboard for providers,
 *     governments, and Continuums of Care
 * This file owns the landing page, the top navigation, and the router that
 * switches between the two shells. All map/data/availability plumbing lives
 * in js/shared.js so neither shell has to duplicate it.
 * ==========================================================================*/
import { AppState, Availability, loadAll, initMap, initMapLayers, enrichFacilitiesWithAvailability, pushFacilitiesToMap } from './js/shared.js';
import { initGov, navigateGov, openGovDetail, GOV_PAGES, GOV_MAP_PAGES, GOV_CONTENT_PAGES } from './js/gov.js';
import { initSeeker, navigateSeeker, openSeekerDetail, SEEKER_PAGES, SEEKER_MAP_PAGES, getSavedCount } from './js/seeker.js';

const NAV_CONFIGS = {
  seeker: [
    { id: 'seeker-home', label: 'Find Help' },
    { id: 'seeker-saved', label: 'Saved' },
    { id: 'seeker-about', label: 'About' },
  ],
  gov: [
    { id: 'gov-overview', label: 'Overview' },
    { id: 'gov-network', label: 'Resource Network' },
    { id: 'gov-gaps', label: 'Service Gaps' },
    { id: 'gov-capacity', label: 'Capacity' },
    { id: 'gov-provider', label: 'Provider Updates' },
    { id: 'gov-methods', label: 'Data & Methods', secondary: true },
  ],
};

let currentPage = 'landing';

function navigateApp(page) {
  currentPage = page;
  const isSeeker = SEEKER_PAGES.has(page);
  const isGov = GOV_PAGES.has(page);
  AppState.shell = isSeeker ? 'seeker' : isGov ? 'gov' : 'landing';
  document.body.dataset.shell = AppState.shell;
  renderNav();

  const isMapPage = SEEKER_MAP_PAGES.has(page) || GOV_MAP_PAGES.has(page);
  document.getElementById('content-pages').classList.toggle('hidden', isMapPage);
  document.getElementById('side-panel').classList.toggle('hidden', !isMapPage);

  if (isSeeker) { navigateSeeker(page); }
  else if (isGov) { navigateGov(page); }
  else {
    document.querySelectorAll('.content-page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-landing')?.classList.add('active');
  }
  window.scrollTo(0, 0);
}
window.__reliefgrid_navigateShell = (_shell, page) => navigateApp(page);
window.__reliefgrid_navigate = navigateApp;

function renderNav() {
  const tabsEl = document.getElementById('nav-tabs');
  const switchEl = document.getElementById('nav-shell-switch');
  if (!tabsEl) return;
  const config = NAV_CONFIGS[AppState.shell];
  if (!config) { tabsEl.innerHTML = ''; }
  else {
    tabsEl.innerHTML = config.map(t => `<button class="nav-tab ${t.secondary ? 'nav-tab-secondary' : ''} ${t.id === currentPage ? 'active' : ''}" data-page="${t.id}">${t.label}${t.id === 'seeker-saved' ? savedBadge() : ''}</button>`).join('');
    tabsEl.querySelectorAll('.nav-tab').forEach(btn => btn.addEventListener('click', () => navigateApp(btn.dataset.page)));
  }
  if (switchEl) {
    if (AppState.shell === 'seeker') { switchEl.innerHTML = `<button class="nav-switch-link" data-page="gov-overview">For Providers &amp; Governments &rarr;</button>`; switchEl.classList.remove('hidden'); }
    else if (AppState.shell === 'gov') { switchEl.innerHTML = `<button class="nav-switch-link" data-page="seeker-home">&larr; Find Help</button>`; switchEl.classList.remove('hidden'); }
    else { switchEl.innerHTML = ''; switchEl.classList.add('hidden'); }
    switchEl.querySelectorAll('[data-page]').forEach(btn => btn.addEventListener('click', () => navigateApp(btn.dataset.page)));
  }
}
function savedBadge() {
  const n = getSavedCount();
  return n ? ` <span class="nav-badge">${n}</span>` : '';
}

function wireLanding() {
  document.getElementById('landing-find-help')?.addEventListener('click', () => navigateApp('seeker-home'));
  document.getElementById('landing-open-dashboard')?.addEventListener('click', () => navigateApp('gov-overview'));
  document.getElementById('landing-data-methods')?.addEventListener('click', () => navigateApp('gov-methods'));
  document.getElementById('nav-brand')?.addEventListener('click', () => navigateApp('landing'));
}

function wireGovDetailBridge() {
  document.addEventListener('rg:facility-click', (e) => {
    const id = e.detail?.facilityId; if (!id) return;
    if (AppState.shell === 'gov') openGovDetail(id);
    else if (AppState.shell === 'seeker') openSeekerDetail(id);
  });
}

function renderHomeStats() {
  const total = AppState.facilitiesData?.features?.length || 0;
  const recs = Availability.all().length;
  const el = document.getElementById('landing-stat-line');
  if (el) el.textContent = `${total.toLocaleString()} Long Island resources mapped · ${recs} sharing live availability (demo)`;
}

/* ── Bootstrap ─────────────────────────────────────────────────────────── */
(async () => {
  initMap();
  const dataReady = loadAll();
  const mapReady = new Promise(res => { if (AppState.map.loaded()) res(); else AppState.map.once('load', res); });
  await Promise.all([dataReady, mapReady]);

  Availability.registerResources(AppState.facilitiesData);
  try { await Availability.refresh(); } catch (e) { console.warn('[availability] initial refresh failed', e); }
  enrichFacilitiesWithAvailability();

  await initMapLayers();

  Availability.subscribe(() => { enrichFacilitiesWithAvailability(); pushFacilitiesToMap(); renderHomeStats(); });

  initGov();
  initSeeker();
  wireLanding();
  wireGovDetailBridge();
  renderHomeStats();
  navigateApp('landing');
})();
