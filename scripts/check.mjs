/* ============================================================================
 * ReliefGrid — offline checks for the AI layer (no API keys, no network).
 *   npm run check
 * Provider HTTP calls (made through the official @google/genai SDK and the
 * OpenAI REST API) are answered by a local stub, so the guarantees below are
 * verified deterministically:
 *   - requests map only onto existing categories; off-topic requests never search
 *   - text Gemini writes can't smuggle resource facts (names, numbers, links)
 *   - suggestions may only reference ids ReliefGrid returned, with reason codes
 *     that the data actually supports
 *   - personal numbers are redacted; the API key never appears in a request body;
 *     requests are sent with store:false
 *   - analyst ids are filtered to tool output; fabricated figures are flagged
 *   - missing key / 429 / 404 / network failure / timeout / malformed output
 *     all fail safely with user-safe codes
 * ==========================================================================*/
const root = new URL('../', import.meta.url);
process.env.GEMINI_API_KEY = 'check-key-DO-NOT-LEAK'; process.env.OPENAI_API_KEY = 'check';
delete process.env.AI_ALLOW_FALLBACK; delete process.env.GEMINI_MAPS_GROUNDING; delete process.env.GEMINI_MODEL; delete process.env.GEMINI_THINKING_LEVEL;

const sent = []; let queue = [];
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const raw = init.body != null ? (typeof init.body === 'string' ? init.body : await new Response(init.body).text()) : (typeof input !== 'string' ? await input.clone().text() : '');
  const headers = Object.fromEntries(new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined)).entries());
  const signal = init.signal || (typeof input !== 'string' ? input.signal : null);
  sent.push({ url, body: raw ? JSON.parse(raw) : null, raw, headers });
  const next = queue.shift(); if (!next) throw new Error('unexpected provider call');
  if (next === 'network') throw new TypeError('fetch failed');
  if (next === 'hang') return new Promise((_, rej) => signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const r = typeof next === 'function' ? next(sent.at(-1).body) : next;
  return new Response(JSON.stringify(r.json ?? {}), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
};
// Interactions API (structured output) and generateContent (tool loop) response shapes.
const interaction = (o) => ({ json: { id: 'int_test', status: 'completed', steps: [{ type: 'user_input', content: [{ type: 'text', text: '…' }] }, { type: 'model_output', content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] }] } });
const gen = (parts) => ({ json: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] } });
const oai = (m) => ({ json: { choices: [{ finish_reason: 'stop', message: m }] } });
const emptyFocus = { tractIds: [], facilityIds: [], layer: null, mode: null };
const needs = (o) => interaction({ requestType: 'service_request', categories: [], urgency: 'unspecified', transportation: 'unspecified', walkInsNeeded: false, householdContext: [], locationText: '', unmatchedNeeds: [], clarifyingQuestion: '', safetyConcern: false, ...o });

const nav = await import(new URL('server/ai/workflows/navigator.js', root));
const ana = await import(new URL('server/ai/workflows/analyst.js', root));
const { aiConfig } = await import(new URL('server/ai/config.js', root));
const { executeTool, ANALYST_TOOLS } = await import(new URL('server/data/analyst-tools.js', root));
const facilities = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('longisland_facilities.geojson', root), 'utf8'));
const realIds = new Set(facilities.features.map(f => f.properties.facility_id));

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };
const rejects = async (p, code, msg) => { try { await p; check(false, msg); } catch (e) { check(e.code === code, `${msg} (${e.code})`); } };

// ── Data tools read the real files.
const ov = await executeTool('get_study_overview', { mode: 'drive' });
check(ov.tract_count === 665 && ov.resources.total === 182, 'data tools read the real tract / facility files');
check(ANALYST_TOOLS.every(t => t.name && t.parameters?.type === 'object'), 'tool definitions are well-formed');

