/* ============================================================================
 * ReliefGrid — location resolution and travel times (browser side).
 * ----------------------------------------------------------------------------
 * Roles stay separate:
 *   - This module turns a typed place into coordinates and asks ReliefGrid's
 *     own /api/geo endpoints for travel times to ReliefGrid facilities.
 *   - ReliefGrid (js/seeker.js) decides which resources exist and ranks them.
 *   - MapLibre displays everything. No provider adds resources.
 *
 * Resolution order for typed text:
 *   1. ZIP code or Long Island town/hamlet → bundled U.S. Census Gazetteer data
 *      (data/li_places.json). Resolved entirely in the browser: nothing is sent.
 *   2. Street address / landmark → POST /api/geo/geocode (Census Geocoder, then
 *      OpenStreetMap search). Only this text leaves the browser.
 * Privacy: coordinates sent anywhere are rounded to ~100 m; nothing is stored.
 * ==========================================================================*/
import { aiRequest, AIClientError } from './ai/client.js';

let placesPromise = null;
function loadPlaces() {
  if (!placesPromise) placesPromise = fetch('./data/li_places.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
  return placesPromise;
}

/** Round to 3 decimals (~110 m) before a location leaves this module. */
export const roundCoords = (c) => (Array.isArray(c) ? [Math.round(c[0] * 1000) / 1000, Math.round(c[1] * 1000) / 1000] : null);

const STOP = /\b(near|nearby|around|in|at|close to|by|ny|new york|long island|li|usa|us|zip( code)?|the|town of|village of|hamlet of)\b/g;
const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').replace(STOP, ' ').replace(/\s+/g, ' ').trim()} `;

/**
 * Resolve typed text to a search origin.
 * @returns {Promise<{ ok: true, coords: [lng, lat], label: string, precision: 'zip'|'place'|'address', source: string }
 *                  | { ok: false, reason: 'empty'|'outside'|'not_found'|'unavailable', message: string }>}
 */
export async function resolveLocationText(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: 'empty', message: 'Enter a Long Island town, ZIP code or address.' };
  const data = await loadPlaces();
  const zip = (raw.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1];
  const looksLikeAddress = /\b\d{1,6}\s+[a-z]/i.test(raw) && !/^\d{5}$/.test(raw.trim());

  if (data && zip && !looksLikeAddress) {
    const c = data.zips[zip];
    return c ? { ok: true, coords: c, label: `ZIP ${zip}`, precision: 'zip', source: 'U.S. Census ZIP code area' }
      : { ok: false, reason: 'outside', message: `ZIP ${zip} isn't in ReliefGrid's Nassau/Suffolk service area.` };
  }
  if (data && !looksLikeAddress) {
    const q = norm(raw);
    const exact = data.places.find(p => ` ${p.name.toLowerCase()} ` === q);
    // Otherwise the longest place name contained in the text ("food pantry near East Meadow").
    const contained = exact || data.places.filter(p => q.includes(` ${p.name.toLowerCase()} `)).sort((a, b) => b.name.length - a.name.length)[0];
    if (contained) return { ok: true, coords: [contained.lng, contained.lat], label: `${contained.name}, NY`, precision: 'place', source: 'U.S. Census place area' };
  }
  // Street address or landmark → ReliefGrid's server-side geocoder.
  try {
    const r = await aiRequest('geocode', { text: raw.slice(0, 160) });
    if (r.result?.coords) return { ok: true, coords: roundCoords(r.result.coords), label: r.result.label, precision: r.result.precision, source: r.result.source };
    return { ok: false, reason: 'not_found', message: `ReliefGrid couldn't find “${raw.slice(0, 60)}” on Long Island. Try a town name or ZIP code.` };
  } catch (e) {
    return { ok: false, reason: 'unavailable', message: e instanceof AIClientError && e.code === 'rate_limited'
      ? 'Too many location lookups right now. Try a town name or ZIP code.'
      : 'Address lookup is unavailable right now. Try a town name or ZIP code.' };
  }
}

/** Walk/drive times from an origin to ReliefGrid facilities (ids only). */
export async function fetchTravelTimes(origin, mode, facilityIds) {
  const r = await aiRequest('travelTimes', { origin: roundCoords(origin), mode, facilityIds });
  return new Map((r.times || []).map(t => [t.facilityId, t]));
}

/** Route line to one ReliefGrid facility, for display on the MapLibre map. */
export async function fetchRoute(origin, mode, facilityId) {
  return aiRequest('route', { origin: roundCoords(origin), mode, facilityId });
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec)) return null;
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60 ? `${m % 60} min` : ''}`.trim();
}
export const metersToMiles = (m) => m / 1609.344;
