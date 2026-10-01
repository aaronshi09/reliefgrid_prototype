/* ============================================================================
 * ReliefGrid — "Find Help" seeker (consumer) shell.
 * ----------------------------------------------------------------------------
 * Built for someone who may be stressed, on a phone, and unfamiliar with the
 * service system: large targets, short plain-language copy, a list before a
 * map, and an honest degrade when location or travel times are unavailable.
 * Location: bundled Census town/ZIP data, the Census address geocoder, or the
 * browser (only on request). Travel times: openrouteservice via /api/geo, for
 * a small prefiltered set of ReliefGrid candidates. See js/location.js.
 *
 * The AI Resource Navigator (js/ai/navigator.js) drives this shell through the
 * small public API at the bottom of the file (applySeekerPlan etc.). It never
 * produces resources itself: every result shown here comes from
 * computeResults() over longisland_facilities.geojson.
 * ==========================================================================*/
import {
  AppState, Availability, STATUS,
  SEEKER_CATEGORIES, RESOURCE_LABELS,
  findFacilityFeature, availabilityHeadline, openLabel, statusChipHTML, demoPillHTML,
  escapeHtml, cleanUrl, directionsUrl, haversineKm, kmToMiles, setUserLocationMarker,
  resourceLegendIcon, setFacilityHover, setSelectedFacility, fitPadding, motion,
  LONG_ISLAND_CENTER, LONG_ISLAND_ZOOM, setFacilitiesLayout, fitLongIsland, setUserLocationVisible, flyToPoint,
  setTractHighlight, setSelectedTract, setRouteLine,
} from './shared.js';
import { resolveLocationText, fetchTravelTimes, fetchRoute, formatDuration, metersToMiles, roundCoords } from './location.js';
import { getAIStatus } from './ai/client.js';

export const SEEKER_MAP_PAGES = new Set(['seeker-results']);
export const SEEKER_CONTENT_PAGES = new Set(['seeker-home', 'seeker-detail', 'seeker-guided', 'seeker-saved', 'seeker-about']);
export const SEEKER_PAGES = new Set([...SEEKER_MAP_PAGES, ...SEEKER_CONTENT_PAGES]);

const $ = (id) => document.getElementById(id);
const SAVED_KEY = 'reliefgrid.saved.v1';
const RANK = { available: 0, limited: 1, unknown: 2, closed: 3, full: 4 };
const DEFAULT_RADIUS_KM = 24;

let seekerPage = 'seeker-home';
const state = {
  categories: null,      // array of SEEKER_CATEGORIES ids, or null = all
  userCoords: null,
  locationLabel: '',
  quickFilters: new Set(), // open_now | available_now | walk_ins | near_me
  radiusKm: DEFAULT_RADIUS_KM,
  detailId: null,
  resultsHeading: 'Nearby resources',
  source: 'browse',      // 'browse' | 'guided' | 'ai' — how the current query was built
  locationPrecision: null, // 'device' | 'zip' | 'place' | 'address'
  // Real walk/drive travel times to ReliefGrid facilities (openrouteservice),
  // held in memory for the current origin + mode only — never persisted.
  travel: { mode: null, maxMinutes: null, maxMiles: null, times: new Map(), key: '', status: 'idle', error: null, relaxed: false, inflight: false },
};
// Travel-time pipeline limits: category filter → straight-line prefilter →
// at most MAX_ROUTED candidates per request → ranking.
const MAX_ROUTED = 25;
const PREFILTER_KM = { walk: 8, drive: 60 };
const MODE_WORD = { walk: 'walk', drive: 'drive' };
const guided = { step: 0, need: null, tonight: null, walkins: null, travel: null };
let savedIds = loadSaved();
const resultsListeners = new Set();

function loadSaved() { try { return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]')); } catch { return new Set(); } }
function persistSaved() { try { localStorage.setItem(SAVED_KEY, JSON.stringify([...savedIds])); } catch {} }

/* ── Bootstrap / navigation ──────────────────────────────────────────────── */
export function initSeeker() {
  renderCategoryGrid();
  wireHomeControls();
  wireGuidedControls();
  $('seeker-detail-close')?.addEventListener('click', () => window.__reliefgrid_navigate('seeker-results'));
  $('seeker-results-view-list')?.addEventListener('click', () => setResultsMobileView('list'));
  $('seeker-results-view-map')?.addEventListener('click', () => setResultsMobileView('map'));
  $('seeker-new-search')?.addEventListener('click', () => { window.__reliefgrid_navigate('seeker-home'); setTimeout(() => $('navigator-input')?.focus(), 60); });
  Availability.subscribe(onSeekerAvailabilityChanged);
}

export function navigateSeeker(page) {
  seekerPage = page;
  document.querySelectorAll('#side-panel > .side-panel-page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.content-page').forEach(p => p.classList.remove('active'));
  document.getElementById('app').classList.toggle('app-seeker-results', page === 'seeker-results');
  setUserLocationVisible(true);
  // Research-layer selections / AI highlights belong to the dashboard.
  setTractHighlight([]); setSelectedTract(null);

  if (SEEKER_MAP_PAGES.has(page)) {
    $(`panel-${page}`)?.classList.remove('hidden');
    // Phones always land on the list first; the map is one tap away.
    previewId = null;
    setResultsMobileView('list');
    AppState.map?.easeTo({ pitch: 0, duration: motion(300) });
    renderResults();
    setTimeout(() => AppState.map?.resize(), 50);
  } else {
    $(`page-${page}`)?.classList.add('active');
    if (page === 'seeker-saved') renderSaved();
    if (page === 'seeker-guided') renderGuidedStep();
  }
}

/* ── Home: category grid + location + quick filters ─────────────────────── */
function renderCategoryGrid() {
  const el = $('seeker-category-grid'); if (!el) return;
  el.innerHTML = SEEKER_CATEGORIES.map(c => `
    <button type="button" class="seeker-cat-card" data-cat="${c.id}">
      ${resourceLegendIcon(c.groups[0], null, 34)}
      <span>${escapeHtml(c.label)}</span>
    </button>`).join('');
  el.querySelectorAll('.seeker-cat-card').forEach(btn => btn.addEventListener('click', () => {
    state.categories = [btn.dataset.cat];
    state.source = 'browse';
    state.resultsHeading = SEEKER_CATEGORIES.find(c => c.id === btn.dataset.cat)?.label || 'Resources';
    window.__reliefgrid_navigate('seeker-results');
  }));
}
function wireHomeControls() {
  $('seeker-use-location')?.addEventListener('click', useMyLocation);
  $('seeker-location-form')?.addEventListener('submit', (e) => { e.preventDefault(); submitLocationText($('seeker-location-input').value); });
  document.querySelectorAll('#seeker-quick-filters button[data-filter]').forEach(btn => btn.addEventListener('click', () => {
    const key = btn.dataset.filter;
    if (key === 'near_me' && !state.userCoords) { showLocationNote('Add your location above first so ReliefGrid can find what’s near you.'); return; }
    if (state.quickFilters.has(key)) state.quickFilters.delete(key); else state.quickFilters.add(key);
    syncQuickFilterButtons();
  }));
  $('seeker-browse-all')?.addEventListener('click', () => { state.categories = null; state.source = 'browse'; state.resultsHeading = 'All resources'; window.__reliefgrid_navigate('seeker-results'); });
  $('seeker-guided-start')?.addEventListener('click', () => { guided.step = 0; guided.need = guided.tonight = guided.walkins = guided.travel = null; window.__reliefgrid_navigate('seeker-guided'); });
}
function syncQuickFilterButtons() {
  document.querySelectorAll('#seeker-quick-filters button[data-filter]').forEach(b => {
    const on = state.quickFilters.has(b.dataset.filter);
    b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on));
  });
}
function showLocationNote(text) { const el = $('seeker-location-note'); if (el) { el.textContent = text; el.classList.remove('hidden'); } }
function updateLocationUI() {
  const el = $('seeker-location-input'); if (el) el.value = state.locationLabel || '';
  setUserLocationMarker(state.userCoords);
  const badge = $('seeker-location-badge');
  if (badge) badge.textContent = state.userCoords ? `Using: ${state.locationLabel}` : '';
  document.dispatchEvent(new CustomEvent('rg:location-changed', { detail: { label: state.userCoords ? state.locationLabel : null } }));
}
/**
 * Browser location — only ever called from an explicit user action ("Use my
 * location"). The position is rounded to ~100 m, kept in memory only, and is
 * never sent to the AI. Resolves to { ok, message }.
 */
