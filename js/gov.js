/* ============================================================================
 * ReliefGrid — Provider & Government Dashboard shell.
 * ----------------------------------------------------------------------------
 * Denser, analytical interface for county agencies, Continuums of Care,
 * nonprofit networks and providers. Reuses the same map, the same facility
 * dataset, and the same precomputed research fields (need_score, access_index,
 * mismatch_index, lisa_mismatch_index_label) that already live in the tract
 * GeoJSON — nothing here recomputes the research, it only translates it into
 * decision-facing language and screens.
 * ==========================================================================*/
import {
  AppState, Availability, STATUS, FRESHNESS_LABELS,
  RESOURCE_COLORS, RESOURCE_LABELS, LAYER_LABELS,
  setMapLayer, setAvailabilityLayerVisibility, pushFacilitiesToMap, findFacilityFeature,
  availabilityHeadline, availabilitySecondaryLines, openLabel, statusChipHTML, demoPillHTML,
  percent, number, labelize, escapeHtml, cleanUrl, directionsUrl, haversineKm, featureCentroid,
  resourceLegendIcon,
} from './shared.js';

export const GOV_MAP_PAGES = new Set(['gov-overview', 'gov-network', 'gov-gaps']);
export const GOV_CONTENT_PAGES = new Set(['gov-capacity', 'gov-provider', 'gov-methods']);
export const GOV_PAGES = new Set([...GOV_MAP_PAGES, ...GOV_CONTENT_PAGES]);

let govPage = 'gov-overview';
let networkCategoryFilters = new Set(Object.keys(RESOURCE_COLORS));
let networkAvailFilters = new Set();
let showAvailBadges = true;
let govDetailId = null;
let gapsLayer = 'mismatch_index';
let charts = {};
let providerSelectPopulated = false;

const $ = (id) => document.getElementById(id);
const AVAIL_FILTERS = {
  available_now: 'Available now', accepting: 'Accepting clients',
  shelter_beds: 'Shelter beds available', food: 'Food available', open_now: 'Open now',
};

export function initGov() {
  wireOverviewControls();
  wireNetworkControls();
  wireGapsControls();
  wireCapacityControls();
  wireProviderControls();
  $('gov-resource-detail-close')?.addEventListener('click', closeGovDetail);
  Availability.subscribe(onGovAvailabilityChanged);
}

export function navigateGov(page) {
  govPage = page;
  closeGovDetail();
  document.querySelectorAll('#side-panel > .side-panel-page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.content-page').forEach(p => p.classList.remove('active'));

  if (GOV_MAP_PAGES.has(page)) {
    $(`panel-${page}`)?.classList.remove('hidden');
    configureMapForGovPage(page);
    setTimeout(() => AppState.map?.resize(), 50);
  } else {
    $(`page-${page}`)?.classList.add('active');
    if (page === 'gov-capacity') renderCapacity();
    if (page === 'gov-provider') renderProviderPortal();
  }
}

function configureMapForGovPage(page) {
  const map = AppState.map; if (!map) return;
  map.setPaintProperty('tract-fill', 'fill-opacity', 0.7);
  setAvailabilityLayerVisibility(false);
  map.setLayoutProperty('districts-fill', 'visibility', 'none');
  map.setLayoutProperty('districts-stroke', 'visibility', 'none');

  if (page === 'gov-overview') {
    const layer = document.querySelector('input[name="gov-overview-layer"]:checked')?.value || 'mismatch_index';
    setMapLayer(layer === 'none' ? 'lisa' : layer);
    map.setPaintProperty('tract-fill', 'fill-opacity', layer === 'none' ? 0.12 : 0.65);
    map.setLayoutProperty('facilities', 'visibility', $('gov-overview-facilities-toggle')?.checked ? 'visible' : 'none');
    setAvailabilityLayerVisibility(!!$('gov-overview-avail-toggle')?.checked);
    renderOverviewTiles();
    renderOverviewLegend();
  } else if (page === 'gov-network') {
    setMapLayer('lisa');
    map.setPaintProperty('tract-fill', 'fill-opacity', 0.12);
    map.setLayoutProperty('facilities', 'visibility', 'visible');
    setAvailabilityLayerVisibility(showAvailBadges);
    applyNetworkFilter();
    renderNetworkCategoryFilters();
    renderNetworkAvailFilters();
    renderNetworkAvailLegend();
    renderNetworkCounts();
  } else if (page === 'gov-gaps') {
    setMapLayer(gapsLayer);
    map.setPaintProperty('tract-fill', 'fill-opacity', 0.72);
    map.setLayoutProperty('facilities', 'visibility', $('gov-gaps-facilities-toggle')?.checked ? 'visible' : 'none');
    renderGapsLegend();
  }
  map.easeTo({ center: [-73.05, 40.84], zoom: 8.9, duration: 500 });
}

