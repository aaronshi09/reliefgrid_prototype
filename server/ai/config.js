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
 *   GEMINI_MODEL              default gemini-3.5-flash-lite (the ONLY place the
 *                             default Gemini model is named)
 *   GEMINI_THINKING_LEVEL     optional: minimal | low | medium | high. Unset =
 *                             the model's own default (minimal on Flash-Lite)
 *   OPENAI_MODEL              default gpt-6-luna (the ONLY place the default
 *                             OpenAI model is named)
 *   OPENAI_REASONING_EFFORT   default low (none | low | medium | high)
 *   AI_ALLOW_FALLBACK         "true" → route to the other provider when the
 *                             primary is unavailable, for tasks marked
 *                             fallbackSafe (same data, same capabilities)
 *   GEMINI_MAPS_GROUNDING     "true" → enable the optional Google Maps
 *                             travel/area context on resource detail pages
 *   AI_ALLOWED_ORIGINS        comma-separated origins allowed to call the API
 *                             cross-origin (e.g. a GitHub Pages frontend)
 *   AI_RATE_LIMIT_PER_MIN     per-IP request budget (default 40)
 * Values are read lazily so the local dev server can load .env first.
 * ==========================================================================*/
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const flag = (k) => env(k).toLowerCase() === 'true';
const DEFAULT_ALLOWED_ORIGINS = ['https://aaronshi09.github.io'];

export function aiConfig() {
  return {
    providers: {
      gemini: {
        apiKey: env('GEMINI_API_KEY'),
        // Flash-Lite: Google's fastest, lowest-cost current Gemini model — the
        // right fit for short structured-interpretation calls. (gemini-2.5-flash
        // is deprecated with limited access.) Override with GEMINI_MODEL.
        model: env('GEMINI_MODEL', 'gemini-3.5-flash-lite'),
        thinkingLevel: env('GEMINI_THINKING_LEVEL') || null,
      },
      openai: {
        apiKey: env('OPENAI_API_KEY'),
        // GPT-6 Luna: OpenAI's efficient tier for focused, high-volume work, with
        // Structured Outputs. ReliefGrid retrieves the data deterministically, so
        // the model only interprets supplied values — a job that doesn't need the
        // pricier Sol / Astra tiers. Override with OPENAI_MODEL.
        model: env('OPENAI_MODEL', 'gpt-6-luna'),
        reasoningEffort: env('OPENAI_REASONING_EFFORT', 'low') || null,
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
      // Ask ReliefGrid: optional question classification (only when the rules
      // can't decide) and the grounded explanation of retrieved data.
      'analyst.classify':           { primary: 'openai', fallback: 'gemini', fallbackSafe: true,  timeoutMs: 12000 },
      'analyst.answer':             { primary: 'openai', fallback: 'gemini', fallbackSafe: true,  timeoutMs: 40000 },
    },

    allowFallback: flag('AI_ALLOW_FALLBACK'),
    mapsGrounding: flag('GEMINI_MAPS_GROUNDING'),
    // Cross-origin callers allowed to use this backend. The GitHub Pages copy of
    // the site (static only) calls the Vercel API; extend with AI_ALLOWED_ORIGINS.
    allowedOrigins: [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...env('AI_ALLOWED_ORIGINS').split(',').map(s => s.trim()).filter(Boolean)])],
    // Each Find Help search uses up to 2 requests; people at a demo often share one IP.
    rateLimitPerMin: Number(env('AI_RATE_LIMIT_PER_MIN', '40')) || 40,

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
