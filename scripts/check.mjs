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
 *   - analytics: rules-first classification, off-topic / no-selection replies
 *     without a model call, only relevant data sent, ids filtered to the
 *     retrieved context, fabricated figures and siting directives flagged
 *   - missing key / 429 / 404 / network failure / timeout / malformed output
 *     all fail safely with user-safe codes
 * ==========================================================================*/
const root = new URL('../', import.meta.url);
process.env.GEMINI_API_KEY = 'check-key-DO-NOT-LEAK'; process.env.OPENAI_API_KEY = 'check';
delete process.env.AI_ALLOW_FALLBACK; delete process.env.GEMINI_MAPS_GROUNDING; delete process.env.GEMINI_MODEL; delete process.env.GEMINI_THINKING_LEVEL; delete process.env.OPENROUTESERVICE_API_KEY;

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
const needs = (o) => interaction({ requestType: 'service_request', categories: [], urgency: 'unspecified', transportation: 'unspecified', walkInsNeeded: false, householdContext: [], locationText: '', unmatchedNeeds: [], clarifyingQuestion: '', safetyConcern: false, nearMe: false, maxMiles: 0, maxMinutes: 0, distancePreference: 'any', ...o });

const nav = await import(new URL('server/ai/workflows/navigator.js', root));
const ana = await import(new URL('server/ai/workflows/analyst.js', root));
const { aiConfig } = await import(new URL('server/ai/config.js', root));
const { executeTool, ANALYST_TOOLS } = await import(new URL('server/data/analyst-tools.js', root));
const INTERPRET_SCHEMA_REQ = ['nearMe', 'maxMiles', 'maxMinutes', 'distancePreference'];
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

// ── Ask ReliefGrid: classification (rules first; no data involved).
const { classifyByRules } = await import(new URL('server/analytics/classify.js', root));
const expectDomains = [
  ['Where are the largest service gaps?', ['service_gap']],
  ['Which areas have high need but low access?', ['need_access']],
  ['Explain the service-gap layer.', ['map_explanation']],
  ['Compare walking and driving accessibility.', ['mode_comparison']],
  ['Where are the strongest spatial clusters?', ['lisa']],
  ['Where should another shelter be built?', ['investigation', 'category_access']],
  ['Where is emergency housing least accessible?', ['category_access']],
  ['What resources are located near this area?', ['resources', 'selected_area']],
  ['What is E2SFCA?', ['methodology']],
];
for (const [q, want] of expectDomains) {
  const c = classifyByRules(q, { selectedTract: '36103190605' });
  check(c.inScope === true && want.every(d => c.domains.includes(d)), `classifies "${q}" → ${c.domains.join(', ')}`);
}
for (const q of ['Write me an essay about World War II.', 'Who should I vote for?', 'What stock should I buy?']) {
  check(classifyByRules(q).inScope === false, `recognises off-topic: "${q}"`);
}
check(classifyByRules('Which neighborhoods are struggling the most?').inScope === null, 'ambiguous wording is left to the model classifier');

// ── Ask ReliefGrid: replies that must not call any model.
const callsBefore = sent.length;
queue = [];
r = await ana.analyze({ question: 'Write me an essay about World War II.' });
check(r.scope === 'out_of_scope' && sent.length === callsBefore, 'off-topic → scope message without a model call');
r = await ana.analyze({ question: 'Explain this area.', context: { mode: 'drive' } });
check(r.scope === 'needs_selection' && sent.length === callsBefore, '"this area" with nothing selected → asks for a selection, no model call');
r = await ana.analyze({ question: 'Tell me about tract 36999999999' });
check(r.scope === 'insufficient_data' && sent.length === callsBefore, 'unknown tract id → says ReliefGrid has no such tract, no model call');

// ── Ask ReliefGrid: retrieval → one structured OpenAI call → validation.
const oaiResp = (o) => ({ json: { id: 'resp_test', object: 'response', status: 'completed', model: 'gpt-6-luna', incomplete_details: null, error: null,
  output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: typeof o === 'string' ? o : JSON.stringify(o), annotations: [] }] }] } });
