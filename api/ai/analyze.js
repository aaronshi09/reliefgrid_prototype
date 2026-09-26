/* POST /api/ai/analyze — Ask ReliefGrid: grounded analysis over ReliefGrid data tools. */
import { createHandler } from '../../server/http.js';
import { analyze } from '../../server/ai/workflows/analyst.js';

export default createHandler({ handle: (body) => analyze(body) });
