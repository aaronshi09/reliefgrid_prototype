/* ============================================================================
 * ReliefGrid — shared constants, data loading, map plumbing, utilities.
 * ----------------------------------------------------------------------------
 * Both the seeker (consumer) shell and the provider/government dashboard share
 * ONE MapLibre map instance and ONE facilities/tract dataset. This module owns
 * that shared substrate so js/seeker.js and js/gov.js stay focused on
 * presentation for their own audience.
 * ==========================================================================*/
import maplibregl from 'maplibre-gl';
import { Availability, STATUS, FRESHNESS_LABELS } from '../services/availability.js';

/* ── Map constants ─────────────────────────────────────────────────────── */
export const LONG_ISLAND_CENTER = [-73.05, 40.84];
export const LONG_ISLAND_ZOOM = 8.9;

export const LISA_COLORS = { HH: '#d7191c', LL: '#2c7bb6', HL: '#fdae61', LH: '#abd9e9', ns: '#e0e0e0' };

export const RESOURCE_COLORS = {
  food: '#4f9a45', shelter: '#b45f06', outreach: '#674ea7',
  legal: '#1f78b4', housing_support: '#8c6d31', behavioral_health: '#c51b7d',
  public_benefits: '#00a6a6', health: '#6a51a3', other: '#666666',
};

export const RESOURCE_LABELS = {
  food: 'Food Pantry / Food Bank', shelter: 'Emergency Shelter',
  outreach: 'Outreach & Day Services', legal: 'Legal Aid',
  housing_support: 'Housing Support', behavioral_health: 'Mental Health',
  public_benefits: 'Public Benefits', health: 'Healthcare', other: 'Other',
};

export const ICON_SVGS = {
  shelter:           '<path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/>',
  food:              '<path d="M11 9H9V2H7v7H5V2H3v7c0 2.12 1.66 3.84 3.75 3.97V22h2.5v-9.03C11.34 12.84 13 11.12 13 9V2h-2v7zm5-3v8h2.5v8H21V2c-2.76 0-5 2.24-5 4z"/>',
  health:            '<path d="M19 11h-6V5h-2v6H5v2h6v6h2v-6h6z"/>',
  legal:             '<path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5z"/>',
  housing_support:   '<path d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>',
  behavioral_health: '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>',
  public_benefits:   '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>',
  outreach:          '<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>',
  other:             '<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>',
};

export const CONT_STOPS = {
  mismatch_index: [-2, 0, 2], need_score: [-2, 0, 2], access_index: [0, 50, 100],
};
export const LAYER_LABELS = {
  mismatch_index: 'Service Gap', need_score: 'Community Need', access_index: 'Service Access',
};

/* Seeker-facing "what do you need" taxonomy. `group` maps to one or more
 * resource_group values in longisland_facilities.geojson. */
export const SEEKER_CATEGORIES = [
  { id: 'shelter',            label: 'Shelter',                 groups: ['shelter'],            icon: 'shelter' },
  { id: 'food',                label: 'Food',                    groups: ['food'],                icon: 'food' },
  { id: 'health',               label: 'Healthcare',              groups: ['health'],              icon: 'health' },
  { id: 'behavioral_health',  label: 'Mental Health',           groups: ['behavioral_health'],  icon: 'behavioral_health' },
  { id: 'legal',                label: 'Legal Help',              groups: ['legal'],               icon: 'legal' },
  { id: 'housing_support',    label: 'Housing Support',         groups: ['housing_support'],    icon: 'housing_support' },
  { id: 'outreach',            label: 'Hygiene & Day Services', groups: ['outreach'],            icon: 'outreach' },
  { id: 'other',                label: 'Other Services',          groups: ['public_benefits', 'other'], icon: 'other' },
];
export function categoryForGroup(group) {
  return SEEKER_CATEGORIES.find(c => c.groups.includes(group)) || null;
}

/* Small, honestly-labelled prototype location lookup — NOT a geocoder. Lets a
 * demo show "near me" behaviour for a typed town name without pretending we
 * have address-level geocoding. Coordinates are approximate town centres. */
