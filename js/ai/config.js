/* ============================================================================
 * ReliefGrid AI — browser-side configuration (the only place to change it).
 * ----------------------------------------------------------------------------
 * The browser never talks to Gemini or OpenAI directly and never holds an API
 * key. It calls ReliefGrid's own backend (api/ai/*), which holds the keys and
 * picks the provider (see server/ai/config.js).
 *
 * apiBase: '' means "same origin" (e.g. Vercel serving both the static site
 * and /api). To host the static site elsewhere (e.g. GitHub Pages) and the
 * backend on a serverless platform, set
 *   <meta name="reliefgrid-api-base" content="https://your-backend.example">
 * in index.html and add the site's origin to AI_ALLOWED_ORIGINS on the server.
 * ==========================================================================*/
// Static-only hosts (no /api functions) → the ReliefGrid backend they should use.
// GitHub Pages serves a copy of this site but cannot run api/*; it calls the
// Vercel deployment instead (whose server allows this origin — see
// DEFAULT_ALLOWED_ORIGINS in server/ai/config.js).
const STATIC_HOST_BACKENDS = {
  'aaronshi09.github.io': 'https://reliefgrid-prototype.vercel.app',
};

function resolveApiBase() {
  const meta = typeof document !== 'undefined' && document.querySelector('meta[name="reliefgrid-api-base"]');
  const host = typeof location !== 'undefined' ? location.hostname : '';
  const v = (meta && meta.content) || (typeof window !== 'undefined' && window.RELIEFGRID_API_BASE) || STATIC_HOST_BACKENDS[host] || '';
  return String(v).replace(/\/+$/, '');
}

export const AI_CLIENT_CONFIG = {
  apiBase: resolveApiBase(),
  endpoints: {
    status: '/api/ai/status',
    interpret: '/api/ai/interpret',
    explain: '/api/ai/explain',
    analyze: '/api/ai/analyze',
    locationContext: '/api/ai/location-context',
    // Location services (no AI involved): address lookup, travel times, route lines.
    geocode: '/api/geo/geocode',
    travelTimes: '/api/geo/travel-times',
    route: '/api/geo/route',
  },
  // Every AI request has a hard client-side timeout: no infinite spinners.
  // The status check is retried once (serverless cold starts can be slow).
  timeoutsMs: { status: 10000, interpret: 30000, explain: 30000, analyze: 75000, locationContext: 35000, geocode: 15000, travelTimes: 20000, route: 20000 },
  limits: { requestChars: 600, questionChars: 500, explainResources: 6, historyTurns: 3 },
};