export function useMyLocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      const message = 'Location access isn’t available in this browser. Type a town, ZIP code or address instead.';
      showLocationNote(message); return resolve({ ok: false, message });
    }
    showLocationNote('Waiting for your browser’s permission… Your location is only used to sort nearby services on this page. It isn’t saved or shared with the AI.');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setSeekerLocation(roundCoords([pos.coords.longitude, pos.coords.latitude]), 'Your current location', 'device');
        const message = 'Using your approximate current location.';
        showLocationNote(message); rerenderIfResults(); resolve({ ok: true, message });
      },
      (err) => {
        const message = err && err.code === 1
          ? 'Location permission was declined — that’s fine. Type a town, ZIP code or address instead.'
          : 'ReliefGrid couldn’t get your location. Type a town, ZIP code or address instead.';
        showLocationNote(message); resolve({ ok: false, message });
      },
      { timeout: 10000, maximumAge: 300000, enableHighAccuracy: false },
    );
  });
}
/** Typed location (town, ZIP, address or landmark). Resolves to { ok, message, label }. */
export async function submitLocationText(text) {
  const t = (text || '').trim();
  if (!t) { const message = 'Enter a Long Island town, ZIP code or address — or use “Use my location.”'; showLocationNote(message); return { ok: false, message }; }
  showLocationNote('Looking up that location…');
  const r = await resolveLocationText(t);
  if (r.ok) {
    setSeekerLocation(r.coords, r.label, r.precision);
    const message = `Searching near ${r.label}.`;
    showLocationNote(message); rerenderIfResults();
    return { ok: true, message, label: r.label };
  }
  showLocationNote(r.message);
  return { ok: false, message: r.message };
}
function rerenderIfResults() { if (seekerPage === 'seeker-results') renderResults(); }

/* ── Results (map page: list + map, mobile list/map toggle) ─────────────── */
function activeGroups() {
  if (!state.categories || !state.categories.length) return null;
  const groups = new Set();
  state.categories.forEach(id => SEEKER_CATEGORIES.find(c => c.id === id)?.groups.forEach(g => groups.add(g)));
  return groups;
}
/** ReliefGrid's own matching: category + availability quick filters (no distance). */
function baseCandidates() {
  const groups = activeGroups();
  let list = (AppState.facilitiesData?.features || [])
    .filter(f => !groups || groups.has(f.properties.resource_group))
    .map(f => {
      const rec = Availability.get(f.properties.facility_id);
      const d = state.userCoords ? haversineKm(state.userCoords[0], state.userCoords[1], f.geometry.coordinates[0], f.geometry.coordinates[1]) : null;
      return { f, rec, d, t: null };
    });
  if (state.quickFilters.has('open_now')) list = list.filter(x => x.rec && x.rec.raw.open_now !== false && x.rec.status !== 'closed');
  if (state.quickFilters.has('available_now')) list = list.filter(x => x.rec && x.rec.status === 'available');
  if (state.quickFilters.has('walk_ins')) list = list.filter(x => x.rec && x.rec.raw.walk_ins === true);
  return list;
}
const travelReady = () => !!(state.travel.mode && state.userCoords && state.travel.status === 'ready' && state.travel.times.size);
function withinTravelLimits(t) {
  if (state.travel.maxMinutes && !(t.durationSec <= state.travel.maxMinutes * 60)) return false;
  if (state.travel.maxMiles && !(t.distanceM != null && metersToMiles(t.distanceM) <= state.travel.maxMiles)) return false;
  return true;
}
function computeResults() {
  let list = baseCandidates();
  const travelOn = travelReady();
  if (state.quickFilters.has('near_me') && state.userCoords && !travelOn) list = list.filter(x => x.d != null && x.d <= state.radiusKm);
  state.travel.relaxed = false;
  if (travelOn) {
    list.forEach(x => { x.t = state.travel.times.get(x.f.properties.facility_id) || null; });
    if (state.travel.maxMinutes || state.travel.maxMiles) {
      const routed = list.filter(x => x.t && x.t.durationSec != null);
      const within = routed.filter(x => withinTravelLimits(x.t));
      // Never strand someone: if nothing is within the limit, keep every match —
      // routed ones first by travel time, the rest by distance — and say so.
      if (within.length) list = within; else state.travel.relaxed = true;
    }
  }
  list.sort((a, b) => {
    if (travelOn) {
      const ta = a.t?.durationSec, tb = b.t?.durationSec;
      if (ta != null && tb != null && ta !== tb) return ta - tb;
      if ((ta != null) !== (tb != null)) return ta != null ? -1 : 1;
    }
    if (state.userCoords && a.d != null && b.d != null && Math.abs(a.d - b.d) > 0.05) return a.d - b.d;
    const ra = a.rec ? RANK[a.rec.status] : 2, rb = b.rec ? RANK[b.rec.status] : 2;
    if (ra !== rb) return ra - rb;
    return (a.f.properties.name || '').localeCompare(b.f.properties.name || '');
  });
  return list;
}