const brief = (o) => oaiResp({ status: 'answered', answer: 'x', keyFindings: [], referencedTractIds: [], referencedFacilityIds: [], suggestedLayer: 'none', limitations: [], followUps: [], ...o });
let captured = null;
queue = [(body) => { captured = body; const ctx = JSON.parse(body.input.split('CONTEXT:\n')[1]).context; const top = ctx.service_gap_ranking.tracts[0];
  return brief({ answer: `The largest Service Gap is in tract ${top.geoid} (${top.county}) at ${top.mismatch_index}, which is 47.3% above tract 36000000000.`,
    keyFindings: [{ text: `Top gap ${top.mismatch_index}.`, tractIds: [top.geoid, '36059999999'], facilityIds: ['made-up'] }],
    referencedTractIds: [top.geoid, '36111111111'], suggestedLayer: 'mismatch_index' }); }];
r = await ana.analyze({ question: 'Where are the largest service gaps?', context: { mode: 'drive', layer: 'lisa' } });
const oreq = sent.at(-1);
check(oreq.url.endsWith('/v1/responses'), 'analyst uses the OpenAI SDK Responses API');
check(captured.model === 'gpt-6-luna' && captured.store === false && captured.text?.format?.strict === true, 'configured model, store:false, strict JSON schema');
check(oreq.headers.authorization === 'Bearer check' && !oreq.raw.includes('"check"'), 'OpenAI key sent only as a header, never in the body');
const sentCtx = JSON.parse(captured.input.split('CONTEXT:\n')[1]).context;
check(Object.keys(sentCtx).join() === 'service_gap_ranking' && captured.input.length < 8000, `only the relevant data is sent (${Object.keys(sentCtx).join()}, ${captured.input.length} chars)`);
check(r.mapFocus.tractIds.length === 1 && r.mapFocus.layer === 'mismatch_index', 'map focus keeps only tracts from the retrieved context');
check(r.keyFindings[0].tractIds.length === 1 && r.keyFindings[0].facilityIds.length === 0, 'invented ids are removed from findings');
check(r.grounding.unverifiedFigures.includes('47.3%') && !r.grounding.unverifiedFigures.includes(String(sentCtx.service_gap_ranking.tracts[0].mismatch_index)), 'fabricated figures flagged; retrieved values pass');
check(r.grounding.unverifiedFigures.includes('36000000000'), 'tract ids not in the context are flagged');
check(r.metricsUsed.includes('Service Gap') && r.meta.provider === 'openai', '"Analysis based on" comes from the retrieval, not the model');

// Methodology is grounded in the project's own documentation.
queue = [(body) => { captured = body; return brief({ answer: 'Documented as an E2SFCA score within a 15-minute catchment.' }); }];
r = await ana.analyze({ question: 'What is E2SFCA?' });
const mctx = JSON.parse(captured.input.split('CONTEXT:\n')[1]).context;
check(Object.keys(mctx).join() === 'methodology' && mctx.methodology.documented_methods.some(m => /Enhanced 2-Step Floating Catchment Area/.test(m.text)), 'methodology questions receive the Data & Methods text from index.html (and nothing else)');

// Selected area context and siting framing.
queue = [(body) => { captured = body; return brief({ answer: 'Tract 36103190605 (Suffolk) has a high gap. The county should build a shelter in tract 36103190605.', referencedTractIds: ['36103190605'] }); }];
r = await ana.analyze({ question: 'Where should another shelter be built near this area?', context: { mode: 'drive', selectedTract: '36103190605' } });
const sctx = JSON.parse(captured.input.split('CONTEXT:\n')[1]).context;
check(sctx.selected_area?.tract?.geoid === '36103190605' && sctx.category_proximity && sctx.high_need_low_access, 'selected tract + need/access + shelter proximity retrieved for a siting question');
check(r.limitations[0].includes('zoning') && r.grounding.directiveLanguage === true, 'siting answers get the decision-support limitation; directive wording is flagged');
check(r.areas[0].geoid === '36103190605' && r.areas[0].role === 'selected', 'selected area is returned for map highlighting');

// Model-assisted classification only when rules are undecided.
queue = [
  (body) => { captured = body; return oaiResp({ inScope: true, domains: ['community_need'], category: 'none', mode: 'none', refersToSelection: false }); },
  brief({ answer: 'Highest need tracts listed.' }),
];
r = await ana.analyze({ question: 'Which neighborhoods are struggling the most?' });
check(captured.text.format.name === 'reliefgrid_route' && !captured.input.includes('need_score') && r.domains.join() === 'community_need' && r.meta.classifiedBy === 'model', 'undecided wording is routed by a data-free classification call');

