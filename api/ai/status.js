/* GET /api/ai/status — which AI / location features are configured (never exposes keys). */
import { createHandler } from '../../server/http.js';
import { aiConfig, featureAvailability } from '../../server/ai/config.js';
import { routingConfigured } from '../../server/geo/config.js';

export default createHandler({
  methods: ['GET'],
  handle: async () => {
    const c = aiConfig();
    const missing = [];
    if (!c.providers.gemini.apiKey) missing.push('GEMINI_API_KEY');
    if (!c.providers.openai.apiKey) missing.push('OPENAI_API_KEY');
    if (!routingConfigured()) missing.push('OPENROUTESERVICE_API_KEY');
    return {
      features: featureAvailability(),
      // addressLookup uses the public U.S. Census Geocoder (no key needed).
      location: { addressLookup: true, travelTimes: routingConfigured(), routeLines: routingConfigured() },
      setup: { missing },
    };
  },
});