/* ── Travel times (only on explicit need: a location + a chosen travel mode) ── */
function travelKey() { return state.travel.mode && state.userCoords ? `${state.travel.mode}|${roundCoords(state.userCoords).join(',')}` : ''; }
function resetTravelTimes() { Object.assign(state.travel, { times: new Map(), key: '', status: 'idle', error: null }); setRouteLine(null); }
/** Fetch travel times for the nearest matching candidates not yet routed. At most
 *  one request per origin + mode + candidate set; map moves never trigger it. */
async function ensureTravelTimes() {
  const t = state.travel;
  if (!t.mode || !state.userCoords || !getAIStatus().location?.travelTimes || t.inflight) return;
  const key = travelKey();
  if (t.key !== key) { t.times = new Map(); t.key = key; t.status = 'idle'; t.error = null; }
  if (t.status === 'error') return; // no automatic retry loop; the user can retry
  const candidates = baseCandidates().filter(x => x.d != null && x.d <= PREFILTER_KM[t.mode]).sort((a, b) => a.d - b.d).slice(0, MAX_ROUTED);
  const missing = candidates.map(x => x.f.properties.facility_id).filter(id => !t.times.has(id));
  if (!missing.length) {
    const next = candidates.length ? 'ready' : 'none';
    if (t.status !== next) { t.status = next; renderResults(); } // re-render only on a real change
    return;
  }
  t.inflight = true; t.status = 'loading'; renderTravelBar();
  try {
    const times = await fetchTravelTimes(state.userCoords, t.mode, missing);
    if (travelKey() !== key) return;
    missing.forEach(id => t.times.set(id, times.get(id) || { facilityId: id, durationSec: null, distanceM: null }));
    t.status = 'ready';
  } catch (e) {
    if (travelKey() !== key) return;
    t.status = 'error';
    t.error = e?.code === 'rate_limited' ? 'Travel times are busy right now.' : 'Travel times are unavailable right now.';
  } finally { t.inflight = false; }
  if (seekerPage === 'seeker-results') renderResults();
}
function renderTravelBar() {
  const el = $('seeker-travel-bar'); if (!el) return;
  const loc = getAIStatus().location || {};
  // Without routing on this deployment the bar has nothing to choose; cards already say "straight line".
  if (!state.userCoords || !loc.travelTimes) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const t = state.travel;
  const btn = (mode, label) => `<button type="button" data-travel-mode="${mode}" aria-pressed="${t.mode === mode || (!t.mode && mode === 'none')}" class="${t.mode === mode || (!t.mode && mode === 'none') ? 'active' : ''}">${label}</button>`;
  const limit = t.maxMinutes ? `within ${t.maxMinutes} min` : t.maxMiles ? `within ${t.maxMiles} mi` : '';
  let statusLine = '';
  if (!loc.travelTimes) statusLine = 'Distances are straight-line estimates (travel times aren’t set up on this deployment).';
  else if (!t.mode) statusLine = 'Straight-line distances. Choose Walk or Drive for real travel times.';
  else if (t.status === 'loading') statusLine = `Calculating ${t.mode === 'walk' ? 'walking' : 'driving'} times…`;
  else if (t.status === 'error') statusLine = `${t.error} Showing straight-line distances. <button type="button" class="link-btn" data-travel-retry>Try again</button>`;
  else if (t.status === 'none') statusLine = `No matching listings are within ${PREFILTER_KM[t.mode]} km straight-line to calculate ${t.mode === 'walk' ? 'walking' : 'driving'} times.`;
  else if (t.status === 'ready') statusLine = `${t.mode === 'walk' ? 'Walking' : 'Driving'} times to the nearest ${Math.min(MAX_ROUTED, t.times.size)} matches${limit && !t.relaxed ? ` · showing ${limit}` : ''}${t.relaxed ? ` — none are ${limit}, so all matches are shown, nearest first` : ''}. Estimates without live traffic; transit isn’t included.`;
  el.innerHTML = `<div class="travel-row"><span class="travel-label">Travel</span><div class="mode-switch" role="group" aria-label="Travel mode">${btn('none', 'Distance')}${loc.travelTimes ? btn('walk', 'Walk') + btn('drive', 'Drive') : ''}</div>
      ${limit && t.mode ? `<span class="need-chip need-chip-filter">${escapeHtml(limit)}<button type="button" class="chip-x" data-travel-clear-limit aria-label="Remove travel limit">×</button></span>` : ''}</div>
    <div class="travel-status muted small" aria-live="polite">${statusLine}</div>
    ${t.mode && loc.travelTimes ? '<div class="travel-attrib">Travel times &amp; routes: openrouteservice · © OpenStreetMap contributors</div>' : ''}`;
  el.querySelectorAll('[data-travel-mode]').forEach(b => b.addEventListener('click', () => updateSeekerQuery({ travelMode: b.dataset.travelMode === 'none' ? null : b.dataset.travelMode })));
  el.querySelector('[data-travel-clear-limit]')?.addEventListener('click', () => updateSeekerQuery({ clearTravelLimit: true }));
  el.querySelector('[data-travel-retry]')?.addEventListener('click', () => { state.travel.status = 'idle'; ensureTravelTimes(); });
}
async function showRoute(facilityId) {
  const t = state.travel; const feat = findFacilityFeature(facilityId);
  if (!t.mode || !state.userCoords || !feat) return;
  const note = $('seeker-travel-bar')?.querySelector('.travel-status');
  if (note) note.textContent = 'Loading route…';
  try {
    const r = await fetchRoute(state.userCoords, t.mode, facilityId);
    setRouteLine(r.geometry, t.mode);
    setSelectedFacility(facilityId);
    const xs = r.geometry.coordinates.map(c => c[0]), ys = r.geometry.coordinates.map(c => c[1]);
    const frame = () => { try { AppState.map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: fitPadding(), maxZoom: 15, duration: motion(600) }); } catch (_) {} };
    if (isNarrow()) { renderMapPreview(facilityId); setResultsMobileView('map', frame); } else frame();
    if (note) note.textContent = `Route shown: ${formatDuration(r.durationSec) || ''} ${MODE_WORD[t.mode]} · ${r.distanceM != null ? `${metersToMiles(r.distanceM).toFixed(1)} mi` : ''} (openrouteservice · © OpenStreetMap contributors)`;
  } catch (_) {
    if (note) note.textContent = 'The route couldn’t be loaded right now. Use “Get Directions” on the listing instead.';
  }
}
let lastResults = [];
function renderResults() {
  const results = computeResults();
  lastResults = results;
  const heading = $('seeker-results-heading');
  if (heading) heading.textContent = `${results.length} ${results.length === 1 ? 'place' : 'places'} · ${state.resultsHeading}`;
  const sub = $('seeker-results-sub');
  if (sub) sub.innerHTML = state.userCoords
    ? `Near <strong>${escapeHtml(state.locationLabel)}</strong> · closest first`
    : `<button type="button" class="link-btn" id="seeker-results-add-location">Add your location</button> to see what’s closest`;
  $('seeker-results-add-location')?.addEventListener('click', () => { window.__reliefgrid_navigate('seeker-home'); setTimeout(() => $('seeker-location-input')?.focus(), 60); });
  renderTravelBar();
  const listEl = $('seeker-results-list');
  if (listEl) {
    listEl.innerHTML = results.length
      ? results.map(r => resourceCardHTML(r.f, r.rec, r.d, r.t)).join('')
      : `<div class="seeker-empty"><strong>Nothing matches all of these filters.</strong><span>Try removing a filter or choosing a different category.</span><button type="button" class="btn btn-ghost btn-sm" id="seeker-clear-filters">Clear filters</button></div>`;
    wireCardList(listEl, () => renderResults());
    $('seeker-clear-filters')?.addEventListener('click', () => { state.quickFilters.clear(); syncQuickFilterButtons(); renderResults(); });
  }
  renderMapPreview(previewId);
  applyResultsMapFilter(results);
  resultsListeners.forEach(fn => { try { fn(results, getSeekerQuery()); } catch (e) { console.error(e); } });
  ensureTravelTimes();
}
const isNarrow = () => window.matchMedia('(max-width: 760px)').matches;
// On the desktop results page a card click focuses its existing map marker
// (details via the card's button); elsewhere — phones, Saved, similar
// services — it opens the detail page as before.
function cardSelectsMarker() {
  return seekerPage === 'seeker-results' && !isNarrow();
}
/* Phones, map view: the tapped marker's card is shown under the map so Call /
 * Directions / Details are one tap away without switching back to the list. */
