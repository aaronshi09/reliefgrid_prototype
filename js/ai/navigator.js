/* ============================================================================
 * ReliefGrid AI — Resource Navigator (consumer "Find Help" experience).
 * ----------------------------------------------------------------------------
 *   natural-language request
 *     → POST /api/ai/interpret   (AI → structured needs, mapped onto the
 *                                 EXISTING seeker categories / filters)
 *     → applySeekerPlan()        (ReliefGrid's own computeResults() over the
 *                                 verified facility dataset — same rules as
 *                                 the guided flow, same relaxation safety net)
 *     → POST /api/ai/explain     (optional "suggested first calls": the AI
 *                                 picks among the ids ReliefGrid returned and
 *                                 reason codes the server verifies; all text
 *                                 shown is rendered here from ReliefGrid data)
 * The language model never produces a resource or any resource text.
 * ==========================================================================*/
import {
  Availability, SEEKER_CATEGORIES, findFacilityFeature, escapeHtml, kmToMiles, haversineKm,
  setFacilityEmphasis,
} from '../shared.js';
import {
  applySeekerPlan, updateSeekerQuery, onSeekerResultsRendered, setSeekerLocation, getSeekerQuery,
  focusFacilityOnMap, openSeekerDetail, WALKIN_RELEVANT_CATEGORIES, useMyLocation, submitLocationText,
} from '../seeker.js';
import { aiRequest, getAIStatus, loadAIStatus, redactSensitive, setupNoticeHTML, AIClientError } from './client.js';
import { AI_CLIENT_CONFIG } from './config.js';
import { resolveLocationText, formatDuration } from '../location.js';

const $ = (id) => document.getElementById(id);
const CAT_LABEL = Object.fromEntries(SEEKER_CATEGORIES.map(c => [c.id, c.label]));
const EXAMPLES = [
  'I need somewhere safe to sleep tonight and I don’t have a car',
  'I’m a mother with two kids. We need food and a safe place to stay',
  'I’m being evicted and need legal help',
  'I need to see a doctor but I don’t have insurance',
];
const TRAVEL_LABEL = { walking: 'Walking', no_car: 'No car', public_transit: 'Public transit', driving: 'Driving' };
const URGENCY_LABEL = { immediate: 'Needed now', soon: 'Needed in the next few days', planning: 'Planning ahead' };

/* The current AI session (kept in memory only — never persisted). */
let session = null;
let busy = false;
let lastResults = null;

export function initNavigator() {
  renderExamples();
  $('navigator-form')?.addEventListener('submit', (e) => { e.preventDefault(); submit($('navigator-input').value); });
  $('navigator-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e.target.value); }
  });
  $('navigator-input')?.addEventListener('input', updateCounter);
  document.addEventListener('rg:ai-status', renderAvailability);
  document.addEventListener('rg:seeker-detail-rendered', (e) => renderLocationContextEntry(e.detail?.facilityId));
  onSeekerResultsRendered(onResults);
  document.addEventListener('rg:location-changed', renderNavigatorLocation);
  renderNavigatorLocation();
  loadAIStatus().then(renderAvailability);
  updateCounter();
}

/* ── Home: optional search location (never requested automatically) ──── */
function renderNavigatorLocation() {
  const el = $('navigator-location'); if (!el) return;
  const q = getSeekerQuery();
  el.innerHTML = q.userCoords
    ? `<span class="nav-loc-label">Searching near</span><strong>${escapeHtml(q.locationLabel)}</strong><button type="button" class="link-btn" data-nav-loc="change">Change</button><button type="button" class="link-btn" data-nav-loc="clear">Clear</button>`
    : `<span class="nav-loc-label">Location (optional)</span><button type="button" class="chip-btn" data-nav-loc="use">Use my location</button><button type="button" class="chip-btn" data-nav-loc="change">Type a town or ZIP</button>`;
  el.querySelectorAll('[data-nav-loc]').forEach(btn => btn.addEventListener('click', async () => {
    const k = btn.dataset.navLoc;
    if (k === 'use') await useMyLocation();
    else if (k === 'clear') updateSeekerQuery({ clearLocation: true });
    else { const input = $('seeker-location-input'); input?.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => input?.focus(), 250); }
  }));
}

