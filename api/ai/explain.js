/* POST /api/ai/explain — Resource Navigator: explain ReliefGrid's own results (by id). */
import { createHandler } from '../../server/http.js';
import { explain } from '../../server/ai/workflows/navigator.js';

export default createHandler({ handle: (body) => explain(body) });
