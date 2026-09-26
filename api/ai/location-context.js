/* POST /api/ai/location-context — optional Google Maps–grounded context for one listing. */
import { createHandler } from '../../server/http.js';
import { locationContext } from '../../server/ai/workflows/navigator.js';

export default createHandler({ handle: (body) => locationContext(body) });