/* ── Home: availability / setup state ─────────────────────────────────── */
function renderAvailability() {
  const s = getAIStatus();
  const form = $('navigator-form'); const setup = $('navigator-setup');
  if (!form || !setup) return;
  const on = s.checked && s.navigator;
  form.classList.toggle('is-disabled', !on);
  $('navigator-input').disabled = !on;
  $('navigator-submit').disabled = !on;
  document.querySelectorAll('#navigator-examples button').forEach(b => { b.disabled = !on; });
  if (!s.checked) { setup.innerHTML = ''; return; }
  setup.innerHTML = on ? '' : setupNoticeHTML('navigator');
  $('navigator-input').placeholder = on
    ? 'e.g. I need somewhere safe to sleep tonight and I don’t have a car'
    : 'AI search is not available on this deployment';
}
function renderExamples() {
  const el = $('navigator-examples'); if (!el) return;
  el.innerHTML = EXAMPLES.map(t => `<button type="button" class="example-chip">${escapeHtml(t)}</button>`).join('');
  el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { $('navigator-input').value = b.textContent; updateCounter(); submit(b.textContent); }));
}
function updateCounter() {
  const el = $('navigator-count'); const input = $('navigator-input'); if (!el || !input) return;
  const n = input.value.length, max = AI_CLIENT_CONFIG.limits.requestChars;
  el.textContent = n > max * 0.8 ? `${n}/${max}` : '';
}
function setStatus(html, kind = 'info') {
  const el = $('navigator-status'); if (!el) return;
  el.className = `ai-status ai-status-${kind}`;
  el.innerHTML = html;
  el.hidden = !html;
}
function progressHTML(step) {
  const steps = ['Understanding your needs…', 'Searching verified ReliefGrid resources…'];
  return `<div class="ai-progress">${steps.map((s, i) => `<div class="ai-step ${i < step ? 'done' : i === step ? 'active' : ''}"><span class="ai-step-dot" aria-hidden="true"></span>${escapeHtml(s)}</div>`).join('')}</div>`;
}

/* ── Submit: interpret → retrieve → (explain) ─────────────────────────── */
async function submit(raw) {
  if (busy) return;
  const s = getAIStatus();
  if (!s.navigator) { renderAvailability(); return; }
  const text = redactSensitive(raw).slice(0, AI_CLIENT_CONFIG.limits.requestChars);
  if (text.length < 3) { setStatus('Tell us a little about what you need — for example “food for my family tonight”.', 'warn'); $('navigator-input')?.focus(); return; }

  busy = true; setBusyUI(true);
  setStatus(progressHTML(0));
  let needs;
  try {
    const r = await aiRequest('interpret', { text });
    needs = r.needs;
    if (!needs || !Array.isArray(needs.categories)) throw new AIClientError('bad_output');
  } catch (e) {
    busy = false; setBusyUI(false);
    setStatus(errorHTML(e), 'error');
    return;
  }

  // Off-topic or too vague: never search, never guess — ask, and offer categories.
  if (needs.requestType !== 'service_request' || !needs.categories.length) {
    busy = false; setBusyUI(false);
    setStatus(clarifyHTML(needs), 'warn');
    wireClarify();
    return;
  }

  setStatus(progressHTML(1));
  await nextFrame(); // let the "searching" stage paint before the (synchronous) search runs
  // Location: a named town / ZIP from the request is resolved by ReliefGrid
  // (bundled Census data, else the address geocoder). "Near me" never triggers
  // a permission prompt by itself — the results panel offers the choice.
  let locationNote = null;
  if (needs.locationText) {
    const r = await resolveLocationText(needs.locationText);
    if (r.ok) setSeekerLocation(r.coords, r.label, r.precision);
    else locationNote = `${r.message} You can set a location on the results page.`;
  }
  const needsLocation = !!(needs.nearMe && !needs.locationText && !getSeekerQuery().userCoords);

  // Transportation intent → travel mode for real travel times (walk / drive only;
  // bus and train times aren't available, so no-car requests use walking times).
  const travelMode = travelModeFor(needs.transportation);
  const maxMinutes = needs.maxMinutes || (travelMode === 'walk' ? 30 : travelMode === 'drive' && needs.distancePreference === 'close' ? 15 : null);
  const plan = {
    categories: needs.categories,
    openNow: needs.urgency === 'immediate',
    walkIns: !!needs.walkInsNeeded,
    travel: travelFor(needs.transportation),
    travelMode, maxMinutes, maxMiles: needs.maxMiles || null,
  };
  session = { needs, plan, locationNote, needsLocation, relaxed: [], picks: [], summaryState: 'idle', resultKey: '', hiddenHousehold: new Set() };
  session.relaxed = applySeekerPlan(plan);   // → navigates to results → onResults()
  busy = false; setBusyUI(false);
  setStatus('');
  session.explainPending = true;
  maybeExplain(getSeekerQuery());
}
/** Suggestions wait until travel times (if any are coming) have settled, so the
 *  ranking they describe is the one the person sees. */