// Failure modes (analyst).
queue = [{ status: 429, json: { error: { message: 'Rate limit' } } }];
await rejects(ana.analyze({ question: 'Where are the largest service gaps?' }), 'rate_limited', 'OpenAI rate limit → rate_limited');
queue = [{ status: 401, json: { error: { message: 'bad key' } } }];
await rejects(ana.analyze({ question: 'Where are the largest service gaps?' }), 'not_configured', 'invalid OpenAI key → not_configured');
queue = ['network'];
await rejects(ana.analyze({ question: 'Where are the largest service gaps?' }), 'unavailable', 'network failure → unavailable');
queue = [oaiResp('not json')];
await rejects(ana.analyze({ question: 'Where are the largest service gaps?' }), 'bad_output', 'malformed model output → bad_output');
queue = [{ json: { id: 'r', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] } }];
await rejects(ana.analyze({ question: 'Where are the largest service gaps?' }), 'blocked', 'model refusal → blocked');
queue = ['hang'];
const { openai: oaiProvider } = await import(new URL('server/ai/providers/openai.js', root));
await rejects(oaiProvider.generateJSON({ system: 's', prompt: 'p', schema: { type: 'object' }, timeoutMs: 1200 }), 'timeout', 'hung OpenAI requests time out');
queue = [{ status: 503, json: {} }];
await rejects(ana.analyze({ question: 'Where are the largest service gaps?' }), 'unavailable', 'no silent provider switch when fallback is disabled');
delete process.env.OPENAI_API_KEY;
await rejects(ana.analyze({ question: 'Where are the largest service gaps?' }), 'not_configured', 'missing OPENAI_API_KEY → not_configured');
process.env.OPENAI_API_KEY = 'check';
process.env.AI_ALLOW_FALLBACK = 'true';
queue = [{ status: 503, json: {} }, interaction({ status: 'answered', answer: 'Suffolk has more HH tracts.', keyFindings: [], referencedTractIds: [], referencedFacilityIds: [], suggestedLayer: 'lisa', limitations: [], followUps: [] })];
r = await ana.analyze({ question: 'Where are the strongest spatial clusters?' });
check(r.meta.fallbackUsed && r.meta.provider === 'gemini', 'opt-in fallback sends the same retrieved context to Gemini');
delete process.env.AI_ALLOW_FALLBACK;

