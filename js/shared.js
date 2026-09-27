/* ============================================================================
 * ReliefGrid — shared constants, data loading, map plumbing, utilities.
 * ----------------------------------------------------------------------------
 * Both the seeker (consumer) shell and the provider/government dashboard share
 * ONE MapLibre map instance and ONE facilities/tract dataset. This module owns
 * that shared substrate so js/seeker.js and js/gov.js stay focused on
 * presentation for their own audience.
 *
 * Pure (browser-independent) pieces — the resource taxonomy and the geo /
 * interpretation helpers — live in js/core/ so the server-side AI layer runs
 * the exact same code. They are re-exported from here so existing imports
 * keep working unchanged.
 * ==========================================================================*/
import maplibregl from 'maplibre-gl';
import { Availability, STATUS, FRESHNESS_LABELS } from '../services/availability.js';
import { RESOURCE_LABELS, SEEKER_CATEGORIES, categoryForGroup } from './core/taxonomy.js';
import { haversineKm, kmToMiles, featureCentroid, robustCentroid, featuresBounds, nearestFrom, tractInsight, LISA_LABELS } from './core/analysis.js';

export { RESOURCE_LABELS, SEEKER_CATEGORIES, categoryForGroup };
export { haversineKm, kmToMiles, featureCentroid, robustCentroid, featuresBounds, tractInsight, LISA_LABELS };

/* ── Map constants ─────────────────────────────────────────────────────── */
export const LONG_ISLAND_CENTER = [-73.05, 40.84];
export const LONG_ISLAND_ZOOM = 8.9;

/* Colours are tuned for the dark basemap; semantics are unchanged from the
 * original ColorBrewer scheme (warm = high need / low access, blue = the
 * opposite, muted = not statistically significant). */
export const LISA_COLORS = { HH: '#f0645a', LL: '#3d8bfd', HL: '#f2a65a', LH: '#7cc4e8', ns: 'rgba(120,138,168,0.16)' };

export const RESOURCE_COLORS = {
  food: '#6fcf97', shelter: '#f2a65a', outreach: '#b7a3e6',
  legal: '#6cb6ff', housing_support: '#d9b77e', behavioral_health: '#f28cb4',
  public_benefits: '#4fd6cb', health: '#9ea9ff', other: '#9aa7b8',
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
  mismatch_index: 'Service Gap', need_score: 'Community Need', access_index: 'Service Access', lisa: 'Service Gap Clusters',
};

/* Continuous ramps. Diverging layers pivot on a dark neutral (not white) so
 * the basemap stays readable; Service Access is sequential (dark → cyan). */