export const LI_TOWN_COORDS = {
  'hempstead': [-73.618, 40.706], 'freeport': [-73.583, 40.657], 'long beach': [-73.658, 40.588],
  'mineola': [-73.640, 40.749], 'garden city': [-73.635, 40.727], 'glen cove': [-73.633, 40.863],
  'great neck': [-73.728, 40.800], 'levittown': [-73.514, 40.726], 'oyster bay': [-73.532, 40.865],
  'bethpage': [-73.482, 40.744], 'massapequa': [-73.474, 40.678], 'huntington': [-73.425, 40.868],
  'babylon': [-73.326, 40.696], 'islip': [-73.211, 40.730], 'bay shore': [-73.245, 40.725],
  'patchogue': [-73.016, 40.767], 'brentwood': [-73.246, 40.781], 'smithtown': [-73.202, 40.855],
  'riverhead': [-72.661, 40.917], 'southampton': [-72.389, 40.884], 'east hampton': [-72.183, 40.964],
  'port jefferson': [-73.068, 40.947], 'ronkonkoma': [-73.115, 40.828], 'central islip': [-73.201, 40.792],
  'amityville': [-73.417, 40.673], 'farmingdale': [-73.446, 40.732], 'sayville': [-73.083, 40.744],
  'wantagh': [-73.510, 40.683], 'valley stream': [-73.706, 40.665], 'hicksville': [-73.525, 40.768],
};
export function lookupTown(text) {
  const key = String(text || '').trim().toLowerCase().replace(/,.*$/, '').trim();
  if (LI_TOWN_COORDS[key]) return LI_TOWN_COORDS[key];
  const hit = Object.keys(LI_TOWN_COORDS).find(t => key.includes(t) || t.includes(key));
  return hit ? LI_TOWN_COORDS[hit] : null;
}

/* ── Shared mutable app state ────────────────────────────────────────────── */
export const AppState = {
  map: null,
  mode: 'drive',              // travel mode for the research layers: 'drive' | 'walk'
  shell: 'landing',           // 'landing' | 'seeker' | 'gov'
  tractsData: { drive: null, walk: null },
  facilitiesData: null,
  diagnostics: { drive: null, walk: null },
  districtsData: null,
};

/* ── Data loading ─────────────────────────────────────────────────────────── */
export async function loadAll() {
  const [td, tw, fac, dd, dw, dist] = await Promise.all([
    fetch('./tracts_drive_diagnostics.geojson').then(r => r.json()),
    fetch('./tracts_walk_diagnostics.geojson').then(r => r.json()),
    fetch('./longisland_facilities.geojson').then(r => r.json()),
    fetch('./diagnostics_drive.json').then(r => r.json()),
    fetch('./diagnostics_walk.json').then(r => r.json()),
    fetch('./homeless_students_districts.geojson').then(r => r.json()),
  ]);
  AppState.tractsData.drive = td; AppState.tractsData.walk = tw;
  AppState.facilitiesData = fac;
  AppState.diagnostics.drive = dd; AppState.diagnostics.walk = dw;
  AppState.districtsData = dist;
}

/* ── Map init ─────────────────────────────────────────────────────────────── */
export function initMap() {
  AppState.map = new maplibregl.Map({
    container: 'map',
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    center: LONG_ISLAND_CENTER, zoom: LONG_ISLAND_ZOOM, maxZoom: 15, minZoom: 8,
  });
  AppState.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  return AppState.map;
}

export function lisaColorExpr() {
  return ['match', ['get', 'lisa_mismatch_index_label'], 'HH', LISA_COLORS.HH, 'LL', LISA_COLORS.LL,
    'HL', LISA_COLORS.HL, 'LH', LISA_COLORS.LH, LISA_COLORS.ns];
}
export function continuousExpr(varName) {
  const [lo, mid, hi] = CONT_STOPS[varName];
  return ['case', ['==', ['get', varName], null], '#d0d0d0',
    ['interpolate', ['linear'], ['get', varName], lo, 'rgb(43,140,190)', mid, 'rgb(247,247,247)', hi, 'rgb(227,74,51)']];
}
export function availStatusColorExpr() {
  return ['match', ['get', 'avail_status'],
    'available', STATUS.available.color, 'limited', STATUS.limited.color,
    'full', STATUS.full.color, 'closed', STATUS.closed.color, STATUS.unknown.color];
}

