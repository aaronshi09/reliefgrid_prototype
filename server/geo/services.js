/* ============================================================================
 * ReliefGrid location services — geocoding and travel times.
 * ----------------------------------------------------------------------------
 * RULES
 *  - Destinations are ALWAYS ReliefGrid facility ids, resolved to coordinates
 *    from longisland_facilities.geojson on the server. The API cannot be used to
 *    route to arbitrary places, and nothing here adds resources.
 *  - Origins arrive already rounded by the browser (~100 m); they are never
 *    logged or stored. Only travel times are cached, briefly, in memory.
 *  - Provider errors become short user-safe codes (AIError) — no raw bodies.
 * ==========================================================================*/
import { geoConfig } from './config.js';
import { AIError, codeForUpstreamStatus } from '../ai/errors.js';
import { facilityById, getTracts } from '../data/store.js';

const round3 = (v) => Math.round(v * 1000) / 1000;
function validPoint(p) {
  if (!Array.isArray(p) || p.length !== 2) return null;
  const [lng, lat] = p.map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const a = geoConfig().serviceArea;
  if (lng < a.minLng || lng > a.maxLng || lat < a.minLat || lat > a.maxLat) return null;
  return [round3(lng), round3(lat)];
}

/* Point-in-polygon against ReliefGrid's own Nassau/Suffolk tracts. */
let tractPolys = null;
async function inServiceArea([x, y]) {
  if (!tractPolys) {
    const fc = await getTracts('drive');
    tractPolys = fc.features.flatMap(f => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)).map(p => {
      const xs = p[0].map(c => c[0]), ys = p[0].map(c => c[1]);
      return { p, b: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
    });
  }
  const inRing = (ring) => { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; };
  return tractPolys.some(({ p, b }) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && inRing(p[0]) && !p.slice(1).some(inRing));
}

async function fetchJSON(url, init, timeoutMs, label) {
  let res;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new AIError(e?.name === 'TimeoutError' ? 'timeout' : 'unavailable', `${label} request failed`); }
  if (!res.ok) throw new AIError(codeForUpstreamStatus(res.status), `${label} http ${res.status}`);
  try { return await res.json(); } catch (_) { throw new AIError('bad_output', `${label} non-JSON`); }
}

/* ── Geocoding (addresses / landmarks; towns & ZIPs are resolved in-browser) ── */
export async function geocode(text) {
  const cfg = geoConfig();
  const q = String(text || '').replace(/\s+/g, ' ').trim().slice(0, cfg.limits.geocodeChars);
  if (q.length < 3) throw new AIError('invalid_request', 'empty location');
  const withState = /\b(ny|new york)\b/i.test(q) ? q : `${q}, NY`;

  // 1. U.S. Census Geocoder — street addresses (public, no key).
  try {
    const u = `${cfg.census.baseUrl}?address=${encodeURIComponent(withState)}&benchmark=${cfg.census.benchmark}&format=json`;
    const j = await fetchJSON(u, {}, cfg.census.timeoutMs, 'census');
    const m = j?.result?.addressMatches?.[0];
    const pt = m ? validPoint([m.coordinates?.x, m.coordinates?.y]) : null;
    if (pt && await inServiceArea(pt)) return { coords: pt, label: titleCase(m.matchedAddress || q), precision: 'address', source: 'U.S. Census Geocoder' };
  } catch (e) { if (!(e instanceof AIError)) throw e; /* fall through to the next resolver */ }

  // 2. openrouteservice geocoding (OpenStreetMap) — landmarks / named places.
  if (cfg.ors.apiKey) {
    const a = cfg.serviceArea;
    const u = `${cfg.ors.baseUrl}/geocode/search?text=${encodeURIComponent(q)}&size=1&boundary.country=US`
      + `&boundary.rect.min_lon=${a.minLng}&boundary.rect.min_lat=${a.minLat}&boundary.rect.max_lon=${a.maxLng}&boundary.rect.max_lat=${a.maxLat}`;
    const j = await fetchJSON(u, { headers: { Authorization: cfg.ors.apiKey } }, cfg.ors.timeoutMs, 'ors-geocode');
    const f = j?.features?.[0];
    const pt = f ? validPoint(f.geometry?.coordinates) : null;
    if (pt && await inServiceArea(pt)) return { coords: pt, label: String(f.properties?.label || q).slice(0, 120), precision: f.properties?.layer === 'address' ? 'address' : 'place', source: 'openrouteservice · © OpenStreetMap contributors' };
  }
  return null; // not found in the service area
}
const titleCase = (s) => String(s).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\bNy\b/, 'NY');