function maybeExplain(q) {
  if (!session?.explainPending) return;
  const routing = !!(q.travel?.mode && q.userCoords && getAIStatus().location?.travelTimes);
  if (routing && !['ready', 'error', 'none'].includes(q.travel.status)) return;
  session.explainPending = false;
  requestExplanation();
}
function setBusyUI(on) {
  const btn = $('navigator-submit'); if (!btn) return;
  btn.disabled = on || !getAIStatus().navigator;
  btn.classList.toggle('is-busy', on);
  btn.setAttribute('aria-busy', String(on));
}
function travelFor(t) {
  if (t === 'walking') return 'walking';
  if (t === 'driving') return 'driving';
  if (t === 'no_car' || t === 'public_transit') return 'unsure';
  return null;
}
function travelModeFor(t) {
  if (t === 'driving') return 'drive';
  if (t === 'walking' || t === 'no_car' || t === 'public_transit') return 'walk';
  return null; // unspecified → straight-line; the user can pick Walk / Drive
}
function nextFrame() { return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }
function errorHTML(e) {
  const msg = e instanceof AIClientError ? e.userMessage : 'Something went wrong with AI assistance. Please try again.';
  return `<div class="ai-error"><strong>${escapeHtml(msg)}</strong><span>You can still choose a category below — all listings and filters work without AI.</span></div>`;
}
function clarifyHTML(needs) {
  const q = needs.requestType === 'unrelated'
    ? 'ReliefGrid’s navigator can only help you find social services on Long Island — like shelter, food, healthcare or legal help. What kind of help are you looking for?'
    : (needs.clarifyingQuestion || 'Could you tell us a bit more about what kind of help you need?');
  const unmatched = (needs.unmatchedNeeds || []).length
    ? `<p class="small">ReliefGrid’s listings don’t include a category for: ${needs.unmatchedNeeds.map(escapeHtml).join(', ')}.</p>` : '';
  return `<div class="ai-clarify"><strong>${escapeHtml(q)}</strong>${unmatched}
    <div class="clarify-cats">${SEEKER_CATEGORIES.map(c => `<button type="button" class="chip-btn" data-clarify-cat="${c.id}">${escapeHtml(c.label)}</button>`).join('')}</div></div>`;
}
function wireClarify() {
  document.querySelectorAll('[data-clarify-cat]').forEach(b => b.addEventListener('click', () => {
    session = null; setStatus('');
    applySeekerPlan({ categories: [b.dataset.clarifyCat], openNow: false, walkIns: false, travel: null });
  }));
}

/* ── Results decoration (needs chips, notes, suggestions) ─────────────── */
const HOUSEHOLD_LABEL = { children: 'Children with you', family: 'Family', older_adult: 'Older adult', disability: 'Disability', veteran: 'Veteran', youth: 'Youth', pets: 'Pets' };
const CAT_BY_GROUP = Object.fromEntries(SEEKER_CATEGORIES.flatMap(c => c.groups.map(g => [g, c.label])));
// Every word shown about a resource comes from these templates + ReliefGrid data;
// the AI only picks which listing ids and which verified reason codes apply.
const REASON_TEXT = {
  matches_need: (f) => `Matches: ${CAT_BY_GROUP[f.properties.resource_group] || 'your needs'}`,
  // Travel times come from ReliefGrid's routing service (openrouteservice), never from the AI.
  closest: (f, d, t) => (t?.durationSec != null ? `Shortest ${t.mode === 'drive' ? 'drive' : 'walk'} from your location · ${formatDuration(t.durationSec)}` : d != null ? `Closest match · ${d.toFixed(1)} mi straight-line` : 'Closest match'),
  listed_available: () => 'Listed as available (demo data)',
  listed_open: () => 'Listed as open now (demo data)',
  walk_ins: () => 'Listing shows walk-ins accepted (demo data)',
  mentions_families: () => 'Listing mentions families or youth',
};

