/* POST /api/ai/interpret — Resource Navigator: text → structured needs. */
import { createHandler } from '../../server/http.js';
import { interpret } from '../../server/ai/workflows/navigator.js';

export default createHandler({ handle: (body) => interpret(body?.text) });