/* ── Travel times (openrouteservice Matrix, ReliefGrid destinations only) ── */
const travelCache = new Map(); // key → { at, times }
const inFlight = new Map();

export async function travelTimes({ origin, mode, facilityIds }) {
  const cfg = geoConfig();
  if (!cfg.ors.apiKey) throw new AIError('not_configured', 'OPENROUTESERVICE_API_KEY missing');
  const o = validPoint(origin);
  if (!o) throw new AIError('invalid_request', 'origin outside service area');
  const profile = cfg.ors.profiles[mode];
  if (!profile) throw new AIError('invalid_request', 'unsupported mode');
  const ids = [...new Set((Array.isArray(facilityIds) ? facilityIds : []).filter(x => typeof x === 'string'))].slice(0, cfg.limits.maxDestinations);
  const dests = [];
  for (const id of ids) { const f = await facilityById(id); if (f) dests.push({ id, coords: f.geometry.coordinates }); }
  if (!dests.length) throw new AIError('invalid_request', 'no known facilities');

  const key = `${mode}|${o.join(',')}|${dests.map(d => d.id).sort().join(',')}`;
  const hit = travelCache.get(key);
  if (hit && Date.now() - hit.at < cfg.limits.travelCacheMs) return { mode, times: hit.times, cached: true };
  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    const body = { locations: [o, ...dests.map(d => d.coords)], sources: [0], destinations: dests.map((_, i) => i + 1), metrics: ['duration', 'distance'], units: 'm' };
    const j = await fetchJSON(`${cfg.ors.baseUrl}/v2/matrix/${profile}`, {
      method: 'POST', headers: { Authorization: cfg.ors.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    }, cfg.ors.timeoutMs, 'ors-matrix');
    const dur = j?.durations?.[0], dist = j?.distances?.[0];
    if (!Array.isArray(dur)) throw new AIError('bad_output', 'ors matrix missing durations');
    const times = dests.map((d, i) => ({
      facilityId: d.id,
      durationSec: Number.isFinite(dur[i]) ? Math.round(dur[i]) : null,   // null = not routable
      distanceM: Number.isFinite(dist?.[i]) ? Math.round(dist[i]) : null,
    }));
    travelCache.set(key, { at: Date.now(), times });
    if (travelCache.size > 500) travelCache.delete(travelCache.keys().next().value);
    return { mode, times, cached: false };
  })();
  inFlight.set(key, p);
  try { return await p; } finally { inFlight.delete(key); }
}

/* ── Route line for one selected ReliefGrid resource (optional display) ── */
export async function routeLine({ origin, mode, facilityId }) {
  const cfg = geoConfig();
  if (!cfg.ors.apiKey) throw new AIError('not_configured', 'OPENROUTESERVICE_API_KEY missing');
  const o = validPoint(origin);
  const profile = cfg.ors.profiles[mode];
  const f = typeof facilityId === 'string' ? await facilityById(facilityId) : null;
  if (!o || !profile || !f) throw new AIError('invalid_request', 'bad route request');
  const j = await fetchJSON(`${cfg.ors.baseUrl}/v2/directions/${profile}/geojson`, {
    method: 'POST', headers: { Authorization: cfg.ors.apiKey, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
    body: JSON.stringify({ coordinates: [o, f.geometry.coordinates], instructions: false }),
  }, cfg.ors.timeoutMs, 'ors-directions');
  const feat = j?.features?.[0];
  const coords = feat?.geometry?.type === 'LineString' ? feat.geometry.coordinates : null;
  if (!coords?.length) throw new AIError('bad_output', 'ors directions missing geometry');
  const s = feat.properties?.summary || {};
  return {
    facilityId, mode,
    geometry: { type: 'LineString', coordinates: coords.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]) },
    durationSec: Number.isFinite(s.duration) ? Math.round(s.duration) : null,
    distanceM: Number.isFinite(s.distance) ? Math.round(s.distance) : null,
  };
}
