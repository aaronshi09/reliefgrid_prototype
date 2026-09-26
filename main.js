/* ============================================================================
 * ReliefGrid — application bootstrap, shell/nav routing.
 * ----------------------------------------------------------------------------
 * ReliefGrid is a two-sided product on one shared map + dataset:
 *   - the "seeker" shell (js/seeker.js) — a simple, mobile-first experience
 *     for people looking for help right now ("Find Resources")
 *   - the "gov" shell (js/gov.js) — a denser dashboard for providers,
 *     governments, and Continuums of Care ("Analyze Service Gaps")
 * The AI layer (js/ai/) sits on top of both: the Resource Navigator drives the
 * seeker shell, the analyst drives the "Ask ReliefGrid" page. Neither replaces
 * ReliefGrid's data — see docs/AI_ARCHITECTURE.md.
 * This file owns the landing page, the top navigation, and the router that
 * switches between the two shells. All map/data/availability plumbing lives
 * in js/shared.js so neither shell has to duplicate it.
 * ==========================================================================*/
import { AppState, Availability, loadAll, initMap, initMapLayers, enrichFacilitiesWithAvailability, pushFacilitiesToMap } from './js/shared.js';
import { initGov, navigateGov, openGovDetail, GOV_PAGES, GOV_MAP_PAGES } from './js/gov.js';
import { initSeeker, navigateSeeker, onSeekerMarkerClick, SEEKER_PAGES, SEEKER_MAP_PAGES, getSavedCount } from './js/seeker.js';
import { loadAIStatus } from './js/ai/client.js';
import { initNavigator } from './js/ai/navigator.js';
import { initAnalyst } from './js/ai/analyst.js';

const NAV_CONFIGS = {
  seeker: [
    { id: 'seeker-home', label: 'Find Help' },
    { id: 'seeker-saved', label: 'Saved' },
    { id: 'seeker-about', label: 'About' },
  ],
  gov: [
    { id: 'gov-overview', label: 'Overview' },
    { id: 'gov-ask', label: 'Ask ReliefGrid', ai: true },
    { id: 'gov-network', label: 'Resource Network' },
    { id: 'gov-gaps', label: 'Service Gaps' },
    { id: 'gov-capacity', label: 'Capacity' },
    { id: 'gov-provider', label: 'Provider Updates' },
    { id: 'gov-methods', label: 'Data & Methods', secondary: true },
  ],
};

let currentPage = 'landing';
let appReady = false;

function navigateApp(page) {
  // Until the map + data are ready only the landing page can be shown.
  if (!appReady && page !== 'landing') return;
  currentPage = page;
  const isSeeker = SEEKER_PAGES.has(page);
  const isGov = GOV_PAGES.has(page);
  AppState.shell = isSeeker ? 'seeker' : isGov ? 'gov' : 'landing';
  document.body.dataset.shell = AppState.shell;
  document.body.dataset.page = page;
  renderNav();

  const isMapPage = SEEKER_MAP_PAGES.has(page) || GOV_MAP_PAGES.has(page);
  document.body.classList.toggle('is-map-page', isMapPage);
  document.getElementById('app').classList.toggle('app-seeker-results', page === 'seeker-results');
  document.getElementById('content-pages').classList.toggle('hidden', isMapPage);
  const side = document.getElementById('side-panel');
  side.classList.toggle('hidden', !isMapPage);
  side.classList.remove('sheet-collapsed');
  syncSheetToggle();

  if (isSeeker) { navigateSeeker(page); }
  else if (isGov) { navigateGov(page); }
  else {
    document.querySelectorAll('.content-page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-landing')?.classList.add('active');
  }
  document.getElementById('content-pages').scrollTop = 0;
  window.scrollTo(0, 0);
  document.dispatchEvent(new CustomEvent('rg:navigate', { detail: { page } }));
}
window.__reliefgrid_navigateShell = (_shell, page) => navigateApp(page);
window.__reliefgrid_navigate = navigateApp;