function onResults(results, query) {
  lastResults = results;
  const box = $('seeker-ai-context'); if (!box) return;
  if (query.source !== 'ai' || !session) {
    box.hidden = true; box.innerHTML = '';
    setFacilityEmphasis([]);
    return;
  }
  const key = results.map(r => r.f.properties.facility_id).slice(0, AI_CLIENT_CONFIG.limits.explainResources).join('|');
  if (session.summaryState === 'done' && key !== session.resultKey) session.summaryState = 'stale';
  box.hidden = false;
  box.innerHTML = needsHTML(query) + notesHTML(query, results) + summaryHTML(results, query);
  wireContext(box, results);
  const visible = new Set(results.map(r => r.f.properties.facility_id));
  const picks = session.summaryState === 'done' ? session.picks.map(p => p.facilityId).filter(id => visible.has(id)) : [];
  setFacilityEmphasis(picks);
  document.querySelectorAll('#seeker-results-list .seeker-card').forEach(c => c.classList.toggle('is-ai-pick', picks.includes(c.dataset.id)));
  maybeExplain(query);
}

function needsHTML(q) {
  const n = session.needs;
  const chips = [];
  (q.categories || []).forEach(c => chips.push(chip(CAT_LABEL[c] || c, { remove: `cat:${c}`, kind: 'need' })));
  if (n.urgency === 'immediate') {
    chips.push(q.quickFilters.includes('open_now')
      ? chip('Needed now · open now', { remove: 'filter:open_now', kind: 'filter', title: 'Showing listings reporting open now (demo availability data)' })
      : chip('Needed now', { kind: 'info', title: 'No listing could be confirmed open now, so all matching listings are shown' }));
  } else if (URGENCY_LABEL[n.urgency]) chips.push(chip(URGENCY_LABEL[n.urgency], { kind: 'info' }));
  if (q.travel?.mode) {
    // Real travel times (walk / drive) are in use — the travel bar shows the details.
    const limit = q.travel.maxMinutes ? ` · within ${q.travel.maxMinutes} min` : q.travel.maxMiles ? ` · within ${q.travel.maxMiles} mi` : '';
    chips.push(chip(`${TRAVEL_LABEL[n.transportation] || (q.travel.mode === 'walk' ? 'Walking' : 'Driving')}${q.userCoords ? limit : ''}`, { remove: 'travelmode', kind: q.userCoords ? 'filter' : 'info',
      title: q.userCoords ? `Ranked by ${q.travel.mode === 'walk' ? 'walking' : 'driving'} time from your location` : 'Add a location to rank by travel time' }));
  } else if (TRAVEL_LABEL[n.transportation]) {
    const radius = q.radiusKm; const within = q.quickFilters.includes('near_me') ? ` · within ~${kmToMiles(radius).toFixed(radius < 5 ? 1 : 0)} mi` : '';
    chips.push(chip(`${TRAVEL_LABEL[n.transportation]}${within}`, { remove: q.quickFilters.includes('near_me') ? 'travel' : null, kind: within ? 'filter' : 'info',
      title: within ? 'Straight-line distance from your town — not travel time' : 'Add a location to limit results by distance' }));
  }
  if (q.quickFilters.includes('walk_ins')) chips.push(chip('Walk-ins accepted', { remove: 'filter:walk_ins', kind: 'filter' }));
  if (q.userCoords) chips.push(chip(`Near ${q.locationLabel}`, { remove: 'location', kind: 'filter' }));
  (n.householdContext || []).filter(h => !session.hiddenHousehold.has(h) && HOUSEHOLD_LABEL[h]).forEach(h =>
    chips.push(chip(HOUSEHOLD_LABEL[h], { remove: `household:${h}`, kind: 'info', title: 'Not used to filter — ReliefGrid has no verified eligibility data. Ask the provider.' })));

  const used = new Set(q.categories || []);
  const addable = SEEKER_CATEGORIES.filter(c => !used.has(c.id));
  const addSelect = addable.length ? `<label class="add-need"><span class="sr-only">Add a need</span><select id="ai-add-need"><option value="">+ Add a need</option>${addable.map(c => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('')}</select></label>` : '';

  return `<div class="ai-needs" aria-label="Needs identified">
    <div class="ai-needs-head"><span class="ai-label"><span class="ai-spark" aria-hidden="true"></span>Needs identified</span><button type="button" class="link-btn" id="ai-edit-request">Edit request</button></div>
    <div class="chip-row">${chips.join('')}${addSelect}</div>
    <div class="ai-foot">AI helps interpret your request. Resource information comes from ReliefGrid data.</div>
  </div>`;
}
function chip(label, { remove = null, kind = 'need', title = '' } = {}) {
  return `<span class="need-chip need-chip-${kind}" ${title ? `title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}${remove ? `<button type="button" class="chip-x" data-remove="${escapeHtml(remove)}" aria-label="Remove ${escapeHtml(label)}">×</button>` : ''}</span>`;
}
function notesHTML(q, results) {
  const notes = [];
  if (session.needs.safetyConcern) notes.push(`<div class="ai-note ai-note-safety" role="alert"><strong>If you are in danger right now, call 911.</strong> For a mental-health crisis you can call or text 988. ReliefGrid cannot contact emergency services.</div>`);
  const relaxedNames = { open_now: '“open now”', near_me: 'distance', walk_ins: '“walk-ins”' };
  if (session.relaxed.length) notes.push(`<div class="ai-note">No listings matched every detail, so ReliefGrid loosened ${session.relaxed.map(r => relaxedNames[r] || r).join(' and ')} to show the closest matches.</div>`);
  if (session.locationNote) notes.push(`<div class="ai-note">${escapeHtml(session.locationNote)}</div>`);
  // "Near me" / travel intent without a location: offer the choice — never auto-request it.
  if (!q.userCoords && (session.needsLocation || q.travel?.mode)) {
    notes.push(`<div class="ai-note ai-note-location"><strong>Want results sorted by what’s closest to you?</strong> Share your location or type a town, ZIP code or address. It’s only used on this page and isn’t saved or sent to the AI.
      <div class="loc-actions"><button type="button" class="chip-btn" data-loc-use>Use my location</button>
      <form class="loc-form" data-loc-form><label class="sr-only" for="ai-loc-input">Town, ZIP code or address</label><input id="ai-loc-input" type="text" autocomplete="off" placeholder="Town, ZIP or address"><button type="submit" class="chip-btn">Set</button></form></div>
      <div class="loc-msg small" aria-live="polite">${escapeHtml(session.locMsg || '')}</div></div>`);
  }
  if (['no_car', 'public_transit'].includes(session.needs.transportation) && q.travel?.mode === 'walk' && q.userCoords) {
    notes.push('<div class="ai-note">ReliefGrid can’t calculate bus or train times yet, so walking times are shown. Transit may reach more places — check with the provider or 511NY.</div>');
  }
  const unmatched = session.needs.unmatchedNeeds || [];
  if (unmatched.length) notes.push(`<div class="ai-note">ReliefGrid’s listings don’t have a category for ${unmatched.map(u => `“${escapeHtml(u)}”`).join(', ')}. The listings below cover the needs it could match.</div>`);
  if (session.plan.walkIns && !(q.categories || []).some(c => WALKIN_RELEVANT_CATEGORIES.has(c))) notes.push(`<div class="ai-note">Walk-in information is only tracked for healthcare, mental-health and legal listings.</div>`);
  if (!results.length) {
    const opts = [
      q.quickFilters.length ? '<button type="button" class="chip-btn" data-broaden="filters">Remove filters</button>' : '',
      q.userCoords ? '<button type="button" class="chip-btn" data-broaden="location">Search all of Long Island</button>' : '',
      '<button type="button" class="chip-btn" data-broaden="all">Start a new search</button>',
    ].join('');
    notes.push(`<div class="ai-note ai-note-warn"><strong>No verified ReliefGrid listings match these needs right now.</strong> ReliefGrid only shows listings it actually has. Try broadening your search:<div class="clarify-cats">${opts}</div></div>`);
  }
  return notes.join('');
}
function summaryHTML(results, q) {
  if (!results.length) return '';
  const foot = `<div class="ai-foot">AI helps order these suggestions; every detail comes from ReliefGrid data. Availability is demo data — always call ahead to confirm.</div>`;
  const available = results.filter(r => r.rec && r.rec.status === 'available').length;
  const lead = `${results.length} ReliefGrid ${results.length === 1 ? 'listing matches' : 'listings match'}${q.userCoords ? ` near ${escapeHtml(q.locationLabel)}` : ''}${available ? ` · ${available} listed as available (demo data)` : ''}.`;
  switch (session.summaryState) {
    case 'loading':
      return `<div class="ai-summary is-loading" aria-busy="true"><div class="ai-label"><span class="ai-spark" aria-hidden="true"></span>Choosing good first calls…</div><p>${lead}</p><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`;
    case 'done': {
      const picks = session.picks.map(p => {
        const f = findFacilityFeature(p.facilityId); if (!f) return '';
        const d = q.userCoords ? kmToMiles(haversineKm(q.userCoords[0], q.userCoords[1], f.geometry.coordinates[0], f.geometry.coordinates[1])) : null;
        const tr = lastResults?.find(x => x.f.properties.facility_id === p.facilityId)?.t;
        const reasons = p.reasons.map(code => REASON_TEXT[code]?.(f, d, tr ? { ...tr, mode: q.travel?.mode } : null)).filter(Boolean).join(' · ');
        return `<li><button type="button" class="pick-btn" data-pick="${escapeHtml(p.facilityId)}"><span class="pick-name">${escapeHtml(f.properties.name)}</span><span class="pick-reason">${escapeHtml(reasons)}</span></button></li>`;
      }).join('');
      return `<div class="ai-summary"><div class="ai-label"><span class="ai-spark" aria-hidden="true"></span>Suggested first calls</div>
        <p>${lead}</p>${picks ? `<ul class="pick-list">${picks}</ul>` : ''}${foot}</div>`;
    }
    case 'stale':
      return `<div class="ai-summary is-stale"><div class="ai-label"><span class="ai-spark" aria-hidden="true"></span>Results changed</div><button type="button" class="btn btn-ghost btn-sm" id="ai-resummarize">Suggest first calls again</button></div>`;
    case 'error':
      return `<div class="ai-summary is-error"><span>${escapeHtml(session.summaryError || 'Suggestions aren’t available right now.')} The listings below are unaffected.</span> <button type="button" class="link-btn" id="ai-resummarize">Try again</button></div>`;
    default:
      return '';
  }
}
function wireContext(box, results) {
  box.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
    const r = b.dataset.remove; const q = getSeekerQuery();
    if (r.startsWith('cat:')) updateSeekerQuery({ categories: (q.categories || []).filter(c => c !== r.slice(4)) });
    else if (r.startsWith('filter:')) updateSeekerQuery({ removeFilter: r.slice(7) });
    else if (r === 'travel') { session.needs.transportation = 'unspecified'; updateSeekerQuery({ travel: null }); }
    else if (r === 'location') updateSeekerQuery({ clearLocation: true });
    else if (r.startsWith('household:')) { session.hiddenHousehold.add(r.slice(10)); onResults(results, q); }
    else if (r === 'travelmode') updateSeekerQuery({ travelMode: null });
  }));
  box.querySelector('[data-loc-use]')?.addEventListener('click', async () => {
    const r = await useMyLocation(); session.locMsg = r.ok ? '' : r.message; if (!r.ok) rerender();
  });
  box.querySelector('[data-loc-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault(); const v = e.currentTarget.querySelector('input').value;
    session.locMsg = 'Looking up that location…'; box.querySelector('.loc-msg').textContent = session.locMsg;
    const r = await submitLocationText(v); session.locMsg = r.ok ? '' : r.message; if (!r.ok) rerender();
  });
  box.querySelectorAll('[data-broaden]').forEach(b => b.addEventListener('click', () => {
    const q = getSeekerQuery();
    if (b.dataset.broaden === 'filters') q.quickFilters.forEach(f => updateSeekerQuery({ removeFilter: f }));
    else if (b.dataset.broaden === 'location') updateSeekerQuery({ clearLocation: true });
    else { window.__reliefgrid_navigate('seeker-home'); setTimeout(() => $('navigator-input')?.focus(), 60); }
  }));
  box.querySelector('#ai-add-need')?.addEventListener('change', (e) => {
    const v = e.target.value; if (!v) return;
    updateSeekerQuery({ categories: [...(getSeekerQuery().categories || []), v] });
  });
  box.querySelector('#ai-edit-request')?.addEventListener('click', () => { window.__reliefgrid_navigate('seeker-home'); setTimeout(() => $('navigator-input')?.focus(), 60); });
  box.querySelector('#ai-resummarize')?.addEventListener('click', requestExplanation);
  box.querySelectorAll('[data-pick]').forEach(b => {
    b.addEventListener('click', () => focusFacilityOnMap(b.dataset.pick));
    b.addEventListener('dblclick', () => openSeekerDetail(b.dataset.pick));
  });
}

/* ── Suggested first calls (optional second AI step: ids + verified codes) ── */
async function requestExplanation() {
  if (!session) return;
  const q = getSeekerQuery();
  const results = currentResultsSnapshot(q);
  if (!results.length) return;
  const mine = session;
  mine.summaryState = 'loading';
  mine.resultKey = results.map(r => r.id).join('|');
  rerender();
  try {
    const r = await aiRequest('explain', {
      needs: { categories: q.categories || [], urgency: mine.needs.urgency, transportation: mine.needs.transportation, walkInsNeeded: !!mine.needs.walkInsNeeded },
      resources: results,
    });
    if (session !== mine) return;
    // Belt and braces: only ids ReliefGrid itself returned, only known reason codes.
    const allowed = new Set(results.map(x => x.id));
    mine.picks = (Array.isArray(r.picks) ? r.picks : [])
      .filter(p => p && allowed.has(p.facilityId))
      .map(p => ({ facilityId: p.facilityId, reasons: (Array.isArray(p.reasons) ? p.reasons : []).filter(c => REASON_TEXT[c]) }));
    mine.summaryState = 'done';
  } catch (e) {
    if (session !== mine) return;
    mine.summaryState = 'error';
    mine.summaryError = e instanceof AIClientError ? e.userMessage : null;
  }
  rerender();
}
/** The top results exactly as ReliefGrid computed them (ids + facts it already displays). */
function currentResultsSnapshot(q) {
  return (lastResults || []).slice(0, AI_CLIENT_CONFIG.limits.explainResources).map(({ f, t }) => {
    if (!f) return null;
    const rec = Availability.get(f.properties.facility_id);
    const d = q.userCoords ? kmToMiles(haversineKm(q.userCoords[0], q.userCoords[1], f.geometry.coordinates[0], f.geometry.coordinates[1])) : null;
    return {
      id: f.properties.facility_id,
      status: rec ? rec.status : 'unknown',
      openNow: rec ? rec.raw.open_now === true : false,
      walkIns: rec ? rec.raw.walk_ins === true : false,
      distanceMiles: d != null ? Math.round(d * 10) / 10 : null,
      // Route travel time from ReliefGrid's routing service (the AI only compares it).
      travelMinutes: t?.durationSec != null ? Math.round(t.durationSec / 60) : null,
      travelMode: t?.durationSec != null ? q.travel?.mode || null : null,
    };
  }).filter(Boolean);
}
function rerender() { if (lastResults) onResults(lastResults, getSeekerQuery()); }

/* ── Optional: external location context on the detail page ───────────── */
function renderLocationContextEntry(facilityId) {
  const el = $('sd-location-context'); if (!el) return;
  if (!getAIStatus().locationContext || !facilityId) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="ext-context"><button type="button" class="btn btn-ghost btn-sm" id="sd-ext-btn"><span class="ai-spark" aria-hidden="true"></span>Travel &amp; area context (Google Maps)</button>
    <div class="muted small">External information — not part of ReliefGrid’s verified listings.</div><div id="sd-ext-body" aria-live="polite"></div></div>`;
  $('sd-ext-btn').addEventListener('click', async () => {
    const body = $('sd-ext-body'); const btn = $('sd-ext-btn');
    btn.disabled = true; body.innerHTML = `<div class="skeleton-line"></div><div class="skeleton-line short"></div>`;
    try {
      const r = await aiRequest('locationContext', { facilityId });
      const sources = (r.sources || []).filter(s => /^https:\/\//.test(s.uri || '')).slice(0, 5);
      body.innerHTML = `<div class="ext-card"><div class="ext-tag">External · Google Maps</div><p>${escapeHtml(r.text || 'No additional context was found.')}</p>
        ${sources.length ? `<div class="ext-sources">Sources: ${sources.map(s => `<a href="${escapeHtml(s.uri)}" target="_blank" rel="noopener">${escapeHtml(s.title || 'Google Maps')}</a>`).join(' · ')}</div>` : ''}
        <div class="ai-foot">AI-generated from Google Maps data. Confirm details with the provider.</div></div>`;
    } catch (e) {
      body.innerHTML = `<div class="ai-error small">${escapeHtml(e instanceof AIClientError ? e.userMessage : 'Context unavailable.')}</div>`;
      btn.disabled = false;
    }
  });
}

// Used by tests / console debugging only; never logs user text.
export function _navigatorSession() { return session ? { plan: session.plan, summaryState: session.summaryState } : null; }
