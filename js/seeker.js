/* ============================================================================
 * ReliefGrid — "Find Help" seeker (consumer) shell.
 * ----------------------------------------------------------------------------
 * Built for someone who may be stressed, on a phone, and unfamiliar with the
 * service system: large targets, short plain-language copy, a list before a
 * map, and an honest degrade when we can't actually locate or route someone
 * (this prototype has no geocoder or turn-by-turn routing).
 *
 * The AI Resource Navigator (js/ai/navigator.js) drives this shell through the
 * small public API at the bottom of the file (applySeekerPlan etc.). It never
 * produces resources itself: every result shown here comes from
 * computeResults() over longisland_facilities.geojson.
 * ==========================================================================*/
import {
  AppState, Availability, STATUS,
  SEEKER_CATEGORIES, RESOURCE_LABELS, lookupTown,
  findFacilityFeature, availabilityHeadline, openLabel, statusChipHTML, demoPillHTML,
  escapeHtml, cleanUrl, directionsUrl, haversineKm, kmToMiles, setUserLocationMarker,
  resourceLegendIcon, setFacilityHover, setSelectedFacility, fitPadding, motion,
  LONG_ISLAND_CENTER, LONG_ISLAND_ZOOM, setFacilitiesLayout, fitLongIsland, setUserLocationVisible, flyToPoint,
  setTractHighlight, setSelectedTract,
} from './shared.js';

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
};
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
}
function useMyLocation() {
  if (!('geolocation' in navigator)) { showLocationNote('Location access is not available in this browser. Type a town or ZIP instead — Call or Directions will still work from any result.'); return; }
  showLocationNote('Requesting your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.userCoords = [pos.coords.longitude, pos.coords.latitude];
      state.locationLabel = 'Your current location';
      showLocationNote('Using your current location.');
      updateLocationUI();
    },
    (err) => { showLocationNote(`We couldn't get your location (${err && err.message ? err.message : 'permission denied'}). Type a town or ZIP below, or keep browsing without one.`); },
    { timeout: 8000 }
  );
}
function submitLocationText(text) {
  const t = (text || '').trim();
  if (!t) { showLocationNote('Enter a Long Island town name, or use "Use My Location."'); return; }
  const coords = lookupTown(t);
  if (coords) {
    state.userCoords = coords; state.locationLabel = t;
    showLocationNote(`Showing results near ${t}. This prototype recognizes a set of Long Island towns rather than full street addresses — distances are straight-line estimates, not driving directions.`);
  } else {
    state.userCoords = null; state.locationLabel = t;
    showLocationNote(`ReliefGrid's prototype doesn't recognize "${t}" yet. Showing all Long Island resources instead — try a nearby town name, or use "Use My Location."`);
  }
  updateLocationUI();
}