function renderNav() {
  const tabsEl = document.getElementById('nav-tabs');
  if (!tabsEl) return;
  const config = NAV_CONFIGS[AppState.shell];
  if (!config) { tabsEl.innerHTML = ''; }
  else {
    tabsEl.innerHTML = config.map(t => `<button type="button" class="nav-tab ${t.secondary ? 'nav-tab-secondary' : ''} ${t.ai ? 'nav-tab-ai' : ''} ${t.id === currentPage ? 'active' : ''}" data-page="${t.id}" ${t.id === currentPage ? 'aria-current="page"' : ''}>${t.ai ? '<span class="ai-spark" aria-hidden="true"></span>' : ''}${t.label}${t.id === 'seeker-saved' ? savedBadge() : ''}</button>`).join('');
    tabsEl.querySelectorAll('.nav-tab').forEach(btn => btn.addEventListener('click', () => navigateApp(btn.dataset.page)));
  }
  document.querySelectorAll('#nav-mode-switch [data-shell]').forEach(btn => {
    const on = btn.dataset.shell === AppState.shell;
    btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on));
  });
}
function savedBadge() {
  const n = getSavedCount();
  return n ? ` <span class="nav-badge" aria-label="${n} saved">${n}</span>` : '';
}

function wireNav() {
  document.getElementById('nav-brand')?.addEventListener('click', () => navigateApp('landing'));
  document.querySelectorAll('#nav-mode-switch [data-shell]').forEach(btn => btn.addEventListener('click', () => {
    navigateApp(btn.dataset.shell === 'seeker' ? 'seeker-home' : 'gov-overview');
  }));
  document.addEventListener('rg:saved-changed', () => { if (AppState.shell === 'seeker') renderNav(); });
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => navigateApp(b.dataset.goto)));
}

function wireLanding() {
  document.getElementById('landing-find-help')?.addEventListener('click', () => navigateApp('seeker-home'));
  document.getElementById('landing-open-dashboard')?.addEventListener('click', () => navigateApp('gov-overview'));
  document.getElementById('landing-data-methods')?.addEventListener('click', () => navigateApp('gov-methods'));
}

/* Mobile: the floating side panel becomes a bottom sheet that can be tucked
 * down to reveal more of the map. */
function syncSheetToggle() {
  const side = document.getElementById('side-panel');
  const btn = document.getElementById('sheet-toggle');
  if (!btn || !side) return;
  const collapsed = side.classList.contains('sheet-collapsed');
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel to show the map');
}
function wireSheet() {
  document.getElementById('sheet-toggle')?.addEventListener('click', () => {
    document.getElementById('side-panel').classList.toggle('sheet-collapsed');
    syncSheetToggle();
    setTimeout(() => AppState.map?.resize(), 320);
  });
}

function wireGovDetailBridge() {
  document.addEventListener('rg:facility-click', (e) => {
    const id = e.detail?.facilityId; if (!id) return;
    if (AppState.shell === 'gov') openGovDetail(id);
    else if (AppState.shell === 'seeker') onSeekerMarkerClick(id);
  });
}

function renderHomeStats() {
  const total = AppState.facilitiesData?.features?.length || 0;
  const recs = Availability.all().length;
  const tracts = AppState.tractsData.drive?.features?.length || 0;
  const el = document.getElementById('landing-stat-line');
  if (el) el.innerHTML = `<span><strong>${total.toLocaleString()}</strong> Long Island resources mapped</span><span><strong>${tracts.toLocaleString()}</strong> census tracts analyzed</span><span><strong>${recs}</strong> sharing availability <em>(demo)</em></span>`;
}

function showFatalLoadError() {
  const landing = document.getElementById('page-landing');
  const box = document.getElementById('load-error');
  if (box) box.classList.remove('hidden');
  landing?.classList.add('active');
  document.body.classList.remove('is-loading');
}

/* ── Bootstrap ─────────────────────────────────────────────────────────── */
(async () => {
  wireNav();
  wireSheet();
  wireLanding();
  loadAIStatus(); // non-blocking; AI surfaces render their own setup state

  try {
    initMap();
    const dataReady = loadAll();
    const mapReady = new Promise(res => { if (AppState.map.loaded()) res(); else AppState.map.once('load', res); });
    await Promise.all([dataReady, mapReady]);
  } catch (e) {
    console.error('[reliefgrid] failed to load map or data', e);
    showFatalLoadError();
    return;
  }

  Availability.registerResources(AppState.facilitiesData);
  try { await Availability.refresh(); } catch (e) { console.warn('[availability] initial refresh failed', e); }
  enrichFacilitiesWithAvailability();

  await initMapLayers();

  Availability.subscribe(() => { enrichFacilitiesWithAvailability(); pushFacilitiesToMap(); renderHomeStats(); });

  initGov();
  initSeeker();
  initNavigator();
  initAnalyst();
  wireGovDetailBridge();
  renderHomeStats();
  document.body.classList.remove('is-loading');
  appReady = true;
  // Opt-in read-only handle for automated UI checks (append ?debug to the URL).
  if (new URLSearchParams(location.search).has('debug')) window.__reliefgrid_debug = { AppState };
  navigateApp('landing');
})();
