/* ============================================================================
 * ReliefGrid location services — centralized configuration.
 * ----------------------------------------------------------------------------
 * Location intelligence is kept separate from the AI layer. Providers were
 * chosen so results may be shown on ReliefGrid's MapLibre map:
 *   - Town / ZIP names: bundled U.S. Census Gazetteer data (data/li_places.json)
 *     resolved in the browser — no external request at all.
 *   - Street addresses: U.S. Census Geocoder (public, no key).
 *   - Landmarks (fallback) + walk/drive travel times + optional route lines:
 *     openrouteservice (OpenStreetMap data), which needs OPENROUTESERVICE_API_KEY.
 * (Google Maps Platform's Geocoding/Routes terms prohibit using their content
 *  with or near a non-Google map, so they are deliberately not used here.)
 *
 * Environment:
 *   OPENROUTESERVICE_API_KEY   enables travel times, route lines, landmark search
 *   ORS_MAX_DESTINATIONS       destinations per travel-time request (default 25)
 * ==========================================================================*/
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();

export function geoConfig() {
  return {
    ors: {
      apiKey: env('OPENROUTESERVICE_API_KEY'),
      baseUrl: 'https://api.openrouteservice.org',
      profiles: { walk: 'foot-walking', drive: 'driving-car' },
      timeoutMs: 12000,
    },
    census: {
      baseUrl: 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress',
      benchmark: 'Public_AR_Current',
      timeoutMs: 10000,
    },
    // Travel-time origins must be on or near Long Island (eastern Queens edge
    // included for people just over the county line). Geocoded places must also
    // fall inside a Nassau/Suffolk tract (see inServiceArea in services.js).
    serviceArea: { minLng: -73.95, minLat: 40.5, maxLng: -71.8, maxLat: 41.2 },
    limits: {
      maxDestinations: Math.min(50, Math.max(1, Number(env('ORS_MAX_DESTINATIONS', '25')) || 25)),
      geocodeChars: 160,
      travelCacheMs: 10 * 60 * 1000, // de-duplicates repeat requests only; never persisted
    },
  };
}

export const routingConfigured = () => !!geoConfig().ors.apiKey;
