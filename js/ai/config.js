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
function resolveApiBase() {
  const meta = typeof document !== 'undefined' && document.querySelector('meta[name="reliefgrid-api-base"]');
  const v = (meta && meta.content) || (typeof window !== 'undefined' && window.RELIEFGRID_API_BASE) || '';
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
  },
  // Every AI request has a hard client-side timeout: no infinite spinners.
  timeoutsMs: { status: 6000, interpret: 30000, explain: 30000, analyze: 75000, locationContext: 35000 },
  limits: { requestChars: 600, questionChars: 500, explainResources: 6, historyTurns: 3 },
};