// ── Navigator: interpret.
check(aiConfig().providers.gemini.model === 'gemini-3.5-flash-lite', 'default Gemini model comes from central config');
queue = [needs({ categories: ['shelter', 'food', 'hotels'], urgency: 'immediate', transportation: 'no_car', householdContext: ['children', 'wizard'], locationText: '12 Main St', unmatchedNeeds: ['childcare'], clarifyingQuestion: 'x', resources: [{ name: 'Invented Shelter', phone: '555-0100' }] })];
let r = await nav.interpret('Somewhere to sleep tonight, no car, kids. Call 516-555-1234');
const req = sent.at(-1);
check(req.url.endsWith('/v1beta/interactions'), 'navigator uses the SDK Interactions API');
check(req.body.model === 'gemini-3.5-flash-lite' && req.body.store === false, 'request uses the configured model and store:false');
check(req.body.response_format?.mime_type === 'application/json' && req.body.response_format?.schema?.properties?.categories, 'structured JSON schema is sent');
check(req.headers['x-goog-api-key'] === 'check-key-DO-NOT-LEAK' && !req.raw.includes('check-key-DO-NOT-LEAK'), 'API key sent only as a header, never in the body');
check(!req.raw.includes('555-1234'), 'phone numbers are redacted before the provider call');
check(JSON.stringify(r.needs.categories) === '["shelter","food"]', 'unknown categories are dropped');
check(JSON.stringify(r.needs.householdContext) === '["children"]', 'unknown household values are dropped');
check(r.needs.locationText === null, 'street addresses are never used as a location');
check(!('resources' in r.needs) && !JSON.stringify(r).includes('Invented Shelter'), 'extra fields the model invents (e.g. resources) are discarded');
check(r.meta.provider === 'gemini', 'Resource Navigator routes to Gemini');

queue = [needs({ requestType: 'unrelated', categories: ['legal'], clarifyingQuestion: 'Sure! Here is an essay about George Washington…' })];
r = await nav.interpret('Write me an essay about George Washington.');
check(r.needs.requestType === 'unrelated' && r.needs.categories.length === 0 && r.needs.clarifyingQuestion === null, 'off-topic requests never trigger a search or show model text');
queue = [needs({ requestType: 'unclear', clarifyingQuestion: 'What kind of help are you looking for?' })];
r = await nav.interpret('I need help.');
check(r.needs.requestType === 'unclear' && r.needs.clarifyingQuestion === 'What kind of help are you looking for?', 'vague requests get one clarifying question');
queue = [needs({ requestType: 'unclear', clarifyingQuestion: 'Try Hope House at 12 Main St, call 631-555-0100', unmatchedNeeds: ['Hope House 12 Main St', 'childcare'] })];
r = await nav.interpret('help');
check(r.needs.clarifyingQuestion === null && JSON.stringify(r.needs.unmatchedNeeds) === '["childcare"]', 'model text that looks like resource facts is dropped');

// ── Navigator: ranking ("suggested first calls").
const shelterId = 'rhy:9457d87593';
const foodId = facilities.features.find(f => f.properties.resource_group === 'food').properties.facility_id;
queue = [interaction({ picks: [
  { facilityId: 'invented:1', reasons: ['closest'] },
  { facilityId: foodId, reasons: ['listed_available', 'walk_ins', 'closest', 'matches_need'] },
  { facilityId: shelterId, reasons: ['mentions_families', 'hallucinated_code'] },
] })];
r = await nav.explain({ needs: { categories: ['shelter', 'food'] }, resources: [
  { id: shelterId, status: 'available', openNow: true, walkIns: false, distanceMiles: 2.0 },
  { id: foodId, status: 'unknown', openNow: false, walkIns: false, distanceMiles: 5.5 },
  { id: 'invented:2', status: 'available' },
] });
check(r.picks.every(p => realIds.has(p.facilityId)) && r.picks.length === 2, 'suggestions only reference ids ReliefGrid returned');
check(JSON.stringify(r.picks.find(p => p.facilityId === foodId).reasons) === '["matches_need"]', 'reason codes the data does not support are removed');
check(JSON.stringify(r.picks.find(p => p.facilityId === shelterId).reasons) === '["mentions_families"]', 'supported codes kept; unknown codes dropped');
check(!sent.at(-1).raw.includes('invented:2'), 'unknown ids are never sent to the model');
check(!('summary' in r), 'no free-text resource summary is produced');