/* ── Results (map page: list + map, mobile list/map toggle) ─────────────── */
function activeGroups() {
  if (!state.categories || !state.categories.length) return null;
  const groups = new Set();
  state.categories.forEach(id => SEEKER_CATEGORIES.find(c => c.id === id)?.groups.forEach(g => groups.add(g)));
  return groups;
}
function computeResults() {
  const groups = activeGroups();
  let list = (AppState.facilitiesData?.features || [])
    .filter(f => !groups || groups.has(f.properties.resource_group))
    .map(f => {
      const rec = Availability.get(f.properties.facility_id);
      const d = state.userCoords ? haversineKm(state.userCoords[0], state.userCoords[1], f.geometry.coordinates[0], f.geometry.coordinates[1]) : null;
      return { f, rec, d };
    });
  if (state.quickFilters.has('open_now')) list = list.filter(x => x.rec && x.rec.raw.open_now !== false && x.rec.status !== 'closed');
  if (state.quickFilters.has('available_now')) list = list.filter(x => x.rec && x.rec.status === 'available');
  if (state.quickFilters.has('walk_ins')) list = list.filter(x => x.rec && x.rec.raw.walk_ins === true);
  if (state.quickFilters.has('near_me') && state.userCoords) list = list.filter(x => x.d != null && x.d <= state.radiusKm);
  list.sort((a, b) => {
    if (state.userCoords && a.d != null && b.d != null && Math.abs(a.d - b.d) > 0.05) return a.d - b.d;
    const ra = a.rec ? RANK[a.rec.status] : 2, rb = b.rec ? RANK[b.rec.status] : 2;
    if (ra !== rb) return ra - rb;
    return (a.f.properties.name || '').localeCompare(b.f.properties.name || '');
  });
  return list;
}
function renderResults() {
  const results = computeResults();
  const heading = $('seeker-results-heading');
  if (heading) heading.textContent = `${results.length} ${results.length === 1 ? 'result' : 'results'} · ${state.resultsHeading}`;
  const sub = $('seeker-results-sub');
  if (sub) sub.textContent = state.userCoords ? `Near ${state.locationLabel} · straight-line distances` : 'Add your location to sort by distance';
  const listEl = $('seeker-results-list');
  if (listEl) {
    listEl.innerHTML = results.length
      ? results.map(r => resourceCardHTML(r.f, r.rec, r.d)).join('')
      : `<div class="seeker-empty"><strong>No listings match all of these filters right now.</strong><span>Try removing a filter — or call the provider directly, availability changes often.</span><button type="button" class="btn btn-ghost btn-sm" id="seeker-clear-filters">Clear filters</button></div>`;
    wireCardList(listEl, () => renderResults());
    $('seeker-clear-filters')?.addEventListener('click', () => { state.quickFilters.clear(); syncQuickFilterButtons(); renderResults(); });
  }
  applyResultsMapFilter(results);
  resultsListeners.forEach(fn => { try { fn(results, getSeekerQuery()); } catch (e) { console.error(e); } });
}
function wireCardList(listEl, onSaveChange) {
  listEl.querySelectorAll('.seeker-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-save], [data-locate]')) return;
      openSeekerDetail(card.dataset.id);
    });
    card.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); openSeekerDetail(card.dataset.id); }
    });
    card.addEventListener('mouseenter', () => setFacilityHover(card.dataset.id));
    card.addEventListener('mouseleave', () => setFacilityHover(null));
    card.addEventListener('focusin', () => setFacilityHover(card.dataset.id));
    card.addEventListener('focusout', () => setFacilityHover(null));
  });
  listEl.querySelectorAll('[data-save]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); toggleSaved(btn.dataset.save); onSaveChange && onSaveChange(); }));
  listEl.querySelectorAll('[data-locate]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); focusFacilityOnMap(btn.dataset.locate); }));
}
/** Fly to a facility and mark it selected (used by cards and the AI summary). */
export function focusFacilityOnMap(facilityId) {
  const feat = findFacilityFeature(facilityId); const map = AppState.map;
  if (!feat || !map) return;
  if (window.matchMedia('(max-width: 760px)').matches && seekerPage === 'seeker-results') setResultsMobileView('map');
  setSelectedFacility(facilityId);
  flyToPoint(feat.geometry.coordinates, 13);
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
function setResultsMobileView(view) {
  document.getElementById('app').dataset.mobileView = view;
  document.querySelectorAll('#seeker-results-view-toggle button').forEach(b => { b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-pressed', String(b.dataset.view === view)); });
  // The map was hidden behind the list: resize, then re-frame the results.
  // Wait for the sheet's height transition so the padding reflects its final size.
  if (view === 'map') setTimeout(() => { AppState.map?.resize(); frameResults(0); }, motion(340));
}
function resourceCardHTML(feat, rec, distKm) {
  const p = feat.properties;
  const status = rec ? rec.status : 'unknown';
  const isSaved = savedIds.has(p.facility_id);
  const distHTML = distKm != null ? `<span class="seeker-dist" title="Straight-line distance">${kmToMiles(distKm).toFixed(1)} mi</span>` : '';
  const id = escapeHtml(p.facility_id);
  return `<article class="seeker-card" data-id="${id}" tabindex="0" aria-label="${escapeHtml(p.name || 'Unnamed resource')}">
    <div class="seeker-card-top">
      ${resourceLegendIcon(p.resource_group, null, 30)}
      <div class="seeker-card-title"><h3>${escapeHtml(p.name || 'Unnamed resource')}</h3><div class="seeker-card-type">${escapeHtml(RESOURCE_LABELS[p.resource_group] || '')}</div></div>
      <div class="seeker-card-tools">
        <button type="button" class="icon-btn" data-locate="${id}" aria-label="Show on map" title="Show on map"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A8.99 8.99 0 0 0 13 3.06V1h-2v2.06A8.99 8.99 0 0 0 3.06 11H1v2h2.06A8.99 8.99 0 0 0 11 20.94V23h2v-2.06A8.99 8.99 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 0-14 7 7 0 0 1 0 14z"/></svg></button>
        <button type="button" class="icon-btn seeker-save-btn ${isSaved ? 'saved' : ''}" data-save="${id}" aria-pressed="${isSaved}" aria-label="${isSaved ? 'Remove from saved' : 'Save this resource'}">${isSaved ? '★' : '☆'}</button>
      </div>
    </div>
    <div class="seeker-card-status">${statusChipHTML(status)}<span class="open-label">${escapeHtml(openLabel(rec))}</span>${distHTML}</div>
    ${rec ? `<div class="seeker-card-info">${escapeHtml(availabilityHeadline(rec, p.resource_group))}</div>` : `<div class="seeker-card-info muted">Availability not shared yet</div>`}
    <div class="seeker-card-meta">
      <span>${escapeHtml(p.address || 'Address not listed')}</span>
      <span>${rec ? `Updated ${escapeHtml(rec.relativeTime)} · demo` : ''}</span>
    </div>
  </article>`;
}

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
  const heroSub = rec ? availabilityHeadline(rec, group) : 'No live availability shared yet for this resource.';

  const distanceLine = distKm != null
    ? `${kmToMiles(distKm).toFixed(1)} miles away — a straight-line estimate, not driving directions.`
    : `Distance unavailable — add your location on the Find Help page to see how far this is.`;

  const staleWarn = rec && rec.freshness === 'stale'
    ? `<div class="rd-stale-warn"><span aria-hidden="true">⚠</span> This information hasn't been updated in a while. It may have changed — please confirm with the provider.</div>` : '';

  body.innerHTML = `
    <h2 class="sd-name">${escapeHtml(p.name || 'Unnamed resource')}</h2>
    <div class="sd-type">${resourceLegendIcon(group)}<span>${escapeHtml(RESOURCE_LABELS[group] || '')}</span></div>
    <p class="sd-provides">${escapeHtml(whatItProvides)}</p>

    <div class="rd-status rd-status-${status}"><span class="rd-status-glyph" aria-hidden="true">${s.glyph}</span>
      <div class="rd-status-text"><div class="rd-status-label">${escapeHtml(s.label.toUpperCase())}</div><div class="rd-status-sub">${escapeHtml(heroSub)}</div></div></div>
    <div class="sd-openline">${escapeHtml(openLabel(rec))}${rec?.raw?.next_service_time ? ` · Next: ${escapeHtml(rec.raw.next_service_time)}` : ''}</div>
    ${rec?.raw?.message ? `<div class="rd-message"><span aria-hidden="true">📣</span> ${escapeHtml(rec.raw.message)}</div>` : ''}
    ${rec ? `<div class="sd-updated">Last updated ${escapeHtml(rec.relativeTime)} · ${demoPillHTML()}</div>${staleWarn}` : `<div class="sd-updated muted">${demoPillHTML('Prototype')} No availability shared for this resource yet.</div>`}

    <div class="sd-section"><div class="rd-section-label">Distance &amp; travel</div><div>${distanceLine}</div></div>
    <div class="sd-section"><div class="rd-section-label">Eligibility</div><div class="muted">This prototype does not have confirmed eligibility rules for every resource. Contact the provider to confirm you qualify before travelling.</div></div>
    <div class="sd-section"><div class="rd-section-label">Address</div><div>${escapeHtml(p.address || 'Address not listed in this dataset')}</div>${p.coordinate_note ? `<div class="muted small">${escapeHtml(p.coordinate_note)}</div>` : ''}</div>
    ${p.opening_time ? `<div class="sd-section"><div class="rd-section-label">Listed hours</div><div>${escapeHtml(p.opening_time)}</div></div>` : ''}
    <div class="sd-section"><div class="rd-section-label">Phone</div><div>${phone ? escapeHtml(phone) : 'Not listed — see website or visit in person.'}</div></div>
    ${website ? `<div class="sd-section"><div class="rd-section-label">Website</div><div><a href="${escapeHtml(website)}" target="_blank" rel="noopener">${escapeHtml(website)}</a></div></div>` : ''}

    <div class="sd-actions">
      ${phone ? `<a class="btn btn-primary" href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}">Call</a>` : `<button class="btn btn-primary" disabled title="No phone listed">Call</button>`}
      <a class="btn btn-secondary" href="${escapeHtml(directionsUrl(coords, p.address))}" target="_blank" rel="noopener">Get Directions</a>
      <button class="btn btn-ghost sd-save-btn" id="sd-save-btn" aria-pressed="${isSaved}">${isSaved ? '★ Saved' : '☆ Save'}</button>
    </div>
    <div id="sd-location-context"></div>

    <button type="button" class="btn btn-ghost btn-sm" id="sd-find-similar" style="margin-top:14px">Find Similar Services</button>
    <div id="sd-similar" class="${(status === 'full' || status === 'closed') ? '' : 'hidden'}"></div>
  `;
  $('sd-save-btn')?.addEventListener('click', () => { toggleSaved(p.facility_id); renderDetailPage(); });
  $('sd-find-similar')?.addEventListener('click', () => { const el = $('sd-similar'); el.classList.toggle('hidden'); if (!el.classList.contains('hidden')) el.innerHTML = similarServicesHTML(feat); });
  if (status === 'full' || status === 'closed') $('sd-similar').innerHTML = similarNoticeHTML(status) + similarServicesHTML(feat);
  document.dispatchEvent(new CustomEvent('rg:seeker-detail-rendered', { detail: { facilityId: p.facility_id } }));
}
function similarNoticeHTML(status) {
  const text = status === 'full' ? 'This resource shows no availability right now.' : 'This resource is currently closed.';
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
  return {
    categories: state.categories ? [...state.categories] : null,
    quickFilters: [...state.quickFilters],
    radiusKm: state.radiusKm,
    userCoords: state.userCoords ? [...state.userCoords] : null,
    locationLabel: state.locationLabel,
    source: state.source,
    heading: state.resultsHeading,
  };
}
/** Subscribe to every results render: fn(results, query). */
export function onSeekerResultsRendered(fn) { resultsListeners.add(fn); return () => resultsListeners.delete(fn); }

/** Set / clear the searcher's location (coords from the prototype town lookup or geolocation). */
export function setSeekerLocation(coords, label) {
  state.userCoords = coords || null;
  state.locationLabel = coords ? (label || '') : '';
  if (!coords) state.quickFilters.delete('near_me');
  updateLocationUI();
}

/**
 * Apply a structured plan (from the AI navigator) using exactly the same
 * translation rules as the guided flow, then show results. Returns the list
 * of filters that had to be relaxed to avoid a zero-result dead end.
 *   plan = { categories: string[], openNow: bool, walkIns: bool,
 *            travel: 'walking'|'driving'|'unsure'|null, heading: string }
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
  if (state.userCoords && plan.travel) filters.add('near_me');
  state.quickFilters = filters;
  const relaxed = relaxUntilResults();
  window.__reliefgrid_navigate('seeker-results');
  return relaxed;
}

/** Incremental edits from the "Needs identified" chips; re-renders results. */
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
  if (patch.clearLocation) setSeekerLocation(null);
  syncQuickFilterButtons();
  if (seekerPage === 'seeker-results') renderResults();
}