export async function initMapLayers() {
  const map = AppState.map;
  await loadResourceIcons();

  map.addSource('tracts', { type: 'geojson', data: AppState.tractsData[AppState.mode] });
  map.addSource('facilities', { type: 'geojson', data: AppState.facilitiesData });
  map.addSource('districts', { type: 'geojson', data: AppState.districtsData });
  map.addSource('user-location', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({ id: 'tract-fill', type: 'fill', source: 'tracts', paint: { 'fill-color': lisaColorExpr(), 'fill-opacity': 0.7 } });
  map.addLayer({ id: 'tract-hover', type: 'line', source: 'tracts', paint: { 'line-color': '#000', 'line-width': 2 }, filter: ['==', 'GEOID', ''] });
  map.addLayer({ id: 'tract-stroke', type: 'line', source: 'tracts', paint: { 'line-color': '#555', 'line-width': 0.25, 'line-opacity': 0.5 } });
  map.addLayer({
    id: 'districts-fill', type: 'fill', source: 'districts', layout: { visibility: 'none' },
    paint: {
      'fill-color': ['interpolate', ['linear'], ['get', 'homeless_k12_avg'],
        0, 'rgba(255,255,204,0.75)', 50, 'rgba(254,217,118,0.75)', 150, 'rgba(253,141,60,0.8)',
        400, 'rgba(240,59,32,0.85)', 1300, 'rgba(128,0,38,0.9)'],
      'fill-outline-color': '#333',
    },
  });
  map.addLayer({ id: 'districts-stroke', type: 'line', source: 'districts', layout: { visibility: 'none' }, paint: { 'line-color': '#222', 'line-width': 0.6, 'line-opacity': 0.7 } });

  map.addLayer({
    id: 'facilities', type: 'symbol', source: 'facilities',
    layout: {
      'icon-image': ['match', ['get', 'resource_group'],
        'food', 'icon-food', 'shelter', 'icon-shelter', 'outreach', 'icon-outreach',
        'legal', 'icon-legal', 'housing_support', 'icon-housing_support',
        'behavioral_health', 'icon-behavioral_health', 'public_benefits', 'icon-public_benefits',
        'health', 'icon-health', 'icon-other'],
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        8, ['case', ['==', ['get', 'is_access_resource'], true], 0.52, 0.36],
        13, ['case', ['==', ['get', 'is_access_resource'], true], 0.90, 0.64]],
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': ['case', ['==', ['get', 'is_access_resource'], true], 1.0, 0.72] },
  });

  map.addLayer({
    id: 'facilities-status-bg', type: 'circle', source: 'facilities', layout: { visibility: 'none' },
    filter: ['==', ['get', 'avail_has_data'], true],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 13, 8.5],
      'circle-color': availStatusColorExpr(), 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.6,
      'circle-translate': [9, -9],
    },
  });
  map.addLayer({
    id: 'facilities-status-label', type: 'symbol', source: 'facilities',
    layout: {
      visibility: 'none',
      'text-field': ['match', ['get', 'avail_status'], 'available', 'A', 'limited', 'L', 'full', 'F', 'closed', 'C', '?'],
      'text-font': ['Open Sans Bold', 'Open Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 8, 13, 11],
      'text-allow-overlap': true, 'text-ignore-placement': true,
    },
    filter: ['==', ['get', 'avail_has_data'], true],
    paint: { 'text-color': '#ffffff', 'text-translate': [9, -9] },
  });

  map.addLayer({
    id: 'user-location-dot', type: 'circle', source: 'user-location',
    paint: { 'circle-radius': 8, 'circle-color': '#1a73e8', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 },
  });

  // Clicking a resource marker means something different per shell (open the
  // seeker detail page vs. the gov resource-detail panel), so this only
  // dispatches a DOM event — main.js listens and routes it by AppState.shell.
  const openFromFeature = (e) => {
    const p = e.features[0].properties;
    if (p.facility_id) document.dispatchEvent(new CustomEvent('rg:facility-click', { detail: { facilityId: p.facility_id } }));
  };
  ['facilities', 'facilities-status-bg', 'facilities-status-label'].forEach(layerId => {
    map.on('click', layerId, openFromFeature);
    map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
  });
}

