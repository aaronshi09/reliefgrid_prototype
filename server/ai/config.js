/* ============================================================================
 * ReliefGrid AI — centralized server configuration.
 * ----------------------------------------------------------------------------
 * Everything provider-related is decided here: which provider serves which
 * task, which models, whether fallback is allowed, and request limits. The
 * frontend never names a provider or a model.
 *
 * Environment variables (see .env.example — never commit real values):
 *   GEMINI_API_KEY            enables Gemini (Resource Navigator)
 *   OPENAI_API_KEY            enables OpenAI (Ask ReliefGrid analyst)
 *   GEMINI_MODEL              default gemini-2.5-flash
 *   OPENAI_MODEL              default gpt-5-mini
 *   AI_ALLOW_FALLBACK         "true" → route to the other provider when the
 *                             primary is unavailable, for tasks marked
 *                             fallbackSafe (same data, same capabilities)
 *   GEMINI_MAPS_GROUNDING     "true" → enable the optional Google Maps
 *                             travel/area context on resource detail pages
 *   AI_ALLOWED_ORIGINS        comma-separated origins allowed to call the API
 *                             cross-origin (e.g. a GitHub Pages frontend)
 *   AI_RATE_LIMIT_PER_MIN     per-IP request budget (default 20)
 * Values are read lazily so the local dev server can load .env first.
 * ==========================================================================*/
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const flag = (k) => env(k).toLowerCase() === 'true';

export function aiConfig() {
  return {
    providers: {
      gemini: {
        apiKey: env('GEMINI_API_KEY'),
        model: env('GEMINI_MODEL', 'gemini-2.5-flash'),
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      },
      openai: {
        apiKey: env('OPENAI_API_KEY'),
        model: env('OPENAI_MODEL', 'gpt-5-mini'),
        baseUrl: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      },
    },

    /* Task-based routing. One provider per request — never both.
     * fallbackSafe: the task uses only ReliefGrid data handed to the model
     * in the prompt / via tools, so another provider can serve it without
     * changing the data source or the capability. */
    tasks: {
      'navigator.interpret':        { primary: 'gemini', fallback: 'openai', fallbackSafe: true,  timeoutMs: 20000 },
      'navigator.explain':          { primary: 'gemini', fallback: 'openai', fallbackSafe: true,  timeoutMs: 20000 },
      // Google Maps grounding exists only on Gemini: no fallback.
      'navigator.locationContext':  { primary: 'gemini', fallback: null,     fallbackSafe: false, timeoutMs: 25000 },
      'analyst.answer':             { primary: 'openai', fallback: 'gemini', fallbackSafe: true,  timeoutMs: 30000, maxToolSteps: 6, totalBudgetMs: 60000 },
    },

    allowFallback: flag('AI_ALLOW_FALLBACK'),
    mapsGrounding: flag('GEMINI_MAPS_GROUNDING'),
    allowedOrigins: env('AI_ALLOWED_ORIGINS').split(',').map(s => s.trim()).filter(Boolean),
    rateLimitPerMin: Number(env('AI_RATE_LIMIT_PER_MIN', '20')) || 20,

    limits: {
      interpretChars: 600,
      questionChars: 500,
      explainResources: 8,
      historyTurns: 3,
      historyChars: 700,
      bodyBytes: 16 * 1024,
    },
  };
}

export function providerConfigured(name) {
  return !!aiConfig().providers[name]?.apiKey;
}

/** Which user-facing features can run right now (used by /api/ai/status). */
export function featureAvailability() {
  const c = aiConfig();
  const can = (task) => {
    const t = c.tasks[task];
    if (providerConfigured(t.primary)) return true;
    return !!(c.allowFallback && t.fallbackSafe && t.fallback && providerConfigured(t.fallback));
  };
  return {
    navigator: can('navigator.interpret'),
    analyst: can('analyst.answer'),
    locationContext: c.mapsGrounding && providerConfigured('gemini'),
  };
}