// ── Failure modes (navigator).
queue = [interaction('not json')];
await rejects(nav.interpret('need food'), 'bad_output', 'malformed model output fails safely');
queue = [{ json: { id: 'x', status: 'failed', errors: [{ message: 'Blocked by safety filters' }] } }];
await rejects(nav.interpret('need food'), 'blocked', 'safety-blocked interactions fail safely');
queue = [{ status: 429, json: { error: { code: 429, message: 'quota' } } }];
await rejects(nav.interpret('need food'), 'rate_limited', 'rate limiting is reported as rate_limited');
queue = [{ status: 404, json: { error: { code: 404, message: 'model not found' } } }];
await rejects(nav.interpret('need food'), 'unavailable', 'unknown model is reported as unavailable');
queue = ['network'];
await rejects(nav.interpret('need food'), 'unavailable', 'network failure is reported as unavailable');
const saved = aiConfig().tasks['navigator.interpret'].timeoutMs;
queue = ['hang'];
const t0 = Date.now();
const { gemini } = await import(new URL('server/ai/providers/gemini.js', root));
await rejects(gemini.generateJSON({ system: 's', prompt: 'p', schema: { type: 'object' }, timeoutMs: 1200 }), 'timeout', `hung requests time out (${saved}ms budget in production)`);
check(Date.now() - t0 < 5000, 'timeout fires promptly');
delete process.env.GEMINI_API_KEY;
await rejects(nav.interpret('need food'), 'not_configured', 'missing GEMINI_API_KEY is reported as not_configured');
process.env.GEMINI_API_KEY = 'check-key-DO-NOT-LEAK';
await rejects(nav.locationContext({ facilityId: shelterId }), 'not_configured', 'Google Maps grounding is off unless enabled');

// ── Analyst: tool loop + grounding.
queue = [
  oai({ content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'rank_tracts', arguments: JSON.stringify({ metric: 'mismatch_index', order: 'highest', mode: 'drive', cluster: 'HH', limit: 3 }) } }] }),
  oai({ content: JSON.stringify({ answerable: true, answer: 'Tract 36103190605 (Suffolk) has a gap of 2.94 and access 2.3 — 47.3% worse than tract 36000000000.', keyFindings: [{ text: 'Need 1.38.', tractIds: ['36103190605', '36059999999'], facilityIds: ['made-up'] }], mapFocus: { tractIds: ['36103190605', '36111111111'], facilityIds: [], layer: 'lisa', mode: 'drive' }, limitations: [], followUps: [] }) }),
];
r = await ana.analyze({ question: 'Where are the largest gaps?', context: { mode: 'drive' } });
check(JSON.stringify(r.mapFocus.tractIds) === '["36103190605"]', 'map focus keeps only tracts returned by tools');
check(r.keyFindings[0].facilityIds.length === 0, 'invented facility ids are removed');
check(r.grounding.unverifiedFigures.includes('47.3%') && !r.grounding.unverifiedFigures.includes('2.94'), 'fabricated figures are flagged, real ones pass');
queue = [oai({ content: JSON.stringify({ answerable: true, answer: 'Suffolk is worse.', keyFindings: [], mapFocus: emptyFocus, limitations: [], followUps: [] }) })];
await rejects(ana.analyze({ question: 'Which county is worse?' }), 'bad_output', 'answers that consulted no data are rejected');
queue = [{ status: 503, json: {} }];
await rejects(ana.analyze({ question: 'Compare counties' }), 'unavailable', 'no silent provider switch when fallback is disabled');
process.env.AI_ALLOW_FALLBACK = 'true';
queue = [
  { status: 503, json: {} },
  gen([{ functionCall: { name: 'summarize_by_county', args: { mode: 'drive' } } }]),
  gen([{ text: JSON.stringify({ answerable: true, answer: 'Suffolk has 127 HH tracts (33.1%); Nassau has 29 (10.3%).', keyFindings: [], mapFocus: emptyFocus, limitations: [], followUps: [] }) }]),
];
r = await ana.analyze({ question: 'Compare counties' });
check(r.meta.fallbackUsed && r.meta.provider === 'gemini' && r.grounding.unverifiedFigures.length === 0, 'opt-in fallback uses the same data tools on Gemini (SDK generateContent)');
delete process.env.AI_ALLOW_FALLBACK;

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