export function setAvailabilityLayerVisibility(on) {
  const map = AppState.map; if (!map) return;
  const v = on ? 'visible' : 'none';
  ['facilities-status-bg', 'facilities-status-label'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v); });
}
export function setMapLayer(key) {
  const map = AppState.map; if (!map) return;
  map.setPaintProperty('tract-fill', 'fill-color', key === 'lisa' ? lisaColorExpr() : continuousExpr(key));
}
export function setUserLocationMarker(coords) {
  const map = AppState.map; if (!map || !map.getSource('user-location')) return;
  const features = coords ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: {} }] : [];
  map.getSource('user-location').setData({ type: 'FeatureCollection', features });
}

/* ── Availability ⇄ facilities plumbing (used by both shells) ───────────── */
export function enrichFacilitiesWithAvailability() {
  (AppState.facilitiesData?.features || []).forEach(f => {
    const p = f.properties;
    const rec = Availability.get(p.facility_id);
    p.avail_has_data  = !!rec;
    p.avail_status    = rec ? rec.status : 'unknown';
    p.avail_accepting = !!(rec && rec.raw.accepting_clients === true);
    p.avail_open_flag = !!(rec && rec.raw.open_now !== false && rec.status !== 'closed');
    p.avail_beds      = (rec && Number.isFinite(rec.raw.available_capacity)) ? rec.raw.available_capacity : -1;
    p.avail_food_flag = !!(rec && p.resource_group === 'food'
      && (rec.status === 'available' || (Number.isFinite(rec.raw.meals_available) && rec.raw.meals_available > 0)));
    p.avail_walkins   = !!(rec && rec.raw.walk_ins === true);
    p.avail_fresh     = rec ? rec.freshness : 'unknown';
  });
}
export function pushFacilitiesToMap() {
  if (AppState.map && AppState.map.getSource('facilities')) AppState.map.getSource('facilities').setData(AppState.facilitiesData);
}
export function findFacilityFeature(facilityId) {
  return (AppState.facilitiesData?.features || []).find(f => f.properties.facility_id === facilityId) || null;
}

const NEXT_SERVICE_LABEL = { food: 'Next distribution', health: 'Next open slot', behavioral_health: 'Next open slot', legal: 'Intake' };

export function availabilityHeadline(rec, group) {
  const a = rec.raw;
  if (Number.isFinite(a.available_capacity) && Number.isFinite(a.total_capacity)) {
    return `${a.available_capacity} of ${a.total_capacity} beds currently available`;
  }
  if (Number.isFinite(a.meals_available)) {
    return a.meals_available > 0 ? `${a.meals_available} meal ${a.meals_available === 1 ? 'package' : 'packages'} available` : 'No packages left for today';
  }
  if (a.walk_ins === true) return Number.isFinite(a.wait_minutes) ? `Accepting walk-ins · about ${a.wait_minutes} min wait` : 'Accepting walk-ins';
  if (a.walk_ins === false) return 'By appointment only right now';
  if (a.open_now === false) return a.next_service_time ? `Closed now · ${a.next_service_time}` : 'Closed right now';
  if (a.accepting_clients === true) return 'Accepting new clients';
  if (a.accepting_clients === false) return 'Not accepting new clients right now';
  return STATUS[rec.status]?.label || 'Status shared';
}
export function availabilitySecondaryLines(rec, group) {
  const a = rec.raw; const out = [];
  if ((Number.isFinite(a.available_capacity) || Number.isFinite(a.meals_available)) && typeof a.accepting_clients === 'boolean') {
    out.push(a.accepting_clients ? 'Accepting new clients' : 'Not accepting new clients');
  }
  if (a.next_service_time) out.push(`${NEXT_SERVICE_LABEL[group] || 'Next'}: ${a.next_service_time}`);
  if (Number.isFinite(a.wait_minutes) && a.walk_ins !== true) out.push(`Estimated wait: ${a.wait_minutes} min`);
  return out;
}
export function openLabel(rec) {
  if (!rec) return 'Hours unknown';
  if (rec.raw.open_now === false) return 'Closed';
  if (rec.raw.open_now === true) return 'Open';
  return 'Hours unknown';
}
export function statusChipHTML(status, size = '') {
  const s = STATUS[status] || STATUS.unknown;
  return `<span class="status-chip ${size}" style="background:${s.bg};color:${s.fg}"><span class="status-chip-glyph" aria-hidden="true">${s.glyph}</span>${escapeHtml(s.label)}</span>`;
}
export function demoPillHTML(text = 'Demo data') { return `<span class="demo-pill">${escapeHtml(text)}</span>`; }