let previewId = null;
function renderMapPreview(id) {
  const el = $('seeker-map-preview'); if (!el) return;
  const r = id ? lastResults.find(x => x.f.properties.facility_id === id) : null;
  previewId = r ? id : null;
  document.getElementById('app').classList.toggle('has-map-preview', !!r);
  if (!r) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = resourceCardHTML(r.f, r.rec, r.d, r.t);
  el.hidden = false;
  wireCardList(el, () => renderMapPreview(previewId));
}
function activateCard(id) {
  if (cardSelectsMarker()) selectResultCard(id, { fly: true });
  else openSeekerDetail(id);
}
/** Highlight a result card, select its marker, and optionally fly to it. */
function selectResultCard(id, { fly = false, scroll = false } = {}) {
  document.querySelectorAll('#seeker-results-list .seeker-card').forEach(c => c.classList.toggle('is-selected', c.dataset.id === id));
  const card = document.querySelector(`#seeker-results-list .seeker-card[data-id="${CSS.escape(id)}"]`);
  if (scroll && card) card.scrollIntoView({ block: 'nearest', behavior: motion(1) ? 'smooth' : 'auto' });
  if (fly) focusFacilityOnMap(id); else setSelectedFacility(id);
}
/** Marker clicks in Find Help: on the results page select the matching card
 *  (desktop: highlight + scroll the list; phones: show it under the map);
 *  everywhere else open the detail page (the original behaviour). */
