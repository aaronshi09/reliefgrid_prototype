/* ============================================================================
 * ReliefGrid — "Find Help" seeker (consumer) shell.
 * ----------------------------------------------------------------------------
 * Built for someone who may be stressed, on a phone, and unfamiliar with the
 * service system: large targets, short plain-language copy, a list before a
 * map, and an honest degrade when we can't actually locate or route someone
 * (this prototype has no geocoder or turn-by-turn routing).
 * ==========================================================================*/
import {
  AppState, Availability, STATUS,
  SEEKER_CATEGORIES, RESOURCE_LABELS, categoryForGroup, lookupTown,
  findFacilityFeature, availabilityHeadline, openLabel, statusChipHTML, demoPillHTML,
  escapeHtml, cleanUrl, directionsUrl, haversineKm, kmToMiles, setUserLocationMarker,
  resourceLegendIcon,
} from './shared.js';

export const SEEKER_MAP_PAGES = new Set(['seeker-results']);
export const SEEKER_CONTENT_PAGES = new Set(['seeker-home', 'seeker-detail', 'seeker-guided', 'seeker-saved', 'seeker-about']);
export const SEEKER_PAGES = new Set([...SEEKER_MAP_PAGES, ...SEEKER_CONTENT_PAGES]);

const $ = (id) => document.getElementById(id);
const SAVED_KEY = 'reliefgrid.saved.v1';
const RANK = { available: 0, limited: 1, unknown: 2, closed: 3, full: 4 };