// ── Location services (openrouteservice / Census mocked; no key, no network).
const geo = await import(new URL('server/geo/services.js', root));
const facs = facilities.features;
const foodNearHempstead = facs.filter(f => f.properties.resource_group === 'food').slice(0, 3).map(f => f.properties.facility_id);
await rejects(geo.travelTimes({ origin: [-73.62, 40.70], mode: 'walk', facilityIds: foodNearHempstead }), 'not_configured', 'travel times need OPENROUTESERVICE_API_KEY');
process.env.OPENROUTESERVICE_API_KEY = 'ors-check-key';
let orsBody = null;
queue = [(body) => { orsBody = body; return { json: { durations: [[600, 1200, null]], distances: [[800, 1600, null]] } }; }];
r = await geo.travelTimes({ origin: [-73.6243219, 40.7001234], mode: 'walk', facilityIds: [...foodNearHempstead, 'invented:999'] });
const oreqGeo = sent.at(-1);
check(oreqGeo.url.endsWith('/v2/matrix/foot-walking') && oreqGeo.headers.authorization === 'ors-check-key' && !oreqGeo.raw.includes('ors-check-key'), 'Matrix request: walking profile, key only in the Authorization header');
check(JSON.stringify(orsBody.locations[0]) === '[-73.624,40.7]', 'origin rounded to ~100 m before leaving the server');
check(orsBody.locations.length === 4 && JSON.stringify(orsBody.sources) === '[0]' && JSON.stringify(orsBody.destinations) === '[1,2,3]', 'destinations are only known ReliefGrid facilities (invented id dropped)');
check(JSON.stringify(orsBody.locations[1]) === JSON.stringify(facs.find(f => f.properties.facility_id === foodNearHempstead[0]).geometry.coordinates), 'destination coordinates come from the ReliefGrid dataset');
check(r.times[0].durationSec === 600 && r.times[2].durationSec === null, 'durations returned as-is; unroutable → null');
const callsNow = sent.length;
r = await geo.travelTimes({ origin: [-73.6243219, 40.7001234], mode: 'walk', facilityIds: foodNearHempstead });
check(sent.length === callsNow && r.cached === true, 'identical repeat request is served from the short in-memory cache (no new API call)');
await rejects(geo.travelTimes({ origin: [-118.24, 34.05], mode: 'walk', facilityIds: foodNearHempstead }), 'invalid_request', 'origins outside the service area are rejected');
await rejects(geo.travelTimes({ origin: [-73.62, 40.70], mode: 'transit', facilityIds: foodNearHempstead }), 'invalid_request', 'unsupported travel modes (e.g. transit) are rejected, not faked');
const many = facs.slice(0, 60).map(f => f.properties.facility_id);
queue = [(body) => { orsBody = body; return { json: { durations: [Array(25).fill(60)], distances: [Array(25).fill(100)] } }; }];
await geo.travelTimes({ origin: [-73.5, 40.75], mode: 'drive', facilityIds: many });
check(orsBody.destinations.length === 25 && sent.at(-1).url.endsWith('/driving-car'), 'at most 25 destinations per request; driving profile');
queue = [{ status: 429, json: { error: 'quota' } }];
await rejects(geo.travelTimes({ origin: [-73.4, 40.8], mode: 'walk', facilityIds: foodNearHempstead }), 'rate_limited', 'routing quota exceeded → rate_limited');
// Geocoding: Census address match, then landmark fallback, then not found.
queue = [{ json: { result: { addressMatches: [{ coordinates: { x: -73.6257164, y: 40.7176187 }, matchedAddress: '1 WASHINGTON CT, HEMPSTEAD, NY, 11550' }] } } }];
r = await geo.geocode('1 Washington St, Hempstead');
check(r.precision === 'address' && JSON.stringify(r.coords) === '[-73.626,40.718]' && sent.at(-1).url.includes('geocoding.geo.census.gov'), 'street address → U.S. Census Geocoder, coordinates rounded');
queue = [{ json: { result: { addressMatches: [] } } }, { json: { features: [{ geometry: { coordinates: [-73.6, 40.715] }, properties: { label: 'Hofstra University, Hempstead, NY', layer: 'venue' } }] } }];
r = await geo.geocode('Hofstra University');
check(r?.precision === 'place' && /openrouteservice/.test(r.source), 'landmark → openrouteservice search when Census has no match');
queue = [{ json: { result: { addressMatches: [{ coordinates: { x: -118.24, y: 34.05 }, matchedAddress: 'LOS ANGELES' }] } } }, { json: { features: [] } }];
check(await geo.geocode('123 Main St Los Angeles') === null, 'locations outside Long Island are not accepted');
delete process.env.OPENROUTESERVICE_API_KEY;

// Gemini location / transport intent (intent only — never computed distances).
queue = [needs({ categories: ['food'], transportation: 'walking', nearMe: true, maxMiles: 2, maxMinutes: 900, distancePreference: 'close', locationText: '11030' })];
r = await nav.interpret('I need food near me within 2 miles, somewhere I can walk to');
check(r.needs.nearMe === true && r.needs.maxMiles === 2 && r.needs.maxMinutes === null && r.needs.distancePreference === 'close', 'location intent fields sanitised (out-of-range limits dropped)');
check(r.needs.locationText === '11030', 'a ZIP code is accepted as a location; street addresses still are not');
check(INTERPRET_SCHEMA_REQ.every(k => sent.at(-1).body.response_format.schema.required.includes(k)), 'schema requires the new intent fields');
queue = [interaction({ picks: [{ facilityId: foodNearHempstead[1], reasons: ['closest'] }, { facilityId: foodNearHempstead[0], reasons: ['closest'] }] })];
r = await nav.explain({ needs: { categories: ['food'] }, resources: [
  { id: foodNearHempstead[0], status: 'unknown', distanceMiles: 0.5, travelMinutes: 20, travelMode: 'walk' },
  { id: foodNearHempstead[1], status: 'unknown', distanceMiles: 0.9, travelMinutes: 12, travelMode: 'walk' },
] });
check(r.picks[0].reasons.includes('closest') && !r.picks[1].reasons.includes('closest'), '"closest" is verified against routed travel minutes, not straight-line distance');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