/* ── Overview ─────────────────────────────────────────────────────────── */
function wireOverviewControls() {
  document.querySelectorAll('input[name="gov-overview-layer"]').forEach(r => r.addEventListener('change', () => configureMapForGovPage('gov-overview')));
  $('gov-overview-facilities-toggle')?.addEventListener('change', e => AppState.map?.setLayoutProperty('facilities', 'visibility', e.target.checked ? 'visible' : 'none'));
  $('gov-overview-avail-toggle')?.addEventListener('change', e => setAvailabilityLayerVisibility(e.target.checked));
  document.querySelectorAll('#panel-gov-overview .info-toggle').forEach(wireInfoToggle);
}
function overviewModel() {
  const facilities = AppState.facilitiesData?.features || [];
  const total = facilities.length;
  const recs = Availability.all();
  const shelters = recs.filter(r => Availability.meta(r.facility_id)?.resource_group === 'shelter');
  const bedTotal = shelters.reduce((s, r) => s + (Number.isFinite(r.raw.total_capacity) ? r.raw.total_capacity : 0), 0);
  const bedAvail = shelters.reduce((s, r) => s + (Number.isFinite(r.raw.available_capacity) ? r.raw.available_capacity : 0), 0);
  const stale = recs.filter(r => r.freshness === 'stale').length;

  const tracts = AppState.tractsData[AppState.mode]?.features || [];
  const needVals = tracts.map(f => +f.properties.need_score).filter(Number.isFinite).sort((a, b) => a - b);
  const p80 = needVals.length ? needVals[Math.floor(needVals.length * 0.8)] : null;
  const highNeed = p80 == null ? 0 : tracts.filter(f => +f.properties.need_score >= p80).length;
  const hh = AppState.diagnostics[AppState.mode]?.lisa_counts?.mismatch_index?.HH || 0;

  return { total, withData: recs.length, bedTotal, bedAvail, stale, highNeed, hh, tractTotal: tracts.length };
}
function renderOverviewTiles() {
  const el = $('gov-overview-tiles'); if (!el) return;
  const m = overviewModel();
  const tiles = [
    { label: 'Total Resources', value: m.total, sub: 'in the ReliefGrid network' },
    { label: 'Reporting Availability', value: m.withData, sub: 'resources sharing live capacity (demo)' },
    { label: 'Available Shelter Capacity', value: m.bedAvail, sub: `of ${m.bedTotal} tracked beds` },
    { label: 'High-Need Areas', value: m.highNeed, sub: `of ${m.tractTotal} tracts — top-quintile community need` },
    { label: 'High Need / Low Access', value: m.hh, sub: 'tracts in a statistically significant gap cluster' },
    { label: 'Stale Availability', value: m.stale, sub: 'reports older than 6 hours' },
  ];
  el.innerHTML = tiles.map(t => `<div class="metric-tile"><div class="metric-value">${escapeHtml(String(t.value))}</div><div class="metric-label">${escapeHtml(t.label)}</div><div class="metric-sub">${escapeHtml(t.sub)}</div></div>`).join('');
}
function renderOverviewLegend() {
  const el = $('gov-overview-legend'); if (!el) return;
  const layer = document.querySelector('input[name="gov-overview-layer"]:checked')?.value || 'mismatch_index';
  if (layer === 'none') { el.innerHTML = '<div class="muted small">Showing resource locations only.</div>'; return; }
  const [lo, mid, hi] = layer === 'access_index' ? [0, 50, 100] : [-2, 0, 2];
  el.innerHTML = `<div class="legend-row"><span>${escapeHtml(LAYER_LABELS[layer] || layer)}</span></div>
    <div class="gradient"></div><div class="gradient-labels"><span>${lo}</span><span>${mid}</span><span>${hi}</span></div>`;
}