/* ── Generic utilities ────────────────────────────────────────────────────── */
export function percent(x, d = 1) { return (x == null || isNaN(x)) ? '—' : (x * 100).toFixed(d) + '%'; }
export function number(x, d = 2) { return (x == null || isNaN(x)) ? '—' : (+x).toFixed(d); }
export function labelize(s) { return String(s || '').replaceAll('_', ' '); }
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function cleanUrl(raw) {
  if (!raw) return '';
  const first = String(raw).split(/[\s;,]+/).find(t => /^https?:\/\//i.test(t));
  return first || '';
}
export function directionsUrl(coords, address) {
  if (address) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
  if (Array.isArray(coords)) return `https://www.google.com/maps/dir/?api=1&destination=${coords[1]},${coords[0]}`;
  return '#';
}
export function haversineKm(lng1, lat1, lng2, lat2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
export function kmToMiles(km) { return km * 0.621371; }
export function featureCentroid(feat) {
  try {
    const coords = feat.geometry.coordinates[0];
    const lng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    return [lng, lat];
  } catch (_) { return null; }
}
export function nearestFacilities(fromCoords, n = 3, filterFn = null) {
  if (!fromCoords) return [];
  return (AppState.facilitiesData?.features || [])
    .filter(f => !filterFn || filterFn(f))
    .map(f => ({ feature: f, distKm: haversineKm(fromCoords[0], fromCoords[1], f.geometry.coordinates[0], f.geometry.coordinates[1]) }))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, n);
}

/* ── Resource marker icons (rasterised SVGs added to the MapLibre style) ─── */
export function buildIconSVG(iconContent, bgColor, size = 40) {
  const r = size / 2 - 1, cx = size / 2, iconPx = size * 0.56, offset = (size - iconPx) / 2, scale = iconPx / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${cx}" cy="${cx}" r="${r}" fill="white"/>` +
    `<circle cx="${cx}" cy="${cx}" r="${r - 2.5}" fill="${bgColor}"/>` +
    `<g transform="translate(${offset.toFixed(2)},${offset.toFixed(2)}) scale(${scale.toFixed(4)})" fill="white">${iconContent}</g></svg>`;
}
export function resourceLegendIcon(group, color, size = 20) {
  const bgColor = color || RESOURCE_COLORS[group] || RESOURCE_COLORS.other;
  const path = ICON_SVGS[group] || ICON_SVGS.other;
  const r = size / 2 - 1, cx = size / 2, iconPx = size * 0.56, offset = (size - iconPx) / 2, scale = iconPx / 24;
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">` +
    `<circle cx="${cx}" cy="${cx}" r="${r}" fill="white"/>` +
    `<circle cx="${cx}" cy="${cx}" r="${r - 1.5}" fill="${bgColor}"/>` +
    `<g transform="translate(${offset.toFixed(2)},${offset.toFixed(2)}) scale(${scale.toFixed(4)})" fill="white">${path}</g></svg>`;
}
export async function loadResourceIcons() {
  const size = 40;
  const promises = Object.entries(RESOURCE_COLORS).map(([group, color]) => new Promise((resolve) => {
    const svg = buildIconSVG(ICON_SVGS[group] || ICON_SVGS.other, color, size);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image(size, size);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      try { if (!AppState.map.hasImage(`icon-${group}`)) AppState.map.addImage(`icon-${group}`, ctx.getImageData(0, 0, size, size)); } catch (_) {}
      resolve();
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
    img.src = url;
  }));
  await Promise.all(promises);
}

export { Availability, STATUS, FRESHNESS_LABELS };
