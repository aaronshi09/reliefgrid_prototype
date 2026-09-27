/* POST /api/geo/travel-times — walk/drive times from an origin to ReliefGrid facilities (by id). */
import { createHandler } from '../../server/http.js';
import { travelTimes } from '../../server/geo/services.js';

export default createHandler({ handle: (body) => travelTimes({ origin: body?.origin, mode: body?.mode, facilityIds: body?.facilityIds }) });