/* ── Resource Network (old "resource map") ───────────────────────────── */
function wireNetworkControls() {
  const input = $('gov-network-search'), clearBtn = $('gov-network-search-clear'), resultsEl = $('gov-network-search-results');
  if (input) {
    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearBtn.style.display = q ? '' : 'none';
      if (q.length < 2) { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; return; }
      handleNetworkSearch(q);
    });
    clearBtn.addEventListener('click', () => { input.value = ''; clearBtn.style.display = 'none'; resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; });
    document.addEventListener('click', (e) => { if (!e.target.closest('.search-section')) resultsEl.classList.add('hidden'); });
  }
  $('gov-network-avail-toggle')?.addEventListener('change', e => { showAvailBadges = e.target.checked; setAvailabilityLayerVisibility(showAvailBadges && govPage === 'gov-network'); });
}
function renderNetworkCategoryFilters() {
  const container = $('gov-network-filter-list'); if (!container) return;
  container.innerHTML = Object.entries(RESOURCE_COLORS).map(([group, color]) => `
    <label class="layer-check-label" style="gap:8px">
      <input type="checkbox" data-group="${group}" ${networkCategoryFilters.has(group) ? 'checked' : ''}>
      ${resourceLegendIcon(group, color)}<span>${escapeHtml(RESOURCE_LABELS[group] || labelize(group))}</span>
    </label>`).join('');
  container.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) networkCategoryFilters.add(cb.dataset.group); else networkCategoryFilters.delete(cb.dataset.group);
    applyNetworkFilter();
  }));
}
function renderNetworkAvailFilters() {
  const box = $('gov-network-avail-filters'); if (!box) return;
  const withData = (AppState.facilitiesData?.features || []).filter(f => f.properties.avail_has_data).length;
  box.innerHTML = Object.entries(AVAIL_FILTERS).map(([key, label]) => `
    <label class="layer-check-label" style="gap:8px"><input type="checkbox" data-avail="${key}" ${networkAvailFilters.has(key) ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`).join('')
    + `<div class="muted small" style="margin-top:6px">${withData} of ${(AppState.facilitiesData?.features || []).length} resources are sharing availability in this demo.</div>`;
  box.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) networkAvailFilters.add(cb.dataset.avail); else networkAvailFilters.delete(cb.dataset.avail);
    applyNetworkFilter();
  }));
}
function renderNetworkAvailLegend() {
  const el = $('gov-network-avail-legend'); if (!el) return;
  el.innerHTML = `<div class="section-label">Availability status</div>` +
    ['available', 'limited', 'full', 'closed'].map(k => { const s = STATUS[k];
      return `<div class="legend-row"><span class="avail-dot" style="background:${s.color}">${s.short}</span><span>${escapeHtml(s.label)}</span></div>`; }).join('') +
    `<div class="legend-row muted small">No badge = availability not shared (Unknown)</div>`;
}
function renderNetworkCounts() {
  const counts = {};
  (AppState.facilitiesData?.features || []).forEach(f => { const g = f.properties.resource_group || 'other'; counts[g] = (counts[g] || 0) + 1; });
  const el = $('gov-network-counts'); if (!el) return;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  el.innerHTML = `<div class="section-label">Resource Counts</div>${sorted.map(([g, count]) => `
    <div class="legend-row">${resourceLegendIcon(g)}<span>${escapeHtml(RESOURCE_LABELS[g] || labelize(g))}</span><span class="muted" style="margin-left:auto;font-variant-numeric:tabular-nums">${count}</span></div>`).join('')}`;
}
function applyNetworkFilter() {
  const map = AppState.map; if (!map) return;
  const clauses = [];
  if (networkCategoryFilters.size !== Object.keys(RESOURCE_COLORS).length) clauses.push(['in', ['get', 'resource_group'], ['literal', [...networkCategoryFilters]]]);
  const predicates = {
    available_now: ['==', ['get', 'avail_status'], 'available'],
    accepting: ['==', ['get', 'avail_accepting'], true],
    shelter_beds: ['all', ['==', ['get', 'resource_group'], 'shelter'], ['>', ['get', 'avail_beds'], 0]],
    food: ['==', ['get', 'avail_food_flag'], true],
    open_now: ['==', ['get', 'avail_open_flag'], true],
  };
  networkAvailFilters.forEach(k => { if (predicates[k]) clauses.push(predicates[k]); });
  const filter = clauses.length === 0 ? null : clauses.length === 1 ? clauses[0] : ['all', ...clauses];
  ['facilities', 'facilities-status-bg', 'facilities-status-label'].forEach(id => {
    if (!map.getLayer(id)) return;
    if (id === 'facilities') map.setFilter(id, filter);
    else { const base = ['==', ['get', 'avail_has_data'], true]; map.setFilter(id, filter ? ['all', base, filter] : base); }
  });
}
function handleNetworkSearch(q) {
  const resultsEl = $('gov-network-search-results'); const lower = q.toLowerCase();
  const matches = (AppState.facilitiesData?.features || []).filter(f => {
    const p = f.properties;
    return (p.name || '').toLowerCase().includes(lower) || (p.resource_group || '').toLowerCase().includes(lower)
      || (p.address || '').toLowerCase().includes(lower) || (p.county || '').toLowerCase().includes(lower);
  }).slice(0, 8);
  if (!matches.length) { resultsEl.innerHTML = '<div class="search-empty">No results found.</div>'; resultsEl.classList.remove('hidden'); return; }
  resultsEl.innerHTML = matches.map((f, i) => `<button class="search-result-item" data-i="${i}">
    ${resourceLegendIcon(f.properties.resource_group)}<span class="search-result-name">${escapeHtml(f.properties.name || '(unnamed)')}</span>
    <span class="search-result-cat">${escapeHtml(RESOURCE_LABELS[f.properties.resource_group] || '')}</span></button>`).join('');
  resultsEl.classList.remove('hidden');
  resultsEl.querySelectorAll('.search-result-item').forEach(btn => btn.addEventListener('click', () => {
    const f = matches[parseInt(btn.dataset.i)];
    AppState.map.flyTo({ center: f.geometry.coordinates, zoom: 13, duration: 800 });
    openGovDetail(f.properties.facility_id);
    resultsEl.classList.add('hidden');
  }));
}