export function onSeekerMarkerClick(id) {
  const inResults = seekerPage === 'seeker-results' && document.querySelector(`#seeker-results-list .seeker-card[data-id="${CSS.escape(id)}"]`);
  if (inResults && isNarrow()) { selectResultCard(id); renderMapPreview(id); }
  else if (inResults) selectResultCard(id, { scroll: true });
  else openSeekerDetail(id);
}
function wireCardList(listEl, onSaveChange) {
  listEl.querySelectorAll('.seeker-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('a, [data-save], [data-locate], [data-details], [data-route]')) return;
      activateCard(card.dataset.id);
    });
    card.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); activateCard(card.dataset.id); }
    });
    card.addEventListener('mouseenter', () => setFacilityHover(card.dataset.id));
    card.addEventListener('mouseleave', () => setFacilityHover(null));
    card.addEventListener('focusin', () => setFacilityHover(card.dataset.id));
    card.addEventListener('focusout', () => setFacilityHover(null));
  });
  listEl.querySelectorAll('[data-save]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); toggleSaved(btn.dataset.save); onSaveChange && onSaveChange(); }));
  listEl.querySelectorAll('[data-locate]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); focusFacilityOnMap(btn.dataset.locate); }));
  listEl.querySelectorAll('[data-route]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); showRoute(btn.dataset.route); }));
  listEl.querySelectorAll('[data-details]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); openSeekerDetail(btn.dataset.details); }));
}
/** Fly to a facility and mark it selected (used by cards and the AI summary). */
export function focusFacilityOnMap(facilityId) {
  const feat = findFacilityFeature(facilityId); const map = AppState.map;
  if (!feat || !map) return;
  const go = () => { setSelectedFacility(facilityId); flyToPoint(feat.geometry.coordinates, 13); };
  if (isNarrow() && seekerPage === 'seeker-results') {
    selectResultCard(facilityId);
    renderMapPreview(facilityId);
    // Fly only once the map is visible and sized, so the re-frame of all
    // results that follows the toggle doesn't undo it.
    if (document.getElementById('app').dataset.mobileView !== 'map') { setResultsMobileView('map', go); return; }
  }
  go();
}
function applyResultsMapFilter(results) {
  const map = AppState.map; if (!map || !map.getLayer('facilities')) return;
  const ids = results.map(r => r.f.properties.facility_id);
  const filter = ids.length ? ['in', ['get', 'facility_id'], ['literal', ids]] : ['==', ['get', 'facility_id'], '__none__'];
  ['facilities', 'facilities-halo', 'facilities-status-bg', 'facilities-status-label'].forEach(id => {
    if (!map.getLayer(id)) return;
    if (id === 'facilities' || id === 'facilities-halo') map.setFilter(id, filter);
    else map.setFilter(id, ['all', ['==', ['get', 'avail_has_data'], true], filter]);
  });
  setFacilitiesLayout('visible');
  map.setPaintProperty('tract-fill', 'fill-opacity', 0);
  map.setLayoutProperty('districts-fill', 'visibility', 'none');
  map.setLayoutProperty('districts-stroke', 'visibility', 'none');
  ['facilities-status-bg', 'facilities-status-label'].forEach(id => map.setLayoutProperty(id, 'visibility', 'visible'));
  const coordsList = results.map(r => r.f.geometry.coordinates);
  if (state.userCoords) coordsList.push(state.userCoords);
  lastResultBounds = null;
  if (coordsList.length) {
    const lngs = coordsList.map(c => c[0]), lats = coordsList.map(c => c[1]);
    lastResultBounds = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
  }
  frameResults(500);
}
let lastResultBounds = null;
function frameResults(duration) {
  const map = AppState.map; if (!map) return;
  // Mobile list view hides the map; the Map toggle re-frames when it is shown.
  if (getComputedStyle(document.getElementById('map-area')).visibility === 'hidden') return;
  if (lastResultBounds) { try { map.fitBounds(lastResultBounds, { padding: fitPadding(), maxZoom: 13, duration: motion(duration) }); } catch (_) {} }
  else fitLongIsland({ duration });
}
/** Phones: switch the results page between the list and the map. `afterShow`
 *  replaces the default "frame every result" once the map is visible. */
function setResultsMobileView(view, afterShow = null) {
  const app = document.getElementById('app');
  const was = app.dataset.mobileView || 'list';
  app.dataset.mobileView = view;
  document.querySelectorAll('#seeker-results-view-toggle button').forEach(b => { b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-pressed', String(b.dataset.view === view)); });
  // The map was hidden behind the list: resize, then re-frame the results.
  // Wait for the sheet's height transition so the padding reflects its final size.
  if (view === 'map') setTimeout(() => { AppState.map?.resize(); (afterShow || (() => frameResults(0)))(); }, motion(340));
  // Back to the list: keep the place picked on the map in view.
  else if (was === 'map' && previewId) selectResultCard(previewId, { scroll: true });
}
function resourceCardHTML(feat, rec, distKm, travel = null) {
  const p = feat.properties;
  const status = rec ? rec.status : 'unknown';
  const isSaved = savedIds.has(p.facility_id);
  // Route travel time (openrouteservice) and straight-line distance are always labelled separately.
  const tMode = state.travel.mode;
  const travelHTML = travel && travel.durationSec != null
    ? `<span class="seeker-travel" title="Estimated ${tMode === 'walk' ? 'walking' : 'driving'} time by route (openrouteservice)">${formatDuration(travel.durationSec)} ${MODE_WORD[tMode]}${travel.distanceM != null ? ` · ${metersToMiles(travel.distanceM).toFixed(1)} mi route` : ''}</span>`
    : travel && travel.durationSec == null ? `<span class="seeker-travel is-none">No ${tMode === 'walk' ? 'walking' : 'driving'} route found</span>` : '';
  const distHTML = distKm != null ? `<span class="seeker-dist" title="Straight-line distance, not a route">${kmToMiles(distKm).toFixed(1)} mi away <small>(straight line)</small></span>` : '';
  const routeBtn = tMode && state.userCoords && getAIStatus().location?.routeLines && travel?.durationSec != null
    ? `<button type="button" class="icon-btn" data-route="${escapeHtml(p.facility_id)}" aria-label="Show ${tMode === 'walk' ? 'walking' : 'driving'} route on the map" title="Show route on the map"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 15.18V7c0-2.21-1.79-4-4-4s-4 1.79-4 4v10c0 1.1-.9 2-2 2s-2-.9-2-2V8.82C8.16 8.4 9 7.3 9 6c0-1.66-1.34-3-3-3S3 4.34 3 6c0 1.3.84 2.4 2 2.82V17c0 2.21 1.79 4 4 4s4-1.79 4-4V7c0-1.1.9-2 2-2s2 .9 2 2v8.18A2.996 2.996 0 0 0 18 21c1.66 0 3-1.34 3-3 0-1.3-.84-2.4-2-2.82z"/></svg></button>` : '';
  const id = escapeHtml(p.facility_id);
  const name = escapeHtml(p.name || 'Unnamed resource');
  // Status only from the availability adapter (demo in this prototype) — labelled as such.
  const open = rec && rec.raw.open_now != null ? openLabel(rec) : '';
  const statusHTML = rec
    ? `<div class="seeker-card-status">${statusChipHTML(status)}<span class="seeker-card-info">${escapeHtml(availabilityHeadline(rec, p.resource_group))}</span></div>
       <div class="seeker-card-demo">${open ? `${escapeHtml(open)} · ` : ''}Demo status, updated ${escapeHtml(rec.relativeTime)}</div>`
    : '';
  return `<article class="seeker-card" data-id="${id}" tabindex="0" aria-label="${name}">
    <div class="seeker-card-top">
      ${resourceLegendIcon(p.resource_group, null, 32)}
      <div class="seeker-card-title"><h3>${name}</h3><div class="seeker-card-type">${escapeHtml(RESOURCE_LABELS[p.resource_group] || '')}${distHTML ? `<br>${distHTML}` : ''}</div></div>
      <div class="seeker-card-tools">
        ${routeBtn}
        <button type="button" class="icon-btn" data-locate="${id}" aria-label="Show ${name} on the map" title="Show on map"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A8.99 8.99 0 0 0 13 3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99 8.99 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/></svg></button>
        <button type="button" class="icon-btn seeker-save-btn ${isSaved ? 'saved' : ''}" data-save="${id}" aria-pressed="${isSaved}" aria-label="${isSaved ? 'Remove from saved' : 'Save this resource'}">${isSaved ? '★' : '☆'}</button>
      </div>
    </div>
    ${travelHTML ? `<div class="seeker-card-travel">${travelHTML}</div>` : ''}
    ${statusHTML}
    ${p.opening_time ? `<div class="seeker-card-line"><span class="seeker-card-line-k">Hours</span>${escapeHtml(p.opening_time)}</div>` : ''}
    <div class="seeker-card-line"><span class="seeker-card-line-k">Address</span>${escapeHtml(p.address || 'Not listed')}</div>
    <div class="seeker-card-actions">${cardActionsHTML(feat, name)}</div>
  </article>`;
}
/** Call (only with a listed phone number), Directions, Details. */
function cardActionsHTML(feat, name) {
  const p = feat.properties;
  const tel = (p.phone || '').replace(/[^\d+]/g, '');
  const call = tel ? `<a class="card-action is-primary" href="tel:${escapeHtml(tel)}" aria-label="Call ${name}">${ICON_PHONE}Call</a>` : '';
  const dir = isConfidentialLocation(p)
    ? `<span class="card-action is-note">Location confidential — contact for referral</span>`
    : `<a class="card-action ${tel ? '' : 'is-primary'}" href="${escapeHtml(seekerDirectionsUrl(feat))}" target="_blank" rel="noopener" aria-label="Directions to ${name} (opens Google Maps)">${ICON_DIRECTIONS}Directions</a>`;
  return `${call}${dir}<button type="button" class="card-action is-quiet" data-details="${escapeHtml(p.facility_id)}" aria-label="Details for ${name}">Details</button>`;
}
/** Shelters that keep their address private (e.g. youth / DV) get no directions link. */
function isConfidentialLocation(p) { return /confidential/i.test(p.address || ''); }
/** Google Maps directions, in the person's chosen travel mode when they picked one. */
function seekerDirectionsUrl(feat) {
  const url = directionsUrl(feat.geometry.coordinates, feat.properties.address);
  const mode = state.travel.mode === 'walk' ? 'walking' : state.travel.mode === 'drive' ? 'driving' : '';
  return mode && url !== '#' ? `${url}&travelmode=${mode}` : url;
}
const ICON_PHONE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/></svg>';
const ICON_DIRECTIONS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.7 11.3l-9-9a1 1 0 0 0-1.4 0l-9 9a1 1 0 0 0 0 1.4l9 9a1 1 0 0 0 1.4 0l9-9a1 1 0 0 0 0-1.4zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5-3.5 3.5z"/></svg>';

/* ── Resource detail ──────────────────────────────────────────────────────── */
export function openSeekerDetail(facilityId) {
  state.detailId = facilityId;
  setSelectedFacility(facilityId);
  window.__reliefgrid_navigate('seeker-detail');
  renderDetailPage();
}
function renderDetailPage() {
  const feat = findFacilityFeature(state.detailId);
  const body = $('seeker-detail-body');
  if (!feat || !body) { if (body) body.innerHTML = '<p class="muted">Resource not found.</p>'; return; }
  const p = feat.properties, coords = feat.geometry.coordinates;
  const rec = Availability.get(p.facility_id);
  const group = p.resource_group;
  const status = rec ? rec.status : 'unknown'; const s = STATUS[status];
  const isSaved = savedIds.has(p.facility_id);
  const distKm = state.userCoords ? haversineKm(state.userCoords[0], state.userCoords[1], coords[0], coords[1]) : null;
  const website = cleanUrl(p.website || p.source_url);
  const phone = p.phone || '';

  const whatItProvides = p.short_description || `${RESOURCE_LABELS[group] || 'A community resource'} serving Long Island.`;
  const heroSub = rec ? availabilityHeadline(rec, group) : 'This listing doesn’t report availability yet. Contact the provider to confirm.';

  const distanceLine = distKm != null
    ? `${kmToMiles(distKm).toFixed(1)} miles away — a straight-line estimate, not driving directions.`
    : `Distance unavailable — add your location on the Find Help page to see how far this is.`;

  const staleWarn = rec && rec.freshness === 'stale'
    ? `<div class="rd-stale-warn"><span aria-hidden="true">⚠</span> This information hasn't been updated in a while. It may have changed — please confirm with the provider.</div>` : '';

  body.innerHTML = `
    <h2 class="sd-name">${escapeHtml(p.name || 'Unnamed resource')}</h2>
    <div class="sd-type">${resourceLegendIcon(group)}<span>${escapeHtml(RESOURCE_LABELS[group] || '')}${distKm != null ? ` · ${kmToMiles(distKm).toFixed(1)} mi away (straight line)` : ''}</span></div>
    <div class="sd-actions">
      ${phone ? `<a class="btn btn-primary" href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}">${ICON_PHONE}Call</a>` : ''}
      ${isConfidentialLocation(p) ? '' : `<a class="btn ${phone ? 'btn-secondary' : 'btn-primary'}" href="${escapeHtml(seekerDirectionsUrl(feat))}" target="_blank" rel="noopener">${ICON_DIRECTIONS}Get directions</a>`}
      <button class="btn btn-ghost sd-save-btn" id="sd-save-btn" aria-pressed="${isSaved}">${isSaved ? '★ Saved' : '☆ Save'}</button>
    </div>
    <p class="sd-provides">${escapeHtml(whatItProvides)}</p>

    <div class="rd-status rd-status-${status}"><span class="rd-status-glyph" aria-hidden="true">${s.glyph}</span>
      <div class="rd-status-text"><div class="rd-status-label">${escapeHtml(s.label)}${rec ? ' <span class="rd-status-demo">· demo status</span>' : ''}</div><div class="rd-status-sub">${escapeHtml(heroSub)}</div></div></div>
    <div class="sd-openline">${escapeHtml(openLabel(rec))}${rec?.raw?.next_service_time ? ` · Next: ${escapeHtml(rec.raw.next_service_time)}` : ''}</div>
    ${rec?.raw?.message ? `<div class="rd-message"><span aria-hidden="true">📣</span> ${escapeHtml(rec.raw.message)}</div>` : ''}
    ${rec ? `<div class="sd-updated">Last updated ${escapeHtml(rec.relativeTime)} · ${demoPillHTML()}</div>${staleWarn}` : `<div class="sd-updated muted">${demoPillHTML('Prototype')} No availability shared for this resource yet.</div>`}

    <div class="sd-section"><div class="rd-section-label">Distance &amp; travel</div><div>${distanceLine}</div></div>
    <div class="sd-section"><div class="rd-section-label">Eligibility</div><div class="muted">This prototype does not have confirmed eligibility rules for every resource. Contact the provider to confirm you qualify before travelling.</div></div>
    <div class="sd-section"><div class="rd-section-label">Address</div><div>${escapeHtml(p.address || 'Address not listed in this dataset')}</div>${p.coordinate_note ? `<div class="muted small">${escapeHtml(p.coordinate_note)}</div>` : ''}</div>
    ${p.opening_time ? `<div class="sd-section"><div class="rd-section-label">Listed hours</div><div>${escapeHtml(p.opening_time)}</div></div>` : ''}
    <div class="sd-section"><div class="rd-section-label">Phone</div><div>${phone ? escapeHtml(phone) : 'Not listed in ReliefGrid’s records yet.'}</div></div>
    ${website ? `<div class="sd-section"><div class="rd-section-label">Website</div><div><a href="${escapeHtml(website)}" target="_blank" rel="noopener">${escapeHtml(website)}</a></div></div>` : ''}

    <div id="sd-location-context"></div>

    <button type="button" class="btn btn-ghost btn-sm" id="sd-find-similar" style="margin-top:14px">Find similar places</button>
    <div id="sd-similar" class="${(status === 'full' || status === 'closed') ? '' : 'hidden'}"></div>
  `;
  $('sd-save-btn')?.addEventListener('click', () => { toggleSaved(p.facility_id); renderDetailPage(); });
  $('sd-find-similar')?.addEventListener('click', () => { const el = $('sd-similar'); el.classList.toggle('hidden'); if (!el.classList.contains('hidden')) el.innerHTML = similarServicesHTML(feat); });
  if (status === 'full' || status === 'closed') $('sd-similar').innerHTML = similarNoticeHTML(status) + similarServicesHTML(feat);
  document.dispatchEvent(new CustomEvent('rg:seeker-detail-rendered', { detail: { facilityId: p.facility_id } }));
}
function similarNoticeHTML(status) {
  const text = status === 'full' ? 'This listing reports no availability (demo data).' : 'This listing reports it is closed (demo data).';
  return `<div class="insight-card" style="margin-top:10px">${escapeHtml(text)} Here are similar options nearby:</div>`;
}
function similarServicesHTML(feat) {
  const group = feat.properties.resource_group;
  const [lng, lat] = feat.geometry.coordinates;
  const alts = (AppState.facilitiesData?.features || [])
    .filter(f => f.properties.facility_id !== feat.properties.facility_id && f.properties.resource_group === group)
    .map(f => ({ f, rec: Availability.get(f.properties.facility_id), d: haversineKm(lng, lat, f.geometry.coordinates[0], f.geometry.coordinates[1]) }))
    .sort((a, b) => { const ra = a.rec ? RANK[a.rec.status] : 2, rb = b.rec ? RANK[b.rec.status] : 2; return ra !== rb ? ra - rb : a.d - b.d; })
    .slice(0, 3);
  if (!alts.length) return '<p class="muted small">No similar resources found in this dataset.</p>';
  const html = `<div class="section-label" style="margin-top:12px">You might also try</div>` + alts.map(a => resourceCardHTML(a.f, a.rec, a.d)).join('');
  requestAnimationFrame(() => { const el = $('sd-similar'); if (el) wireCardList(el, () => renderDetailPage()); });
  return html;
}
function toggleSaved(id) {
  if (savedIds.has(id)) savedIds.delete(id); else savedIds.add(id);
  persistSaved();
  document.querySelectorAll(`[data-save="${CSS && CSS.escape ? CSS.escape(id) : id}"]`).forEach(btn => {
    const now = savedIds.has(id);
    btn.classList.toggle('saved', now); btn.setAttribute('aria-pressed', String(now)); btn.textContent = now ? '★' : '☆';
    btn.setAttribute('aria-label', now ? 'Remove from saved' : 'Save this resource');
  });
  document.dispatchEvent(new CustomEvent('rg:saved-changed'));
}

/* ── Saved ─────────────────────────────────────────────────────────────── */
function renderSaved() {
  const el = $('seeker-saved-list'); if (!el) return;
  if (!savedIds.size) { el.innerHTML = '<p class="muted">Nothing saved yet. Tap the star on any resource to keep it here.</p>'; return; }
  const items = [...savedIds].map(id => findFacilityFeature(id)).filter(Boolean);
  el.innerHTML = items.map(f => resourceCardHTML(f, Availability.get(f.properties.facility_id), null)).join('');
  wireCardList(el, () => renderSaved());
}

/* ── Guided matching (rule-based, not AI) ────────────────────────────────── */
const GUIDED_NEED_OPTIONS = [
  { id: 'shelter', label: 'A safe place to sleep' }, { id: 'food', label: 'Food' },
  { id: 'health', label: 'Medical care' }, { id: 'behavioral_health', label: 'Mental health support' },
  { id: 'housing_support', label: 'Housing assistance' }, { id: 'legal', label: 'Legal help' },
];
// "Accepting walk-ins" is only a meaningful question for service types where the
// demo data actually models it (see the provider form's showWait grouping) —
// asking it for food/shelter/housing would just set up a guaranteed dead end.
export const WALKIN_RELEVANT_CATEGORIES = new Set(['health', 'behavioral_health', 'legal']);
// Search radius for each travel answer — shared by the guided flow and the AI
// navigator so both translate "how are you getting there" identically.
export const TRAVEL_RADIUS_KM = { walking: 2.5, driving: 24, unsure: 12 };

function wireGuidedControls() {
  $('seeker-guided-back')?.addEventListener('click', () => { guided.step = Math.max(0, guided.step - 1); renderGuidedStep(); });
}
function restStepSequence() {
  const steps = ['tonight'];
  if (WALKIN_RELEVANT_CATEGORIES.has(guided.need)) steps.push('walkins');
  steps.push('travel');
  return steps;
}
function renderGuidedStep() {
  const body = $('seeker-guided-body'); const indicator = $('seeker-guided-indicator'); if (!body) return;
  $('seeker-guided-back')?.toggleAttribute('disabled', guided.step === 0);

  if (guided.step === 0) {
    if (indicator) indicator.textContent = 'Step 1';
    body.innerHTML = `<h2>What do you need right now?</h2>
      <div class="guided-options">${GUIDED_NEED_OPTIONS.map(o => `<button type="button" class="guided-option" data-need="${o.id}">${escapeHtml(o.label)}</button>`).join('')}</div>`;
    body.querySelectorAll('[data-need]').forEach(btn => btn.addEventListener('click', () => { guided.need = btn.dataset.need; guided.step = 1; renderGuidedStep(); }));
    return;
  }

  const seq = restStepSequence();
  const key = seq[guided.step - 1];
  if (indicator) indicator.textContent = `Step ${guided.step + 1} of ${seq.length + 1}`;

  if (key === 'tonight') {
    body.innerHTML = `<h2>Are you looking for help tonight?</h2>
      <div class="guided-options guided-options-row"><button type="button" class="guided-option" data-v="yes">Yes, tonight</button><button type="button" class="guided-option" data-v="no">No, just exploring</button></div>`;
    body.querySelectorAll('[data-v]').forEach(btn => btn.addEventListener('click', () => { guided.tonight = btn.dataset.v; guided.step++; renderGuidedStep(); }));
  } else if (key === 'walkins') {
    body.innerHTML = `<h2>Do you need somewhere accepting walk-ins?</h2>
      <div class="guided-options guided-options-row"><button type="button" class="guided-option" data-v="yes">Yes, walk-ins</button><button type="button" class="guided-option" data-v="no">Not sure / doesn't matter</button></div>`;
    body.querySelectorAll('[data-v]').forEach(btn => btn.addEventListener('click', () => { guided.walkins = btn.dataset.v; guided.step++; renderGuidedStep(); }));
  } else {
    body.innerHTML = `<h2>How are you traveling?</h2>
      <div class="guided-options guided-options-row">
        <button type="button" class="guided-option" data-v="walking">Walking</button>
        <button type="button" class="guided-option" data-v="driving">Driving</button>
        <button type="button" class="guided-option" data-v="unsure">Not sure</button>
      </div>`;
    body.querySelectorAll('[data-v]').forEach(btn => btn.addEventListener('click', () => { guided.travel = btn.dataset.v; finishGuided(); }));
  }
}
function finishGuided() {
  state.categories = [guided.need];
  state.source = 'guided';
  state.resultsHeading = GUIDED_NEED_OPTIONS.find(o => o.id === guided.need)?.label || 'Resources';
  const filters = new Set();
  if (guided.tonight === 'yes') filters.add('open_now');
  if (guided.walkins === 'yes') filters.add('walk_ins');
  state.radiusKm = TRAVEL_RADIUS_KM[guided.travel] ?? TRAVEL_RADIUS_KM.unsure;
  if (state.userCoords) filters.add('near_me');
  state.quickFilters = filters;
  relaxUntilResults();
  window.__reliefgrid_navigate('seeker-results');
}
// Safety net: a guided flow should never strand someone with zero results.
// Relax the least-essential filters, in order, until something shows.
const RELAX_ORDER = ['walk_ins', 'near_me', 'open_now'];
function relaxUntilResults() {
  const relaxed = [];
  for (let i = 0; i < RELAX_ORDER.length && computeResults().length === 0; i++) {
    if (state.quickFilters.delete(RELAX_ORDER[i])) relaxed.push(RELAX_ORDER[i]);
  }
  syncQuickFilterButtons();
  return relaxed;
}

/* ── Availability change propagation ─────────────────────────────────────── */
function onSeekerAvailabilityChanged() {
  if (seekerPage === 'seeker-results') renderResults();
  if (seekerPage === 'seeker-detail') renderDetailPage();
  if (seekerPage === 'seeker-saved') renderSaved();
}

/* ── Public API for the AI Resource Navigator ────────────────────────────── */
export function getSeekerPage() { return seekerPage; }
export function getSavedCount() { return savedIds.size; }

/** Read-only snapshot of the current query. */
export function getSeekerQuery() {
  const t = state.travel;
  return {
    categories: state.categories ? [...state.categories] : null,
    quickFilters: [...state.quickFilters],
    radiusKm: state.radiusKm,
    userCoords: state.userCoords ? [...state.userCoords] : null,
    locationLabel: state.locationLabel,
    locationPrecision: state.locationPrecision,
    source: state.source,
    heading: state.resultsHeading,
    travel: { mode: t.mode, maxMinutes: t.maxMinutes, maxMiles: t.maxMiles, status: t.status, relaxed: t.relaxed },
  };
}
/** Subscribe to every results render: fn(results, query). */
export function onSeekerResultsRendered(fn) { resultsListeners.add(fn); return () => resultsListeners.delete(fn); }

/** Set / clear the search origin. Coordinates are kept in memory only. */
export function setSeekerLocation(coords, label, precision = null) {
  state.userCoords = coords || null;
  state.locationLabel = coords ? (label || '') : '';
  state.locationPrecision = coords ? precision : null;
  if (!coords) state.quickFilters.delete('near_me');
  resetTravelTimes();
  updateLocationUI();
}

/**
 * Apply a structured plan (from the AI navigator) using exactly the same
 * translation rules as the guided flow, then show results. Returns the list
 * of filters that had to be relaxed to avoid a zero-result dead end.
 *   plan = { categories: string[], openNow: bool, walkIns: bool,
 *            travel: 'walking'|'driving'|'unsure'|null, heading: string,
 *            travelMode: 'walk'|'drive'|null, maxMinutes: number|null, maxMiles: number|null }
 * When real travel times are available, travelMode/maxMinutes replace the
 * straight-line "near me" radius; otherwise the original radius rule applies.
 */
export function applySeekerPlan(plan) {
  const valid = new Set(SEEKER_CATEGORIES.map(c => c.id));
  const cats = (plan.categories || []).filter(c => valid.has(c));
  state.categories = cats.length ? cats : null;
  state.source = 'ai';
  state.resultsHeading = plan.heading || (cats.length ? cats.map(c => SEEKER_CATEGORIES.find(x => x.id === c).label).join(' + ') : 'All resources');
  const filters = new Set();
  if (plan.openNow) filters.add('open_now');
  if (plan.walkIns && cats.some(c => WALKIN_RELEVANT_CATEGORIES.has(c))) filters.add('walk_ins');
  state.radiusKm = plan.travel ? (TRAVEL_RADIUS_KM[plan.travel] ?? DEFAULT_RADIUS_KM) : DEFAULT_RADIUS_KM;
  const routing = !!(getAIStatus().location?.travelTimes && plan.travelMode);
  Object.assign(state.travel, { mode: plan.travelMode || null, maxMinutes: plan.maxMinutes || null, maxMiles: plan.maxMiles || null });
  resetTravelTimes();
  if (state.userCoords && plan.travel && !routing) filters.add('near_me');
  state.quickFilters = filters;
  const relaxed = relaxUntilResults();
  window.__reliefgrid_navigate('seeker-results');
  return relaxed;
}

/** Incremental edits from the "Needs identified" chips / travel bar; re-renders results. */
export function updateSeekerQuery(patch) {
  if ('categories' in patch) {
    const valid = new Set(SEEKER_CATEGORIES.map(c => c.id));
    const cats = (patch.categories || []).filter(c => valid.has(c));
    state.categories = cats.length ? cats : null;
    state.resultsHeading = cats.length ? cats.map(c => SEEKER_CATEGORIES.find(x => x.id === c).label).join(' + ') : 'All resources';
  }
  if (patch.removeFilter) state.quickFilters.delete(patch.removeFilter);
  if (patch.addFilter) state.quickFilters.add(patch.addFilter);
  if ('travel' in patch) {
    state.radiusKm = patch.travel ? (TRAVEL_RADIUS_KM[patch.travel] ?? DEFAULT_RADIUS_KM) : DEFAULT_RADIUS_KM;
    if (!patch.travel) state.quickFilters.delete('near_me');
  }
  if ('travelMode' in patch) {
    state.travel.mode = patch.travelMode === 'walk' || patch.travelMode === 'drive' ? patch.travelMode : null;
    if (!state.travel.mode) { state.travel.maxMinutes = null; state.travel.maxMiles = null; }
    resetTravelTimes();
    if (state.travel.mode) state.quickFilters.delete('near_me'); // real travel times replace the straight-line radius
  }
  if (patch.clearTravelLimit) { state.travel.maxMinutes = null; state.travel.maxMiles = null; }
  if (patch.clearLocation) setSeekerLocation(null);
  syncQuickFilterButtons();
  if (seekerPage === 'seeker-results') renderResults();
}
