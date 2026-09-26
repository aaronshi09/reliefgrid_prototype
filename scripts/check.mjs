/* ============================================================================
 * ReliefGrid — offline checks for the AI layer (no API keys, no network).
 *   npm run check
 * Provider HTTP calls are replaced with scripted responses so the grounding
 * guarantees can be verified deterministically:
 *   - requests map only onto existing categories; addresses never become a location
 *   - personal numbers are redacted before any provider call
 *   - explanations may only reference ids ReliefGrid returned
 *   - analyst ids are filtered to tool output; fabricated figures are flagged
 *   - answers that consulted no data are rejected
 *   - fallback happens only when enabled; malformed / blocked output fails safely
 * ==========================================================================*/
const root = new URL('../', import.meta.url);
process.env.GEMINI_API_KEY = 'check'; process.env.OPENAI_API_KEY = 'check';
delete process.env.AI_ALLOW_FALLBACK; delete process.env.GEMINI_MAPS_GROUNDING;

const sent = []; let queue = [];
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body); sent.push({ url: String(url), body, headers: init.headers });
  const next = queue.shift(); if (!next) throw new Error('unexpected provider call');
  const r = typeof next === 'function' ? next(body) : next;
  return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.json };
};
const gem = (o) => ({ json: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: typeof o === 'string' ? o : JSON.stringify(o) }] } }] } });
const oai = (m) => ({ json: { choices: [{ finish_reason: 'stop', message: m }] } });
const emptyFocus = { tractIds: [], facilityIds: [], layer: null, mode: null };

const nav = await import(new URL('server/ai/workflows/navigator.js', root));
const ana = await import(new URL('server/ai/workflows/analyst.js', root));
const { executeTool, ANALYST_TOOLS } = await import(new URL('server/data/analyst-tools.js', root));

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failures++; };
const rejects = async (p, code, msg) => { try { await p; check(false, msg); } catch (e) { check(e.code === code, `${msg} (${e.code})`); } };

// Data tools read the real files.
const ov = await executeTool('get_study_overview', { mode: 'drive' });
check(ov.tract_count === 665 && ov.resources.total === 182, 'data tools read the real tract / facility files');
check(ANALYST_TOOLS.every(t => t.name && t.parameters?.type === 'object'), 'tool definitions are well-formed');
const inc = await executeTool('rank_tracts', { metric: 'mismatch_index', order: 'highest', mode: 'drive', limit: 15 });
check(inc.tracts.every(t => t.median_household_income === null || t.median_household_income > 0), 'ACS "not available" sentinels become null');

// Navigator: interpret.
queue = [gem({ categories: ['shelter', 'food', 'hotels'], urgency: 'immediate', transportation: 'no_car', walkInsNeeded: false, household: { children: true }, locationText: '12 Main St', unmatchedNeeds: ['childcare'], clarifyingQuestion: 'x', safetyConcern: false })];
let r = await nav.interpret('Somewhere to sleep tonight, no car, kids. Call 516-555-1234');
check(JSON.stringify(r.needs.categories) === '["shelter","food"]', 'unknown categories are dropped');
check(r.needs.locationText === null, 'street addresses are never used as a location');
check(!JSON.stringify(sent.at(-1).body).includes('555-1234'), 'phone numbers are redacted before the provider call');
check(r.meta.provider === 'gemini', 'Resource Navigator routes to Gemini');

// Navigator: explain.
queue = [gem({ summary: 'Two listings match. Call ahead to confirm.', picks: [{ facilityId: 'rhy:9457d87593', reason: 'Listed shelter in Nassau.' }, { facilityId: 'invented:1', reason: 'x' }], caution: null })];
r = await nav.explain({ needs: { categories: ['shelter'] }, resources: [{ id: 'rhy:9457d87593', status: 'available' }, { id: 'invented:2', status: 'available' }] });
check(r.picks.length === 1 && r.picks[0].facilityId === 'rhy:9457d87593', 'explanations may only reference ReliefGrid results');
check(!JSON.stringify(sent.at(-1).body).includes('invented:2'), 'unknown ids are never sent to the model');
queue = [gem({ summary: 'Call 631-555-0000 now', picks: [], caution: null })];
await rejects(nav.explain({ needs: {}, resources: [{ id: 'rhy:9457d87593' }] }), 'bad_output', 'model-invented contact details are rejected');

// Analyst: tool loop + grounding.
queue = [
  oai({ content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'rank_tracts', arguments: JSON.stringify({ metric: 'mismatch_index', order: 'highest', mode: 'drive', cluster: 'HH', limit: 3 }) } }] }),
  oai({ content: JSON.stringify({ answerable: true, answer: 'Tract 36103190605 (Suffolk) has a gap of 2.94 and access 2.3 — 47.3% worse than tract 36000000000.', keyFindings: [{ text: 'Need 1.38.', tractIds: ['36103190605', '36059999999'], facilityIds: ['made-up'] }], mapFocus: { tractIds: ['36103190605', '36111111111'], facilityIds: [], layer: 'lisa', mode: 'drive' }, limitations: [], followUps: [] }) }),
];
r = await ana.analyze({ question: 'Where are the largest gaps?', context: { mode: 'drive' } });
check(JSON.stringify(r.mapFocus.tractIds) === '["36103190605"]', 'map focus keeps only tracts returned by tools');
check(r.keyFindings[0].facilityIds.length === 0, 'invented facility ids are removed');
check(r.grounding.unverifiedFigures.includes('47.3%') && !r.grounding.unverifiedFigures.includes('2.94'), 'fabricated figures are flagged, real ones pass');
check(r.grounding.unverifiedFigures.includes('36000000000'), 'unknown GEOIDs in prose are flagged');
check(r.meta.provider === 'openai', 'Ask ReliefGrid routes to OpenAI');
queue = [oai({ content: JSON.stringify({ answerable: true, answer: 'Suffolk is worse.', keyFindings: [], mapFocus: emptyFocus, limitations: [], followUps: [] }) })];
await rejects(ana.analyze({ question: 'Which county is worse?' }), 'bad_output', 'answers that consulted no data are rejected');

// Fallback policy.
queue = [{ status: 503, json: {} }];
await rejects(ana.analyze({ question: 'Compare counties' }), 'unavailable', 'no silent provider switch when fallback is disabled');
process.env.AI_ALLOW_FALLBACK = 'true';
queue = [
  { status: 503, json: {} },
  { json: { candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'summarize_by_county', args: { mode: 'drive' } } }] } }] } },
  gem({ answerable: true, answer: 'Suffolk has 127 HH tracts (33.1%); Nassau has 29 (10.3%).', keyFindings: [], mapFocus: emptyFocus, limitations: [], followUps: [] }),
];
r = await ana.analyze({ question: 'Compare counties' });
check(r.meta.fallbackUsed && r.meta.provider === 'gemini' && r.grounding.unverifiedFigures.length === 0, 'opt-in fallback uses the same data tools on the other provider');
delete process.env.AI_ALLOW_FALLBACK;

// Failure modes.
queue = [gem('not json')];
await rejects(nav.interpret('need food'), 'bad_output', 'malformed model output fails safely');
queue = [{ json: { promptFeedback: { blockReason: 'SAFETY' } } }];
await rejects(nav.interpret('need food'), 'blocked', 'blocked prompts fail safely');
await rejects(nav.locationContext({ facilityId: 'rhy:9457d87593' }), 'not_configured', 'Google Maps grounding is off unless enabled');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
