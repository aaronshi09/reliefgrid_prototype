/* POST /api/geo/geocode — resolve a street address or landmark (towns/ZIPs are resolved in the browser). */
import { createHandler } from '../../server/http.js';
import { geocode } from '../../server/geo/services.js';

export default createHandler({ handle: async (body) => ({ result: await geocode(body?.text) }) });
