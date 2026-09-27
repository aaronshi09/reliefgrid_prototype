/* POST /api/geo/route — route line to one ReliefGrid facility (drawn on the MapLibre map). */
import { createHandler } from '../../server/http.js';
import { routeLine } from '../../server/geo/services.js';

export default createHandler({ handle: (body) => routeLine({ origin: body?.origin, mode: body?.mode, facilityId: body?.facilityId }) });