/* ── Gov resource detail panel (shared component, network + search) ────── */
export function openGovDetail(facilityId) {
  const feat = findFacilityFeature(facilityId); if (!feat) return;
  govDetailId = facilityId;
  $('gov-resource-detail')?.classList.remove('hidden');
  refreshGovDetail();
  if (AppState.map) AppState.map.flyTo({ center: feat.geometry.coordinates, zoom: Math.max(AppState.map.getZoom(), 12.5), duration: 650 });
}
function closeGovDetail() { govDetailId = null; $('gov-resource-detail')?.classList.add('hidden'); }
function refreshGovDetail() {
  if (!govDetailId) return;
  const feat = findFacilityFeature(govDetailId); const body = $('gov-resource-detail-body');
  if (!feat || !body) return;
  body.innerHTML = renderDetailBody(feat);
}
function renderDetailBody(feat) {
  const p = feat.properties, coords = feat.geometry?.coordinates;
  const rec = Availability.get(p.facility_id);
  const group = p.resource_group || 'other';
  const category = RESOURCE_LABELS[group] || labelize(group || p.type || 'Resource');
  const status = rec ? rec.status : 'unknown'; const s = STATUS[status];
  const heroSub = rec ? availabilityHeadline(rec, group) : 'No live availability shared yet — contact the provider to confirm.';
  const hero = `<div class="rd-status rd-status-${status}"><span class="rd-status-glyph" aria-hidden="true">${s.glyph}</span>
    <div class="rd-status-text"><div class="rd-status-label">${escapeHtml(s.label.toUpperCase())}</div><div class="rd-status-sub">${escapeHtml(heroSub)}</div></div></div>`;
  let keyInfo = '';
  if (rec) {
    const lines = availabilitySecondaryLines(rec, group);
    const msg = rec.raw.message ? `<div class="rd-message"><span aria-hidden="true">📣</span> ${escapeHtml(rec.raw.message)}</div>` : '';
    keyInfo = `${lines.length ? `<ul class="rd-keylist">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul>` : ''}${msg}`;
  }
  let updated = '';
  if (rec) {
    const provenance = rec.providerEntered ? 'Entered via the ReliefGrid provider portal (demo)' : rec.sourceKey === 'demo_simulation' ? 'Demo simulation' : `${rec.sourceLabel} · simulated`;
    updated = `<div class="rd-updated rd-fresh-${rec.freshness}"><div class="rd-updated-line"><strong>Updated ${escapeHtml(rec.relativeTime)}</strong><span class="rd-fresh-tag">${escapeHtml(FRESHNESS_LABELS[rec.freshness])}</span></div>
      <div class="rd-source">Source: ${escapeHtml(provenance)} · ${demoPillHTML()}</div>
      ${rec.freshness === 'stale' ? `<div class="rd-stale-warn"><span aria-hidden="true">⚠</span> This update is several hours old. Availability may have changed — contact the provider to confirm.</div>` : ''}</div>`;
  } else {
    updated = `<div class="rd-updated rd-fresh-unknown"><div class="rd-source">Availability not yet shared for this resource · ${demoPillHTML('Prototype')}</div></div>`;
  }
  const website = cleanUrl(p.website || p.source_url);
  const addressBlock = `<div class="rd-section"><div class="rd-section-label">Address &amp; directions</div><div>${escapeHtml(p.address || 'Address not listed in this dataset')}</div>
    <div class="rd-actions"><a class="btn btn-primary btn-sm" href="${escapeHtml(directionsUrl(coords, p.address))}" target="_blank" rel="noopener">Directions</a>
    ${website ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(website)}" target="_blank" rel="noopener">Website</a>` : ''}
    <button class="btn btn-ghost btn-sm" data-goto-provider="${escapeHtml(p.facility_id)}" type="button">Update as provider</button></div></div>`;
  const hours = p.opening_time ? `<div class="rd-section"><div class="rd-section-label">Hours</div><div>${escapeHtml(p.opening_time)}</div></div>` : '';
  const description = p.short_description ? `<div class="rd-section"><div class="rd-section-label">About</div><div>${escapeHtml(p.short_description)}</div></div>` : '';
  const contactBits = [p.county ? `${escapeHtml(p.county)} County` : '', p.verification_status ? `Listing ${escapeHtml(String(p.verification_status).toLowerCase())}` : ''].filter(Boolean).join(' · ');
  const contact = `<div class="rd-section"><div class="rd-section-label">Contact</div><div>${contactBits || 'See website or call the provider directly.'}</div></div>`;
  const html = `<div class="rd-head"><h3 class="rd-name">${escapeHtml(p.name || 'Unnamed resource')}</h3>
      <div class="rd-type">${resourceLegendIcon(group)}<span>${escapeHtml(category)}</span></div></div>
    ${hero}${keyInfo}${updated}${addressBlock}${hours}${description}${contact}`;
  requestAnimationFrame(() => {
    document.querySelectorAll('[data-goto-provider]').forEach(btn => btn.addEventListener('click', () => {
      window.__reliefgrid_gotoProvider?.(btn.dataset.gotoProvider);
    }));
  });
  return html;
}

/* ── Service Gaps (Community Need / Service Access / Service Gap) ───────── */
function wireGapsControls() {
  document.querySelectorAll('input[name="gov-gaps-layer"]').forEach(r => r.addEventListener('change', e => {
    gapsLayer = e.target.value; setMapLayer(gapsLayer); renderGapsLegend();
  }));
  $('gov-gaps-facilities-toggle')?.addEventListener('change', e => AppState.map?.setLayoutProperty('facilities', 'visibility', e.target.checked ? 'visible' : 'none'));
  document.querySelectorAll('#gov-gaps-mode-switch button').forEach(btn => btn.addEventListener('click', () => {
    if (btn.classList.contains('active')) return;
    AppState.mode = btn.dataset.mode;
    document.querySelectorAll('#gov-gaps-mode-switch button').forEach(b => b.classList.toggle('active', b === btn));
    AppState.map.getSource('tracts').setData(AppState.tractsData[AppState.mode]);
    renderGapsLegend();
  }));
  document.querySelectorAll('#panel-gov-gaps .info-toggle').forEach(wireInfoToggle);
  AppState.map?.on('click', 'tract-fill', (e) => { if (govPage === 'gov-gaps' && AppState.shell === 'gov') showGapsDetail(e.features[0]); });
  AppState.map?.on('mousemove', 'tract-fill', (e) => { AppState.map.setFilter('tract-hover', ['==', 'GEOID', e.features[0].properties.GEOID]); AppState.map.getCanvas().style.cursor = 'pointer'; });
  AppState.map?.on('mouseleave', 'tract-fill', () => { AppState.map.setFilter('tract-hover', ['==', 'GEOID', '']); AppState.map.getCanvas().style.cursor = ''; });
}
function renderGapsLegend() {
  const el = $('gov-gaps-legend'); if (!el) return;
  if (gapsLayer === 'lisa') {
    const counts = AppState.diagnostics[AppState.mode]?.lisa_counts?.mismatch_index || {};
    el.innerHTML = [['HH', 'High need / low access'], ['LL', 'Low need / high access'], ['HL', 'Isolated high-need'], ['LH', 'Isolated low-need'], ['ns', 'Not significant']]
      .map(([k, label]) => `<div class="legend-row"><span class="swatch" style="background:${{HH:'#d7191c',LL:'#2c7bb6',HL:'#fdae61',LH:'#abd9e9',ns:'#e0e0e0'}[k]}"></span><span>${k} <span class="muted">${label}</span></span><span class="muted" style="margin-left:auto">${counts[k] ?? 0}</span></div>`).join('');
  } else {
    const [lo, mid, hi] = gapsLayer === 'access_index' ? [0, 50, 100] : [-2, 0, 2];
    el.innerHTML = `<div class="legend-row"><span>${escapeHtml(LAYER_LABELS[gapsLayer] || gapsLayer)}</span></div><div class="gradient"></div><div class="gradient-labels"><span>${lo}</span><span>${mid}</span><span>${hi}</span></div>`;
  }
}
function tractInsight(p) {
  const lisa = p.lisa_mismatch_index_label || 'ns';
  if (lisa === 'HH') return { tag: 'Priority for review', tagClass: 'gap-tag-hh', headline: 'High need, low access',
    body: 'This area has relatively high housing-instability risk but comparatively limited access to homelessness-related services — and sits inside a broader cluster of similarly underserved neighborhoods, not an isolated data point.', action: 'Area for further service-planning review' };
  if (lisa === 'LL') return { tag: 'Currently well-served', tagClass: 'gap-tag-ll', headline: 'Lower need, strong access',
    body: 'This area has comparatively lower housing-instability risk and relatively strong access to nearby services, inside a cluster of similarly well-served neighborhoods.', action: null };
  if (lisa === 'HL') return { tag: 'Isolated high-need tract', tagClass: 'gap-tag-hl', headline: 'High need, but neighbors are not',
    body: 'This tract shows high housing-instability risk while its immediate neighbors do not — worth a closer look to confirm the pattern holds before treating it as a cluster.', action: null };
  if (lisa === 'LH') return { tag: 'Contextual', tagClass: 'gap-tag-lh', headline: 'Lower need, surrounded by higher-need areas',
    body: 'This tract itself shows lower measured need but sits among higher-need neighbors — access here may still matter to the surrounding area.', action: null };
  const needHigh = +p.need_score > 0, accessLow = +p.access_index < 50;
  return { tag: 'Not a significant cluster', tagClass: 'gap-tag-ns',
    headline: needHigh && accessLow ? 'Above-average need, below-average access' : needHigh ? 'Above-average need' : accessLow ? 'Below-average access' : 'Near typical need and access',
    body: 'This tract does not fall inside a statistically significant need/access cluster — read this pattern with more caution than the highlighted cluster areas.', action: null };
}
function showGapsDetail(feat) {
  const p = feat.properties; const el = $('gov-gaps-detail-body'); if (!el) return;
  const insight = tractInsight(p);
  const center = featureCentroid(feat);
  const nearest = center ? (AppState.facilitiesData?.features || [])
    .map(f => ({ p: f.properties, d: haversineKm(center[0], center[1], f.geometry.coordinates[0], f.geometry.coordinates[1]) }))
    .sort((a, b) => a.d - b.d).slice(0, 3) : [];
  el.innerHTML = `
    <div class="tract-header"><div class="tract-name">${escapeHtml(p.county_name || '—')} · Tract ${escapeHtml(p.GEOID || '—')}</div><span class="gap-tag ${insight.tagClass}">${escapeHtml(insight.tag)}</span></div>
    <p class="tract-lisa-long"><strong>${escapeHtml(insight.headline)}.</strong> ${escapeHtml(insight.body)}</p>
    ${insight.action ? `<div class="insight-card">${escapeHtml(insight.action)}</div>` : ''}
    <table>
      <tr><td>Community Need ${infoToggle('need', 'Community Need', 'A composite of poverty rate, rent burden, and renter share for this census tract, standardized so 0 is the regional average.')}</td><td>${number(p.need_score)}</td></tr>
      <tr><td>Service Access ${infoToggle('access', 'Service Access', 'Percentile rank (0–100) of resources reachable within a 15-minute catchment, weighted by competing household demand (E2SFCA method).')}</td><td>${number(p.access_index, 0)} / 100</td></tr>
      <tr><td>Service Gap ${infoToggle('gap', 'Service Gap', 'Community Need minus Service Access, both standardized. Positive = need exceeds access.')}</td><td>${number(p.mismatch_index)}</td></tr>
    </table>
    ${nearest.length ? `<h4 style="font-size:12px;font-weight:600;margin:10px 0 6px">Nearest resources</h4>${nearest.map(r => `<div class="nearest-row">${resourceLegendIcon(r.p.resource_group)}<span>${escapeHtml(r.p.name || '(unnamed)')} <span class="muted">${r.d.toFixed(1)} km</span></span></div>`).join('')}` : ''}`;
  document.querySelectorAll('#gov-gaps-detail-body .info-toggle').forEach(wireInfoToggle);
}
function infoToggle(id, title, text) {
  return `<button type="button" class="info-toggle" data-info="gaps-${id}" aria-expanded="false"><span aria-hidden="true">ⓘ</span></button><span class="info-panel hidden" id="info-gaps-${id}" role="note">${escapeHtml(text)}</span>`;
}
function wireInfoToggle(btn) {
  btn.addEventListener('click', () => {
    const panel = document.getElementById('info-' + btn.dataset.info); if (!panel) return;
    const open = !panel.classList.contains('hidden');
    panel.classList.toggle('hidden', open); btn.setAttribute('aria-expanded', String(!open));
  });
}

/* ── Capacity (exists vs. has availability) ─────────────────────────────── */
function wireCapacityControls() {
  $('gov-capacity-category-select')?.addEventListener('change', renderCapacity);
}
function capacityModel(categoryFilter) {
  const recs = Availability.all().filter(r => !categoryFilter || Availability.meta(r.facility_id)?.resource_group === categoryFilter);
  const metaAll = (AppState.facilitiesData?.features || []).filter(f => !categoryFilter || f.properties.resource_group === categoryFilter);
  const shelterRecs = recs.filter(r => Availability.meta(r.facility_id)?.resource_group === 'shelter');
  const bedTotal = shelterRecs.reduce((s, r) => s + (Number.isFinite(r.raw.total_capacity) ? r.raw.total_capacity : 0), 0);
  const bedAvail = shelterRecs.reduce((s, r) => s + (Number.isFinite(r.raw.available_capacity) ? r.raw.available_capacity : 0), 0);
  const openNow = recs.filter(r => r.raw.open_now !== false && r.status !== 'closed').length;
  const nearCapacity = recs.filter(r => r.status === 'full' || r.status === 'limited').length;
  const stale = recs.filter(r => r.freshness === 'stale').length;
  const statusByCat = {};
  recs.forEach(r => { const g = Availability.meta(r.facility_id)?.resource_group || 'other'; (statusByCat[g] ||= { available: 0, limited: 0, full: 0, closed: 0, unknown: 0 }); statusByCat[g][r.status]++; });
  const beds = { Nassau: { total: 0, avail: 0 }, Suffolk: { total: 0, avail: 0 } };
  shelterRecs.forEach(r => { const c = Availability.meta(r.facility_id)?.county; if (!beds[c]) return; beds[c].total += Number.isFinite(r.raw.total_capacity) ? r.raw.total_capacity : 0; beds[c].avail += Number.isFinite(r.raw.available_capacity) ? r.raw.available_capacity : 0; });
  return { total: metaAll.length, withData: recs.length, openNow, nearCapacity, stale, bedTotal, bedAvail, occupancy: bedTotal ? (bedTotal - bedAvail) / bedTotal : null, statusByCat, beds };
}
function availabilityGapAnalysis() {
  const feats = AppState.tractsData[AppState.mode]?.features || [];
  const needVals = feats.map(f => +f.properties.need_score).filter(Number.isFinite).sort((a, b) => a - b);
  if (!needVals.length) return null;
  const p67 = needVals[Math.floor(needVals.length * 0.67)];
  const availPoints = Availability.all().filter(r => r.status === 'available').map(r => Availability.meta(r.facility_id)?.coordinates).filter(Boolean);
  const buckets = { 0: 0, 1: 0, 2: 0, '3+': 0 }; const highNeed = [];
  feats.forEach(f => {
    const need = +f.properties.need_score; if (!Number.isFinite(need) || need < p67) return;
    const c = featureCentroid(f); if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return;
    let count = 0; availPoints.forEach(pt => { if (haversineKm(c[0], c[1], pt[0], pt[1]) <= 8) count++; });
    buckets[count >= 3 ? '3+' : String(count)]++;
    highNeed.push({ geoid: f.properties.GEOID, county: f.properties.county_name, need, count });
  });
  return { buckets, totalHigh: highNeed.length, noneNearby: highNeed.filter(h => h.count === 0).length, worst: highNeed.filter(h => h.count === 0).sort((a, b) => b.need - a.need).slice(0, 6) };
}
function renderCapacity() {
  if (!window.Chart) return;
  const cat = $('gov-capacity-category-select')?.value || '';
  const m = capacityModel(cat || null);
  const pct = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
  const tilesEl = $('gov-capacity-tiles');
  if (tilesEl) tilesEl.innerHTML = [
    { label: 'Resources in network', value: m.total, sub: `${m.withData} are currently reporting availability` },
    { label: 'Open right now', value: m.openNow, sub: 'resources reporting open status' },
    { label: 'Shelter beds available', value: m.bedAvail, sub: `of ${m.bedTotal} tracked emergency beds` },
    { label: 'Shelter occupancy', value: pct(m.occupancy), sub: 'across shelters reporting bed counts' },
    { label: 'At or near capacity', value: m.nearCapacity, sub: 'resources full or limited' },
    { label: 'Stale availability', value: m.stale, sub: 'updates older than 6 hours — unconfirmed' },
  ].map(t => `<div class="metric-tile"><div class="metric-value">${escapeHtml(String(t.value))}</div><div class="metric-label">${escapeHtml(t.label)}</div><div class="metric-sub">${escapeHtml(t.sub)}</div></div>`).join('');

  const cats = Object.keys(m.statusByCat); const statusOrder = ['available', 'limited', 'full', 'closed', 'unknown'];
  makeChart('capStatus', 'chart-gov-status', { type: 'bar',
    data: { labels: cats.map(c => RESOURCE_LABELS[c] || labelize(c)), datasets: statusOrder.map(st => ({ label: STATUS[st].label, data: cats.map(c => m.statusByCat[c][st] || 0), backgroundColor: STATUS[st].color })) },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } } });

  const counties = ['Nassau', 'Suffolk'];
  makeChart('capShelter', 'chart-gov-shelter', { type: 'bar',
    data: { labels: counties, datasets: [{ label: 'Available', data: counties.map(c => m.beds[c].avail), backgroundColor: STATUS.available.color }, { label: 'Occupied', data: counties.map(c => Math.max(0, m.beds[c].total - m.beds[c].avail)), backgroundColor: '#b45f06' }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } }, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } } });

  const gap = availabilityGapAnalysis();
  const headline = $('gov-capacity-gap-headline'), listEl = $('gov-capacity-gap-list');
  if (gap && headline) {
    const share = gap.totalHigh ? Math.round((gap.noneNearby / gap.totalHigh) * 100) : 0;
    headline.innerHTML = `<strong>${share}% of the highest-need neighborhoods (${gap.noneNearby} of ${gap.totalHigh} census tracts)</strong> currently have <strong>no resource showing availability</strong> within about a 15-minute drive. ${demoPillHTML()}`;
  }
  if (gap) makeChart('capGap', 'chart-gov-gap', { type: 'bar',
    data: { labels: ['0 available', '1', '2', '3 or more'], datasets: [{ label: 'High-need tracts', data: [gap.buckets['0'], gap.buckets['1'], gap.buckets['2'], gap.buckets['3+']], backgroundColor: ['#b91c1c', '#d97706', '#f6c453', '#1a7f37'], borderRadius: 3 }] },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'Resources showing availability within ~15-min drive' } }, y: { beginAtZero: true, ticks: { precision: 0 } } } } });
  if (gap && listEl) listEl.innerHTML = gap.worst.length ? `<div class="section-label" style="margin-top:14px">Highest-need tracts with no available resource nearby</div>
    <table class="gap-table"><thead><tr><th>Census tract</th><th>County</th><th>Need score</th></tr></thead><tbody>${gap.worst.map(w => `<tr><td>${escapeHtml(w.geoid || '—')}</td><td>${escapeHtml(w.county || '—')}</td><td>${w.need.toFixed(2)}</td></tr>`).join('')}</tbody></table>` : '';
}
function makeChart(key, canvasId, config) {
  const el = document.getElementById(canvasId); if (!el || !window.Chart) return;
  if (charts[key]) charts[key].destroy();
  charts[key] = new window.Chart(el, config);
}

/* ── Provider Updates ─────────────────────────────────────────────────── */
function wireProviderControls() {
  window.__reliefgrid_gotoProvider = (facilityId) => {
    window.__reliefgrid_navigateShell?.('gov', 'gov-provider');
    renderProviderPortal(facilityId);
  };
}
export function renderProviderPortal(preselectId) {
  const sel = $('gov-provider-resource-select'); if (!sel) return;
  if (!providerSelectPopulated) {
    const groups = {};
    (AppState.facilitiesData?.features || []).forEach(f => { const p = f.properties; (groups[p.resource_group] ||= []).push({ id: p.facility_id, name: p.name || p.facility_id }); });
    sel.innerHTML = Object.keys(groups).sort().map(g => `<optgroup label="${escapeHtml(RESOURCE_LABELS[g] || labelize(g))}">${groups[g].sort((a, b) => a.name.localeCompare(b.name)).map(o => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join('')}</optgroup>`).join('');
    providerSelectPopulated = true;
    sel.value = 'rhy:9457d87593';
    sel.addEventListener('change', () => buildProviderFields(sel.value));
    $('gov-provider-form')?.addEventListener('submit', onProviderSubmit);
    $('gov-provider-clear-one')?.addEventListener('click', onProviderRevertOne);
    $('gov-provider-reset-all')?.addEventListener('click', onProviderResetAll);
  }
  const valid = typeof preselectId === 'string' && [...sel.options].some(o => o.value === preselectId);
  if (valid) sel.value = preselectId;
  buildProviderFields(sel.value);
}
function buildProviderFields(facilityId) {
  const wrap = $('gov-provider-fields'); if (!wrap) return;
  const meta = Availability.meta(facilityId) || {}; const group = meta.resource_group || 'other';
  const rec = Availability.get(facilityId); const a = rec?.raw || {};
  const showBeds = group === 'shelter' || group === 'housing_support';
  const showFood = group === 'food';
  const showWait = ['health', 'behavioral_health', 'legal', 'public_benefits', 'outreach'].includes(group);
  const val = (v, d = '') => (v === undefined || v === null ? d : v);
  const checked = (b) => (b ? 'checked' : '');
  wrap.innerHTML = `
    <fieldset class="pf-group"><legend>Status</legend>
      <div class="pf-radio-row"><label><input type="radio" name="pf_open" value="open" ${checked(a.open_now !== false)}> Open now</label><label><input type="radio" name="pf_open" value="closed" ${checked(a.open_now === false)}> Closed</label></div>
      <div class="pf-radio-row"><label><input type="radio" name="pf_accepting" value="yes" ${checked(a.accepting_clients !== false)}> Accepting clients</label><label><input type="radio" name="pf_accepting" value="no" ${checked(a.accepting_clients === false)}> Not accepting</label></div>
    </fieldset>
    ${showBeds ? `<fieldset class="pf-group"><legend>Beds / units</legend>
      <label class="pf-field pf-inline"><span class="pf-label">Total capacity</span><input type="number" min="0" name="pf_total" value="${escapeHtml(String(val(a.total_capacity)))}"></label>
      <label class="pf-field pf-inline"><span class="pf-label">Available now</span><input type="number" min="0" name="pf_available" value="${escapeHtml(String(val(a.available_capacity)))}"></label></fieldset>` : ''}
    ${showFood ? `<fieldset class="pf-group"><legend>Food inventory</legend>
      <label class="pf-field pf-inline"><span class="pf-label">Meal packages available</span><input type="number" min="0" name="pf_meals" value="${escapeHtml(String(val(a.meals_available)))}"></label>
      <label class="pf-field"><span class="pf-label">Next distribution</span><input type="text" name="pf_next" maxlength="80" value="${escapeHtml(String(val(a.next_service_time)))}" placeholder="e.g. Today 4:00 PM"></label></fieldset>` : ''}
    ${showWait ? `<fieldset class="pf-group"><legend>Access</legend>
      <label class="pf-field pf-inline"><span class="pf-label">Estimated wait (minutes)</span><input type="number" min="0" name="pf_wait" value="${escapeHtml(String(val(a.wait_minutes)))}"></label>
      <label class="layer-check-label"><input type="checkbox" name="pf_walkins" ${checked(a.walk_ins === true)}> Accepting walk-ins</label></fieldset>` : ''}
    <label class="pf-field"><span class="pf-label">Temporary message (optional)</span><input type="text" name="pf_message" maxlength="140" value="${escapeHtml(String(val(a.message)))}" placeholder="Short note shown to people seeking help"></label>`;
  refreshProviderPreview();
}
function readProviderForm() {
  const form = $('gov-provider-form'); const fd = new FormData(form); const patch = {};
  patch.open_now = fd.get('pf_open') === 'open';
  patch.accepting_clients = fd.get('pf_accepting') === 'yes';
  const num = (name) => { const raw = fd.get(name); if (raw === null || raw === '') return undefined; const n = Number(raw); return Number.isFinite(n) ? n : undefined; };
  const t = num('pf_total'); if (t !== undefined) patch.total_capacity = t;
  const av = num('pf_available'); if (av !== undefined) patch.available_capacity = av;
  const me = num('pf_meals'); if (me !== undefined) patch.meals_available = me;
  const w = num('pf_wait'); if (w !== undefined) patch.wait_minutes = w;
  if (form.querySelector('input[name="pf_walkins"]')) patch.walk_ins = fd.get('pf_walkins') === 'on';
  const next = (fd.get('pf_next') || '').trim(); if (next) patch.next_service_time = next;
  patch.message = (fd.get('pf_message') || '').trim();
  return patch;
}
async function onProviderSubmit(e) {
  e.preventDefault();
  const id = $('gov-provider-resource-select').value;
  await Availability.applyProviderUpdate(id, readProviderForm());
  showProviderToast('Availability updated. It is now live in Find Help and every ReliefGrid dashboard.');
  refreshProviderPreview(); renderProviderLog();
}
async function onProviderRevertOne() {
  const id = $('gov-provider-resource-select').value;
  await Availability.clearProviderUpdate(id);
  buildProviderFields(id); showProviderToast('Reverted to demo / upstream data for this resource.'); renderProviderLog();
}
async function onProviderResetAll() {
  await Availability.resetProviderUpdates();
  buildProviderFields($('gov-provider-resource-select').value); showProviderToast('All provider updates cleared.'); renderProviderLog();
}
function showProviderToast(msg) {
  const el = $('gov-provider-toast'); if (!el) return;
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(showProviderToast._t);
  showProviderToast._t = setTimeout(() => el.classList.add('hidden'), 4200);
}
function refreshProviderPreview() {
  const card = $('gov-provider-preview-card'); const sel = $('gov-provider-resource-select'); if (!card || !sel) return;
  const feat = findFacilityFeature(sel.value); if (!feat) { card.innerHTML = ''; return; }
  const rec = Availability.get(sel.value); const status = rec ? rec.status : 'unknown'; const s = STATUS[status];
  card.innerHTML = `<div class="pp-card"><div class="pp-name">${escapeHtml(feat.properties.name || '')}</div>
    <div class="rd-status rd-status-${status}" style="margin:8px 0"><span class="rd-status-glyph" aria-hidden="true">${s.glyph}</span>
      <div class="rd-status-text"><div class="rd-status-label">${escapeHtml(s.label.toUpperCase())}</div><div class="rd-status-sub">${escapeHtml(rec ? availabilityHeadline(rec, feat.properties.resource_group) : 'No availability shared')}</div></div></div>
    ${rec ? `<div class="muted small">Updated ${escapeHtml(rec.relativeTime)} · ${escapeHtml(rec.sourceLabel)} · ${demoPillHTML()}</div>` : ''}</div>`;
  renderProviderLog();
}
function renderProviderLog() {
  const log = $('gov-provider-update-log'); if (!log) return;
  const updates = Availability.listProviderUpdates();
  if (!updates.length) { log.innerHTML = '<div class="muted small">No updates yet. Changes you submit appear here and persist in this browser.</div>'; return; }
  log.innerHTML = updates.sort((a, b) => new Date(b.last_updated) - new Date(a.last_updated)).map(u => {
    const meta = Availability.meta(u.facility_id) || {};
    const mins = (Date.now() - new Date(u.last_updated).getTime()) / 60000;
    return `<div class="provider-log-row"><span>${escapeHtml(meta.name || u.facility_id)}</span><span class="muted small">${mins < 1 ? 'just now' : Math.round(mins) + ' min ago'}</span></div>`;
  }).join('');
}

/* ── Availability change propagation ─────────────────────────────────────── */
function onGovAvailabilityChanged() {
  pushFacilitiesToMap();
  if (govPage === 'gov-network') { renderNetworkAvailFilters(); renderNetworkCounts(); }
  if (govPage === 'gov-overview') renderOverviewTiles();
  if (govDetailId) refreshGovDetail();
  if (govPage === 'gov-capacity') renderCapacity();
  if (document.getElementById('page-gov-provider')?.classList.contains('active')) refreshProviderPreview();
}

export function getGovPage() { return govPage; }