let seekerPage = 'seeker-home';
const state = {
  category: null,        // SEEKER_CATEGORIES id, or null = all
  userCoords: null,
  locationLabel: '',
  quickFilters: new Set(), // open_now | available_now | walk_ins | near_me
  radiusKm: 24,
  detailId: null,
  resultsHeading: 'Nearby resources',
};
const guided = { step: 0, need: null, tonight: null, walkins: null, travel: null };
let savedIds = loadSaved();

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

  if (SEEKER_MAP_PAGES.has(page)) {
    $(`panel-${page}`)?.classList.remove('hidden');
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
    state.category = btn.dataset.cat;
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
    btn.classList.toggle('active', state.quickFilters.has(key));
  }));
  $('seeker-browse-all')?.addEventListener('click', () => { state.category = null; state.resultsHeading = 'All resources'; window.__reliefgrid_navigate('seeker-results'); });
  $('seeker-guided-start')?.addEventListener('click', () => { guided.step = 0; guided.need = guided.tonight = guided.walkins = guided.travel = null; window.__reliefgrid_navigate('seeker-guided'); });
}
function showLocationNote(text) { const el = $('seeker-location-note'); if (el) { el.textContent = text; el.classList.remove('hidden'); } }
function updateLocationUI() {
  const el = $('seeker-location-input'); if (el && state.locationLabel) el.value = state.locationLabel;
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
function computeResults() {
  const cat = SEEKER_CATEGORIES.find(c => c.id === state.category);
  let list = (AppState.facilitiesData?.features || [])
    .filter(f => !cat || cat.groups.includes(f.properties.resource_group))
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
  if (sub) sub.textContent = state.userCoords ? `Near ${state.locationLabel}` : 'Add your location to sort by distance';
  const listEl = $('seeker-results-list');
  if (listEl) {
    listEl.innerHTML = results.length
      ? results.map(r => resourceCardHTML(r.f, r.rec, r.d)).join('')
      : `<div class="seeker-empty">No resources match these filters right now. <button type="button" class="btn btn-ghost btn-sm" id="seeker-clear-filters">Clear filters</button></div>`;
    listEl.querySelectorAll('.seeker-card').forEach(card => card.addEventListener('click', (e) => {
      if (e.target.closest('[data-save]')) return;
      openSeekerDetail(card.dataset.id);
    }));
    listEl.querySelectorAll('[data-save]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); toggleSaved(btn.dataset.save); }));
    $('seeker-clear-filters')?.addEventListener('click', () => { state.quickFilters.clear(); document.querySelectorAll('#seeker-quick-filters button').forEach(b => b.classList.remove('active')); renderResults(); });
  }
  applyResultsMapFilter(results);
}
function applyResultsMapFilter(results) {
  const map = AppState.map; if (!map || !map.getLayer('facilities')) return;
  const ids = results.map(r => r.f.properties.facility_id);
  const filter = ids.length ? ['in', ['get', 'facility_id'], ['literal', ids]] : ['==', ['get', 'facility_id'], '__none__'];
  ['facilities', 'facilities-status-bg', 'facilities-status-label'].forEach(id => {
    if (!map.getLayer(id)) return;
    if (id === 'facilities') map.setFilter(id, filter);
    else map.setFilter(id, ['all', ['==', ['get', 'avail_has_data'], true], filter]);
  });
  map.setLayoutProperty('facilities', 'visibility', 'visible');
  map.setPaintProperty('tract-fill', 'fill-opacity', 0);
  map.setLayoutProperty('districts-fill', 'visibility', 'none');
  map.setLayoutProperty('districts-stroke', 'visibility', 'none');
  ['facilities-status-bg', 'facilities-status-label'].forEach(id => map.setLayoutProperty(id, 'visibility', 'visible'));
  const coordsList = results.map(r => r.f.geometry.coordinates);
  if (state.userCoords) coordsList.push(state.userCoords);
  if (coordsList.length) {
    const lngs = coordsList.map(c => c[0]), lats = coordsList.map(c => c[1]);
    const bounds = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
    try { map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 500 }); } catch (_) {}
  } else {
    map.easeTo({ center: [-73.05, 40.84], zoom: 8.9, duration: 500 });
  }
}
function setResultsMobileView(view) {
  document.getElementById('app').dataset.mobileView = view;
  document.querySelectorAll('#seeker-results-view-toggle button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'map') setTimeout(() => AppState.map?.resize(), 50);
}
function resourceCardHTML(feat, rec, distKm) {
  const p = feat.properties;
  const status = rec ? rec.status : 'unknown';
  const isSaved = savedIds.has(p.facility_id);
  const distHTML = distKm != null ? `<span class="seeker-dist">${kmToMiles(distKm).toFixed(1)} mi</span>` : '';
  return `<article class="seeker-card" data-id="${escapeHtml(p.facility_id)}">
    <button type="button" class="seeker-save-btn ${isSaved ? 'saved' : ''}" data-save="${escapeHtml(p.facility_id)}" aria-pressed="${isSaved}" aria-label="${isSaved ? 'Remove from saved' : 'Save this resource'}">${isSaved ? '★' : '☆'}</button>
    <div class="seeker-card-top">
      ${resourceLegendIcon(p.resource_group)}
      <div class="seeker-card-title"><h3>${escapeHtml(p.name || 'Unnamed resource')}</h3><div class="seeker-card-type">${escapeHtml(RESOURCE_LABELS[p.resource_group] || '')}</div></div>
    </div>
    <div class="seeker-card-status">${statusChipHTML(status)}<span class="open-label">${escapeHtml(openLabel(rec))}</span>${distHTML}</div>
    ${rec ? `<div class="seeker-card-info">${escapeHtml(availabilityHeadline(rec, p.resource_group))}</div>` : `<div class="seeker-card-info muted">Availability not shared yet</div>`}
    <div class="seeker-card-meta">
      <span>${escapeHtml(p.address || 'Address not listed')}</span>
      <span>${rec ? `Updated ${escapeHtml(rec.relativeTime)}` : ''}</span>
    </div>
  </article>`;
}

/* ── Resource detail ──────────────────────────────────────────────────────── */
export function openSeekerDetail(facilityId) {
  state.detailId = facilityId;
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
    <div class="sd-section"><div class="rd-section-label">Address</div><div>${escapeHtml(p.address || 'Address not listed in this dataset')}</div></div>
    <div class="sd-section"><div class="rd-section-label">Phone</div><div>${phone ? escapeHtml(phone) : 'Not listed — see website or visit in person.'}</div></div>

    <div class="sd-actions">
      ${phone ? `<a class="btn btn-primary" href="tel:${escapeHtml(phone.replace(/[^\d+]/g, ''))}">Call</a>` : `<button class="btn btn-primary" disabled title="No phone listed">Call</button>`}
      <a class="btn btn-secondary" href="${escapeHtml(directionsUrl(coords, p.address))}" target="_blank" rel="noopener">Get Directions</a>
      <button class="btn btn-ghost sd-save-btn" id="sd-save-btn" aria-pressed="${isSaved}">${isSaved ? '★ Saved' : '☆ Save'}</button>
    </div>

    <button type="button" class="btn btn-ghost btn-sm" id="sd-find-similar" style="margin-top:14px">Find Similar Services</button>
    <div id="sd-similar" class="${(status === 'full' || status === 'closed') ? '' : 'hidden'}"></div>
  `;
  $('sd-save-btn')?.addEventListener('click', () => { toggleSaved(p.facility_id); renderDetailPage(); });
  $('sd-find-similar')?.addEventListener('click', () => { const el = $('sd-similar'); el.classList.toggle('hidden'); if (!el.classList.contains('hidden')) el.innerHTML = similarServicesHTML(feat); });
  if (status === 'full' || status === 'closed') $('sd-similar').innerHTML = similarNoticeHTML(status) + similarServicesHTML(feat);
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
  requestAnimationFrame(() => {
    document.querySelectorAll('#sd-similar .seeker-card').forEach(card => card.addEventListener('click', (e) => { if (e.target.closest('[data-save]')) return; openSeekerDetail(card.dataset.id); }));
    document.querySelectorAll('#sd-similar [data-save]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); toggleSaved(btn.dataset.save); renderDetailPage(); }));
  });
  return html;
}
function toggleSaved(id) {
  if (savedIds.has(id)) savedIds.delete(id); else savedIds.add(id);
  persistSaved();
  document.querySelectorAll(`[data-save="${CSS && CSS.escape ? CSS.escape(id) : id}"]`).forEach(btn => {
    const now = savedIds.has(id);
    btn.classList.toggle('saved', now); btn.setAttribute('aria-pressed', String(now)); btn.textContent = now ? '★' : '☆';
  });
}

/* ── Saved ─────────────────────────────────────────────────────────────── */
function renderSaved() {
  const el = $('seeker-saved-list'); if (!el) return;
  if (!savedIds.size) { el.innerHTML = '<p class="muted">Nothing saved yet. Tap the star on any resource to keep it here.</p>'; return; }
  const items = [...savedIds].map(id => findFacilityFeature(id)).filter(Boolean);
  el.innerHTML = items.map(f => resourceCardHTML(f, Availability.get(f.properties.facility_id), null)).join('');
  el.querySelectorAll('.seeker-card').forEach(card => card.addEventListener('click', (e) => { if (e.target.closest('[data-save]')) return; openSeekerDetail(card.dataset.id); }));
  el.querySelectorAll('[data-save]').forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); toggleSaved(btn.dataset.save); renderSaved(); }));
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
const WALKIN_RELEVANT_CATEGORIES = new Set(['health', 'behavioral_health', 'legal']);

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
  state.category = guided.need;
  state.resultsHeading = GUIDED_NEED_OPTIONS.find(o => o.id === guided.need)?.label || 'Resources';
  const filters = new Set();
  if (guided.tonight === 'yes') filters.add('open_now');
  if (guided.walkins === 'yes') filters.add('walk_ins');
  state.radiusKm = guided.travel === 'walking' ? 2.5 : guided.travel === 'driving' ? 24 : 12;
  if (state.userCoords) filters.add('near_me');
  state.quickFilters = filters;
  // Safety net: a guided flow should never strand someone with zero results.
  // Relax the least-essential filters, in order, until something shows.
  const relaxOrder = ['walk_ins', 'near_me', 'open_now'];
  for (let i = 0; i < relaxOrder.length && computeResults().length === 0; i++) state.quickFilters.delete(relaxOrder[i]);
  window.__reliefgrid_navigate('seeker-results');
}

/* ── Availability change propagation ─────────────────────────────────────── */
function onSeekerAvailabilityChanged() {
  if (seekerPage === 'seeker-results') renderResults();
  if (seekerPage === 'seeker-detail') renderDetailPage();
  if (seekerPage === 'seeker-saved') renderSaved();
}

export function getSeekerPage() { return seekerPage; }
export function getSavedCount() { return savedIds.size; }
