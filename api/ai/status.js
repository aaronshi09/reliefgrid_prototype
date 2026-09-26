/* GET /api/ai/status — which AI features are configured (never exposes keys). */
import { createHandler } from '../../server/http.js';
import { aiConfig, featureAvailability } from '../../server/ai/config.js';

export default createHandler({
  methods: ['GET'],
  handle: async () => {
    const c = aiConfig();
    const missing = [];
    if (!c.providers.gemini.apiKey) missing.push('GEMINI_API_KEY');
    if (!c.providers.openai.apiKey) missing.push('OPENAI_API_KEY');
    return { features: featureAvailability(), setup: { missing } };
  },
});