const RAMPS = {
  diverging: ['#2f7fd8', '#1b2536', '#f0645a'],
  sequential: ['#0f1a2c', '#1f6fae', '#5fe0ff'],
};
function rampFor(varName) { return varName === 'access_index' ? RAMPS.sequential : RAMPS.diverging; }
/** CSS gradient matching the map ramp for a layer (used by every legend). */
export function layerGradientCSS(varName) {
  const [a, b, c] = rampFor(varName);
  return `linear-gradient(to right, ${a}, ${b}, ${c})`;
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
  if (!key) return null;
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

/* ── Motion ───────────────────────────────────────────────────────────── */
export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
/** Camera animation duration that honours prefers-reduced-motion. */
export function motion(ms) { return prefersReducedMotion() ? 0 : ms; }

/* ── Data loading ─────────────────────────────────────────────────────────── */
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url} (${r.status})`);
  return r.json();
}
export async function loadAll() {
  const [td, tw, fac, dd, dw, dist] = await Promise.all([
    fetchJSON('./tracts_drive_diagnostics.geojson'),
    fetchJSON('./tracts_walk_diagnostics.geojson'),
    fetchJSON('./longisland_facilities.geojson'),
    fetchJSON('./diagnostics_drive.json'),
    fetchJSON('./diagnostics_walk.json'),
    fetchJSON('./homeless_students_districts.geojson'),
  ]);
  AppState.tractsData.drive = td; AppState.tractsData.walk = tw;
  AppState.facilitiesData = fac;
  AppState.diagnostics.drive = dd; AppState.diagnostics.walk = dw;
  AppState.districtsData = dist;
}

/* ── Map init ─────────────────────────────────────────────────────────────── */
const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

export function initMap() {
  AppState.map = new maplibregl.Map({
    container: 'map',
    style: BASEMAP_STYLE,
    // Phones need slightly more zoom-out room to fit all of Long Island.
    center: LONG_ISLAND_CENTER, zoom: LONG_ISLAND_ZOOM, maxZoom: 15, minZoom: window.innerWidth < 600 ? 7 : 8,
    attributionControl: { compact: true },
    maxPitch: 50,
    fadeDuration: prefersReducedMotion() ? 0 : 200,
  });
  AppState.map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'top-right');
  window.addEventListener('resize', () => AppState.map?.setMinZoom(window.innerWidth < 600 ? 7 : 8));
  return AppState.map;
}

/* Re-tint the Carto Dark Matter basemap into ReliefGrid's navy palette:
 * subdued roads, low-contrast labels, water slightly bluer than land, POIs
 * removed. Purely cosmetic — every step is best-effort. */
const MAP_THEME = {
  background: '#060b15', land: '#0a111e', water: '#0b1a2e', waterLine: '#0e2037',
  building: '#0d1524', roadMinor: '#121c2d', roadMajor: '#18253a', motorway: '#1d2d46',
  boundary: '#2a3b58', placeText: '#6f7e98', minorText: '#4b5972', waterText: '#34506f', halo: '#060b15',
};
export function applyBasemapTheme(map) {
  const style = map.getStyle(); if (!style || !style.layers) return;
  const set = (id, prop, val) => { try { map.setPaintProperty(id, prop, val); } catch (_) {} };
  const hide = (id) => { try { map.setLayoutProperty(id, 'visibility', 'none'); } catch (_) {} };
  style.layers.forEach(l => {
    const id = l.id;
    if (l.type === 'background') { set(id, 'background-color', MAP_THEME.background); return; }
    if (l.type === 'fill') {
      if (/water/.test(id)) set(id, 'fill-color', MAP_THEME.water);
      else if (/building/.test(id)) set(id, 'fill-color', MAP_THEME.building);
      else if (/landcover|park|landuse|aeroway/.test(id)) { set(id, 'fill-color', MAP_THEME.land); set(id, 'fill-opacity', 0.55); }
      return;
    }
    if (l.type === 'line') {
      if (/waterway/.test(id)) set(id, 'line-color', MAP_THEME.waterLine);
      else if (/boundary/.test(id)) { set(id, 'line-color', MAP_THEME.boundary); set(id, 'line-opacity', 0.75); }
      else if (/motorway/.test(id)) set(id, 'line-color', MAP_THEME.motorway);
      else if (/major|primary|trunk/.test(id)) set(id, 'line-color', MAP_THEME.roadMajor);
      else if (/highway|road|tunnel|bridge|rail|path|minor/.test(id)) set(id, 'line-color', MAP_THEME.roadMinor);
      return;
    }
    if (l.type === 'symbol') {
      if (/poi|housenumber/.test(id)) { hide(id); return; }
      if (/water/.test(id)) set(id, 'text-color', MAP_THEME.waterText);
      else if (/place_(city|town|state)/.test(id)) set(id, 'text-color', MAP_THEME.placeText);
      else set(id, 'text-color', MAP_THEME.minorText);
      set(id, 'text-halo-color', MAP_THEME.halo);
      set(id, 'text-halo-width', 1.2);
    }
  });
}

export function lisaColorExpr() {
  return ['match', ['get', 'lisa_mismatch_index_label'], 'HH', LISA_COLORS.HH, 'LL', LISA_COLORS.LL,
    'HL', LISA_COLORS.HL, 'LH', LISA_COLORS.LH, LISA_COLORS.ns];
}
export function continuousExpr(varName) {
  const [lo, mid, hi] = CONT_STOPS[varName];
  const [c0, c1, c2] = rampFor(varName);
  return ['case', ['==', ['get', varName], null], '#253045',
    ['interpolate', ['linear'], ['get', varName], lo, c0, mid, c1, hi, c2]];
}
export function availStatusColorExpr() {
  return ['match', ['get', 'avail_status'],
    'available', STATUS.available.color, 'limited', STATUS.limited.color,
    'full', STATUS.full.color, 'closed', STATUS.closed.color, STATUS.unknown.color];
}

const FAC_LAYERS = ['facilities', 'facilities-status-bg', 'facilities-status-label'];
const ACCENT = '#5cc8ff';
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

export async function initMapLayers() {
  const map = AppState.map;
  applyBasemapTheme(map);
  await loadResourceIcons();

  map.addSource('tracts', { type: 'geojson', data: AppState.tractsData[AppState.mode] });
  map.addSource('facilities', { type: 'geojson', data: AppState.facilitiesData, promoteId: 'facility_id' });
  map.addSource('districts', { type: 'geojson', data: AppState.districtsData });
  map.addSource('user-location', { type: 'geojson', data: EMPTY_FC });

  const t = (ms) => ({ duration: motion(ms), delay: 0 });

  map.addLayer({ id: 'tract-fill', type: 'fill', source: 'tracts',
    paint: { 'fill-color': lisaColorExpr(), 'fill-opacity': 0.7, 'fill-opacity-transition': t(280), 'fill-color-transition': t(280) } });
  map.addLayer({ id: 'tract-stroke', type: 'line', source: 'tracts', paint: { 'line-color': '#9db4d6', 'line-width': 0.3, 'line-opacity': 0.16 } });
  // AI-referenced tracts: soft fill + illuminated outline (filter set by setTractHighlight).
  map.addLayer({ id: 'tract-ai-fill', type: 'fill', source: 'tracts', filter: ['in', ['get', 'GEOID'], ['literal', []]],
    paint: { 'fill-color': ACCENT, 'fill-opacity': 0.14 } });
  map.addLayer({ id: 'tract-ai-glow', type: 'line', source: 'tracts', filter: ['in', ['get', 'GEOID'], ['literal', []]],
    paint: { 'line-color': ACCENT, 'line-width': 5, 'line-blur': 4, 'line-opacity': 0.45 } });
  map.addLayer({ id: 'tract-ai-line', type: 'line', source: 'tracts', filter: ['in', ['get', 'GEOID'], ['literal', []]],
    paint: { 'line-color': '#bfeaff', 'line-width': 1.4, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'tract-hover', type: 'line', source: 'tracts', paint: { 'line-color': '#e6f4ff', 'line-width': 1.6, 'line-opacity': 0.85 }, filter: ['==', 'GEOID', ''] });
  map.addLayer({ id: 'tract-selected-glow', type: 'line', source: 'tracts', filter: ['==', ['get', 'GEOID'], ''],
    paint: { 'line-color': ACCENT, 'line-width': 8, 'line-blur': 6, 'line-opacity': 0.55 } });
  map.addLayer({ id: 'tract-selected', type: 'line', source: 'tracts', filter: ['==', ['get', 'GEOID'], ''],
    paint: { 'line-color': '#ffffff', 'line-width': 2 } });

  map.addLayer({
    id: 'districts-fill', type: 'fill', source: 'districts', layout: { visibility: 'none' },
    paint: {
      'fill-color': ['interpolate', ['linear'], ['get', 'homeless_k12_avg'],
        0, 'rgba(40,58,90,0.35)', 50, 'rgba(90,110,170,0.5)', 150, 'rgba(242,166,90,0.6)',
        400, 'rgba(240,100,90,0.7)', 1300, 'rgba(255,70,90,0.8)'],
      'fill-outline-color': '#2c3f5f',
    },
  });
  map.addLayer({ id: 'districts-stroke', type: 'line', source: 'districts', layout: { visibility: 'none' }, paint: { 'line-color': '#4a5f82', 'line-width': 0.6, 'line-opacity': 0.7 } });

  // Optional route line to one selected resource (openrouteservice / OSM data,
  // which may be displayed on any map). Drawn beneath the resource markers.
  map.addSource('route', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#04101c', 'line-width': 7, 'line-opacity': 0.8 } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['!=', ['get', 'mode'], 'walk'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ACCENT, 'line-width': 3.5 } });
  map.addLayer({ id: 'route-line-walk', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'walk'], layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ACCENT, 'line-width': 3.5, 'line-dasharray': [1, 1.6] } });

  // Halo beneath markers: hover / AI-match / selected, driven by feature-state
  // so it animates smoothly without touching the data.
  const hs = (k) => ['boolean', ['feature-state', k], false];
  map.addLayer({
    id: 'facilities-halo', type: 'circle', source: 'facilities',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        8, ['case', hs('selected'), 15, hs('hover'), 13, hs('match'), 12, 0],
        13, ['case', hs('selected'), 24, hs('hover'), 21, hs('match'), 19, 0]],
      'circle-color': ACCENT,
      'circle-opacity': ['case', hs('selected'), 0.28, hs('hover'), 0.22, hs('match'), 0.16, 0],
      'circle-blur': 0.55,
      'circle-stroke-color': ['case', hs('selected'), '#ffffff', ACCENT],
      'circle-stroke-width': ['case', hs('selected'), 1.6, hs('match'), 1.1, hs('hover'), 0.8, 0],
      'circle-stroke-opacity': ['case', hs('selected'), 0.95, hs('match'), 0.75, hs('hover'), 0.55, 0],
      'circle-radius-transition': t(200), 'circle-opacity-transition': t(200), 'circle-stroke-opacity-transition': t(200),
    },
  });

  map.addLayer({
    id: 'facilities', type: 'symbol', source: 'facilities',
    layout: {
      'icon-image': ['match', ['get', 'resource_group'],
        'food', 'icon-food', 'shelter', 'icon-shelter', 'outreach', 'icon-outreach',
        'legal', 'icon-legal', 'housing_support', 'icon-housing_support',
        'behavioral_health', 'icon-behavioral_health', 'public_benefits', 'icon-public_benefits',
        'health', 'icon-health', 'icon-other'],
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        8, ['case', ['==', ['get', 'is_access_resource'], true], 0.72, 0.56],
        13, ['case', ['==', ['get', 'is_access_resource'], true], 1.2, 0.92]],
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
    paint: {
      'icon-opacity': ['case', hs('selected'), 1, hs('hover'), 1, hs('match'), 1,
        ['==', ['get', 'is_access_resource'], true], 0.92, 0.66],
      'icon-opacity-transition': t(180),
    },
  });

  map.addLayer({
    id: 'facilities-status-bg', type: 'circle', source: 'facilities', layout: { visibility: 'none' },
    filter: ['==', ['get', 'avail_has_data'], true],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4.5, 13, 7.5],
      'circle-color': availStatusColorExpr(), 'circle-stroke-color': '#070c16', 'circle-stroke-width': 1.5,
      'circle-translate': [9, -9],
    },
  });
  map.addLayer({
    id: 'facilities-status-label', type: 'symbol', source: 'facilities',
    layout: {
      visibility: 'none',
      'text-field': ['match', ['get', 'avail_status'], 'available', 'A', 'limited', 'L', 'full', 'F', 'closed', 'C', '?'],
      'text-font': ['Open Sans Bold', 'Open Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 7.5, 13, 10],
      'text-allow-overlap': true, 'text-ignore-placement': true,
    },
    filter: ['==', ['get', 'avail_has_data'], true],
    paint: { 'text-color': '#060b15', 'text-translate': [9, -9] },
  });

  map.addLayer({
    id: 'user-location-halo', type: 'circle', source: 'user-location',
    paint: { 'circle-radius': 18, 'circle-color': '#5cc8ff', 'circle-opacity': 0.14, 'circle-blur': 0.4 },
  });
  map.addLayer({
    id: 'user-location-dot', type: 'circle', source: 'user-location',
    paint: { 'circle-radius': 7, 'circle-color': '#5cc8ff', 'circle-stroke-color': '#e8f6ff', 'circle-stroke-width': 2.5 },
  });

  // Clicking a resource marker means something different per shell (open the
  // seeker detail page vs. the gov resource-detail panel), so this only
  // dispatches a DOM event — main.js listens and routes it by AppState.shell.
  const openFromFeature = (e) => {
    const p = e.features[0].properties;
    if (p.facility_id) document.dispatchEvent(new CustomEvent('rg:facility-click', { detail: { facilityId: p.facility_id } }));
  };
  FAC_LAYERS.forEach(layerId => {
    map.on('click', layerId, openFromFeature);
    map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
  });
  map.on('mousemove', 'facilities', (e) => { const id = e.features?.[0]?.properties?.facility_id; if (id) setFacilityHover(id); });
  map.on('mouseleave', 'facilities', () => setFacilityHover(null));
}

/* ── Marker emphasis (feature-state) ────────────────────────────────────── */
const facState = { hover: null, selected: null, match: new Set() };
function fs(id, state) {
  const map = AppState.map; if (!map || id == null || !map.getSource('facilities')) return;
  try { map.setFeatureState({ source: 'facilities', id }, state); } catch (_) {}
}
export function setFacilityHover(id) {
  if (facState.hover === id) return;
  if (facState.hover) fs(facState.hover, { hover: false });
  facState.hover = id || null;
  if (id) fs(id, { hover: true });
}
export function setSelectedFacility(id) {
  if (facState.selected) fs(facState.selected, { selected: false });
  facState.selected = id || null;
  if (id) fs(id, { selected: true });
}
/** Emphasise a set of facilities (e.g. AI-highlighted matches). */
export function setFacilityEmphasis(ids) {
  facState.match.forEach(id => fs(id, { match: false }));
  facState.match = new Set(ids || []);
  facState.match.forEach(id => fs(id, { match: true }));
}
function reapplyFacilityStates() {
  if (facState.hover) fs(facState.hover, { hover: true });
  if (facState.selected) fs(facState.selected, { selected: true });
  facState.match.forEach(id => fs(id, { match: true }));
}

/* ── Tract highlight / selection ────────────────────────────────────────── */
export function setTractHighlight(geoids) {
  const map = AppState.map; if (!map || !map.getLayer('tract-ai-line')) return;
  const f = ['in', ['get', 'GEOID'], ['literal', geoids || []]];
  ['tract-ai-fill', 'tract-ai-glow', 'tract-ai-line'].forEach(id => map.setFilter(id, f));
}
export function setSelectedTract(geoid) {
  const map = AppState.map; if (!map || !map.getLayer('tract-selected')) return;
  const f = ['==', ['get', 'GEOID'], geoid || ''];
  map.setFilter('tract-selected', f); map.setFilter('tract-selected-glow', f);
}
export function findTractFeature(geoid, mode = AppState.mode) {
  return (AppState.tractsData[mode]?.features || []).find(f => f.properties.GEOID === geoid) || null;
}
export function fitToTracts(geoids, opts = {}) {
  const map = AppState.map; if (!map || !geoids?.length) return;
  const feats = geoids.map(g => findTractFeature(g)).filter(Boolean);
  const b = featuresBounds(feats); if (!b) return;
  try { map.fitBounds(b, { padding: opts.padding || fitPadding(), maxZoom: opts.maxZoom || 12.5, duration: motion(700) }); } catch (_) {}
}
/** Padding that keeps framed features clear of the floating side panel /
 *  bottom sheet, clamped so it always leaves room inside the canvas. */
export function fitPadding() {
  const map = AppState.map;
  const box = map ? map.getContainer().getBoundingClientRect() : { top: 0, left: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
  // Clamp against the size MapLibre is actually using (it can lag a resize).
  const cw = map ? Math.min(box.width, map.getCanvas().clientWidth || box.width) : box.width;
  const ch = map ? Math.min(box.height, map.getCanvas().clientHeight || box.height) : box.height;
  const panel = document.getElementById('side-panel');
  const shown = panel && !panel.classList.contains('hidden') && getComputedStyle(panel).display !== 'none';
  const pr = shown ? panel.getBoundingClientRect() : null;
  const narrow = window.matchMedia('(max-width: 760px)').matches;
  const p = narrow
    ? { top: 50, bottom: (pr ? Math.max(0, box.bottom - pr.top) : 0) + 28, left: 40, right: 40 }
    : { top: 60, bottom: 50, left: (pr ? Math.max(0, pr.right - box.left) : 0) + 36, right: 64 };
  const fit = (a, b, room) => { const s = a + b > room ? room / (a + b) : 1; return [Math.round(a * s), Math.round(b * s)]; };
  [p.top, p.bottom] = fit(p.top, p.bottom, Math.max(0, ch - 120));
  [p.left, p.right] = fit(p.left, p.right, Math.max(0, cw - 120));
  return p;
}

/** Fly to a point, centring it in the part of the map not covered by the
 *  panel. Uses a one-off `offset` rather than camera `padding`, which MapLibre
 *  would keep and stack onto later fitBounds calls. */
export function flyToPoint(coords, zoom) {
  const map = AppState.map; if (!map || !coords) return;
  const p = fitPadding();
  map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), zoom), offset: [(p.left - p.right) / 2, (p.top - p.bottom) / 2], duration: motion(700) });
}

/** Nassau + Suffolk extent, used to frame analytical views. */
export const LONG_ISLAND_BOUNDS = [[-73.77, 40.54], [-71.85, 41.17]];
/** Frame Long Island beside the panel (optionally with a modest pitch). */
export function fitLongIsland({ pitch = 0, duration = 600 } = {}) {
  const map = AppState.map; if (!map) return;
  map.resize(); // the container may have just changed size (rotation, panel toggle)
  const cam = map.cameraForBounds(LONG_ISLAND_BOUNDS, { padding: fitPadding() });
  if (cam) map.easeTo({ center: cam.center, zoom: cam.zoom, bearing: 0, pitch, duration: motion(duration) });
  else map.easeTo({ center: LONG_ISLAND_CENTER, zoom: LONG_ISLAND_ZOOM, pitch, duration: motion(duration) });
}

/** Show/hide resource markers together with their hover/selection halo. */
export function setFacilitiesLayout(visibility) {
  const map = AppState.map; if (!map) return;
  ['facilities', 'facilities-halo'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility); });
}
/** The searcher's location marker belongs to Find Resources only. */
export function setUserLocationVisible(on) {
  const map = AppState.map; if (!map) return;
  ['user-location-halo', 'user-location-dot'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); });
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
/** Show (or clear, with null) a route LineString on the MapLibre map. */
export function setRouteLine(geometry, mode = 'walk') {
  const map = AppState.map; if (!map || !map.getSource('route')) return;
  map.getSource('route').setData(geometry ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: { mode } }] } : EMPTY_FC);
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
  if (AppState.map && AppState.map.getSource('facilities')) {
    AppState.map.getSource('facilities').setData(AppState.facilitiesData);
    reapplyFacilityStates();
  }
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
  return `<span class="status-chip status-chip-${escapeHtml(s.key)} ${size}"><span class="status-chip-glyph" aria-hidden="true">${s.glyph}</span>${escapeHtml(s.label)}</span>`;
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
export function nearestFacilities(fromCoords, n = 3, filterFn = null) {
  return nearestFrom(AppState.facilitiesData?.features || [], fromCoords, n, filterFn);
}

/* ── Resource marker icons ─────────────────────────────────────────────────
 * Compact dark discs with a thin category-coloured ring, a category glyph and
 * a restrained outer glow. Drawn straight to canvas at 2× for crisp edges. */
const ICON_LOGICAL = 36, ICON_RATIO = 2;
function iconPathD(group) {
  const m = /d="([^"]+)"/.exec(ICON_SVGS[group] || ICON_SVGS.other);
  return m ? m[1] : '';
}
function drawMarker(group, color) {
  const px = ICON_LOGICAL * ICON_RATIO;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.scale(ICON_RATIO, ICON_RATIO);
  const c = ICON_LOGICAL / 2, r = 11.5;
  // glow
  ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 7; ctx.globalAlpha = 0.55;
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.restore();
  // disc + ring
  ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fillStyle = '#0a1220'; ctx.fill();
  ctx.lineWidth = 1.75; ctx.strokeStyle = color; ctx.stroke();
  // glyph
  const glyph = 12.5, s = glyph / 24;
  ctx.save(); ctx.translate(c - glyph / 2, c - glyph / 2); ctx.scale(s, s);
  ctx.fillStyle = color;
  try { ctx.fill(new Path2D(iconPathD(group))); } catch (_) {}
  ctx.restore();
  return ctx.getImageData(0, 0, px, px);
}
export function buildIconSVG(iconContent, color, size = 40) {
  const r = size / 2 - 2, cx = size / 2, iconPx = size * 0.5, offset = (size - iconPx) / 2, scale = iconPx / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${cx}" cy="${cx}" r="${r}" fill="#0a1220" stroke="${color}" stroke-width="1.75"/>` +
    `<g transform="translate(${offset.toFixed(2)},${offset.toFixed(2)}) scale(${scale.toFixed(4)})" fill="${color}">${iconContent}</g></svg>`;
}
export function resourceLegendIcon(group, color, size = 22) {
  const c = color || RESOURCE_COLORS[group] || RESOURCE_COLORS.other;
  const path = ICON_SVGS[group] || ICON_SVGS.other;
  const r = size / 2 - 1.2, cx = size / 2, iconPx = size * 0.52, offset = (size - iconPx) / 2, scale = iconPx / 24;
  return `<svg class="res-icon" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" style="flex-shrink:0">` +
    `<circle cx="${cx}" cy="${cx}" r="${r}" fill="#0a1220" stroke="${c}" stroke-width="1.4"/>` +
    `<g transform="translate(${offset.toFixed(2)},${offset.toFixed(2)}) scale(${scale.toFixed(4)})" fill="${c}">${path}</g></svg>`;
}
export async function loadResourceIcons() {
  Object.entries(RESOURCE_COLORS).forEach(([group, color]) => {
    try {
      if (!AppState.map.hasImage(`icon-${group}`)) AppState.map.addImage(`icon-${group}`, drawMarker(group, color), { pixelRatio: ICON_RATIO });
    } catch (_) {}
  });
}

export { Availability, STATUS, FRESHNESS_LABELS };
