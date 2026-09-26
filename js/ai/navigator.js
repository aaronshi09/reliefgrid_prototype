/* ============================================================================
 * ReliefGrid AI — Resource Navigator (consumer "Find Help" experience).
 * ----------------------------------------------------------------------------
 *   natural-language request
 *     → POST /api/ai/interpret   (AI → structured needs, mapped onto the
 *                                 EXISTING seeker categories / filters)
 *     → applySeekerPlan()        (ReliefGrid's own computeResults() over the
 *                                 verified facility dataset — same rules as
 *                                 the guided flow, same relaxation safety net)
 *     → POST /api/ai/explain     (optional: AI explains ONLY the resources
 *                                 ReliefGrid returned, by id)
 * The language model never produces a resource. If it names something that
 * isn't in the result set, the server drops it before it reaches the page.
 * ==========================================================================*/
import {
  Availability, SEEKER_CATEGORIES, lookupTown, findFacilityFeature, escapeHtml, kmToMiles, haversineKm,
  availabilityHeadline, setFacilityEmphasis,
} from '../shared.js';
import {
  applySeekerPlan, updateSeekerQuery, onSeekerResultsRendered, setSeekerLocation, getSeekerQuery,
  focusFacilityOnMap, openSeekerDetail, WALKIN_RELEVANT_CATEGORIES,
} from '../seeker.js';
import { aiRequest, getAIStatus, loadAIStatus, redactSensitive, setupNoticeHTML, AIClientError } from './client.js';
import { AI_CLIENT_CONFIG } from './config.js';

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
  loadAIStatus().then(renderAvailability);
  updateCounter();
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
  const steps = ['Understanding your request', 'Searching ReliefGrid listings', 'Preparing results'];
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

  setStatus(progressHTML(1));
  // Location: only the prototype town lookup — no geocoding service is used.
  let locationNote = null;
  if (needs.locationText) {
    const coords = lookupTown(needs.locationText);
    if (coords) setSeekerLocation(coords, titleCase(needs.locationText));
    else locationNote = `ReliefGrid’s prototype doesn’t recognize “${needs.locationText}” as a Long Island town yet, so results aren’t sorted by distance. You can set a town below.`;
  }

  if (!needs.categories.length) {
    busy = false; setBusyUI(false);
    setStatus(clarifyHTML(needs), 'warn');
    wireClarify();
    return;
  }

  const travel = travelFor(needs.transportation);
  const plan = {
    categories: needs.categories,
    openNow: needs.urgency === 'immediate',
    walkIns: !!needs.walkInsNeeded,
    travel,
  };
  session = { needs, plan, locationNote, relaxed: [], summary: null, picks: [], summaryState: 'idle', resultKey: '', hideHousehold: false };
  session.relaxed = applySeekerPlan(plan);   // → navigates to results → onResults()
  busy = false; setBusyUI(false);
  setStatus('');
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
function titleCase(s) { return String(s).replace(/\b\w/g, c => c.toUpperCase()); }
function errorHTML(e) {
  const msg = e instanceof AIClientError ? e.userMessage : 'Something went wrong with AI assistance. Please try again.';
  return `<div class="ai-error"><strong>${escapeHtml(msg)}</strong><span>You can still choose a category below — all listings and filters work without AI.</span></div>`;
}
function clarifyHTML(needs) {
  const q = needs.clarifyingQuestion || 'Could you tell us a bit more about what kind of help you need?';
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

/* ── Results decoration (needs chips, notes, AI summary) ──────────────── */
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
  box.innerHTML = needsHTML(query) + notesHTML(query, results) + summaryHTML(results);
  wireContext(box, results);
  const visible = new Set(results.map(r => r.f.properties.facility_id));
  const picks = session.summaryState === 'done' ? session.picks.map(p => p.facilityId).filter(id => visible.has(id)) : [];
  setFacilityEmphasis(picks);
  document.querySelectorAll('#seeker-results-list .seeker-card').forEach(c => c.classList.toggle('is-ai-pick', picks.includes(c.dataset.id)));
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
  if (TRAVEL_LABEL[n.transportation]) {
    const radius = q.radiusKm; const within = q.quickFilters.includes('near_me') ? ` · within ~${kmToMiles(radius).toFixed(radius < 5 ? 1 : 0)} mi` : '';
    chips.push(chip(`${TRAVEL_LABEL[n.transportation]}${within}`, { remove: q.quickFilters.includes('near_me') ? 'travel' : null, kind: within ? 'filter' : 'info',
      title: within ? 'Straight-line distance from your town — not travel time' : 'Add a location to limit results by distance' }));
  }
  if (q.quickFilters.includes('walk_ins')) chips.push(chip('Walk-ins accepted', { remove: 'filter:walk_ins', kind: 'filter' }));
  if (q.userCoords) chips.push(chip(`Near ${q.locationLabel}`, { remove: 'location', kind: 'filter' }));
  if (n.household?.children && !session.hideHousehold) chips.push(chip('Children with you', { remove: 'household', kind: 'info', title: 'ReliefGrid does not have verified family-eligibility data — ask the provider' }));

  const used = new Set(q.categories || []);
  const addable = SEEKER_CATEGORIES.filter(c => !used.has(c.id));
  const addSelect = addable.length ? `<label class="add-need"><span class="sr-only">Add a need</span><select id="ai-add-need"><option value="">+ Add a need</option>${addable.map(c => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('')}</select></label>` : '';

  return `<div class="ai-needs" aria-label="Needs identified">
    <div class="ai-needs-head"><span class="ai-label"><span class="ai-spark" aria-hidden="true"></span>Needs identified</span><button type="button" class="link-btn" id="ai-edit-request">Edit request</button></div>
    <div class="chip-row">${chips.join('')}${addSelect}</div>
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
  const unmatched = session.needs.unmatchedNeeds || [];
  if (unmatched.length) notes.push(`<div class="ai-note">ReliefGrid’s listings don’t have a category for ${unmatched.map(u => `“${escapeHtml(u)}”`).join(', ')}. The listings below cover the needs it could match.</div>`);
  if (session.plan.walkIns && !(q.categories || []).some(c => WALKIN_RELEVANT_CATEGORIES.has(c))) notes.push(`<div class="ai-note">Walk-in information is only tracked for healthcare, mental-health and legal listings.</div>`);
  if (!results.length) notes.push(`<div class="ai-note">No listings match right now. Try removing a need above or browse all categories.</div>`);
  return notes.join('');
}
function summaryHTML(results) {
  const foot = `<div class="ai-foot">AI-assisted summary of ReliefGrid listings. Availability is demo data — always confirm with the provider.</div>`;
  if (!results.length) return '';
  switch (session.summaryState) {
    case 'loading':
      return `<div class="ai-summary is-loading" aria-busy="true"><div class="ai-label"><span class="ai-spark" aria-hidden="true"></span>Summarizing your matches…</div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`;
    case 'done': {
      const picks = session.picks.map(p => {
        const f = findFacilityFeature(p.facilityId); if (!f) return '';
        return `<li><button type="button" class="pick-btn" data-pick="${escapeHtml(p.facilityId)}"><span class="pick-name">${escapeHtml(f.properties.name)}</span><span class="pick-reason">${escapeHtml(p.reason)}</span></button></li>`;
      }).join('');
      return `<div class="ai-summary"><div class="ai-label"><span class="ai-spark" aria-hidden="true"></span>ReliefGrid AI summary</div>
        <p>${escapeHtml(session.summary)}</p>${picks ? `<ul class="pick-list">${picks}</ul>` : ''}${session.caution ? `<p class="ai-caution">${escapeHtml(session.caution)}</p>` : ''}${foot}</div>`;
    }
    case 'stale':
      return `<div class="ai-summary is-stale"><div class="ai-label"><span class="ai-spark" aria-hidden="true"></span>Results changed</div><button type="button" class="btn btn-ghost btn-sm" id="ai-resummarize">Summarize these results</button></div>`;
    case 'error':
      return `<div class="ai-summary is-error"><span>${escapeHtml(session.summaryError || 'The summary isn’t available right now.')} The listings below are unaffected.</span> <button type="button" class="link-btn" id="ai-resummarize">Try again</button></div>`;
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
    else if (r === 'household') { session.hideHousehold = true; onResults(results, q); }
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

/* ── Explanation (optional second AI step, grounded in returned ids) ─── */
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
      needs: {
        categories: q.categories || [], urgency: mine.needs.urgency, transportation: mine.needs.transportation,
        walkInsNeeded: !!mine.needs.walkInsNeeded, children: !!mine.needs.household?.children,
      },
      resources: results,
      relaxedFilters: mine.relaxed,
      locationLabel: q.userCoords ? q.locationLabel : null,
    });
    if (session !== mine) return;
    mine.summary = String(r.summary || '');
    mine.picks = Array.isArray(r.picks) ? r.picks : [];
    mine.caution = r.caution || null;
    mine.summaryState = mine.summary ? 'done' : 'error';
  } catch (e) {
    if (session !== mine) return;
    mine.summaryState = 'error';
    mine.summaryError = e instanceof AIClientError ? e.userMessage : null;
  }
  rerender();
}
/** The top results exactly as ReliefGrid computed them (ids + display facts). */
function currentResultsSnapshot(q) {
  return (lastResults || []).slice(0, AI_CLIENT_CONFIG.limits.explainResources).map(({ f }) => {
    if (!f) return null;
    const rec = Availability.get(f.properties.facility_id);
    const d = q.userCoords ? kmToMiles(haversineKm(q.userCoords[0], q.userCoords[1], f.geometry.coordinates[0], f.geometry.coordinates[1])) : null;
    return {
      id: f.properties.facility_id,
      status: rec ? rec.status : 'unknown',
      availability: rec ? availabilityHeadline(rec, f.properties.resource_group).slice(0, 120) : null,
      distanceMiles: d != null ? Math.round(d * 10) / 10 : null,
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
