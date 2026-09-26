/* ============================================================================
 * ReliefGrid AI — "Ask ReliefGrid" analyst (government / nonprofit).
 * ----------------------------------------------------------------------------
 *   question
 *     → POST /api/ai/analyze   The server runs a tool-calling loop in which the
 *                              model can ONLY read ReliefGrid's precomputed
 *                              tract / LISA / diagnostics / facility data
 *                              (server/data/analyst-tools.js). Tract and
 *                              facility ids in the reply are filtered to ones
 *                              the tools actually returned, and figures in the
 *                              prose are checked against tool output.
 *     → the answer is rendered with an evidence table whose numbers come from
 *       the browser's own copy of the data (not from the model), and the map
 *       highlights the referenced tracts on the existing research layers.
 * ==========================================================================*/
import {
  AppState, escapeHtml, number, findTractFeature, findFacilityFeature, setTractHighlight, setSelectedTract,
  setFacilityEmphasis, fitToTracts, LISA_LABELS, fitPadding, motion, setFacilitiesLayout, flyToPoint,
} from '../shared.js';
import { renderTractDetail, setAskLayer, setTravelMode, setFacilityFilter } from '../gov.js';
import { aiRequest, getAIStatus, loadAIStatus, renderProse, setupNoticeHTML, AIClientError } from './client.js';
import { AI_CLIENT_CONFIG } from './config.js';

const $ = (id) => document.getElementById(id);
const SUGGESTIONS = [
  'Which areas have the largest emergency housing accessibility gaps?',
  'Where are food assistance resources least accessible?',
  'Which areas should we investigate for additional services?',
  'Explain the accessibility patterns shown on this map.',
];
const LAYER_NAME = { lisa: 'Service Gap Clusters', mismatch_index: 'Service Gap', need_score: 'Community Need', access_index: 'Service Access' };

let thread = [];          // [{ q, a }] in memory only
let busy = false;
let selectedGeoid = null;

export function initAnalyst() {
  renderSuggestions();
  $('analyst-form')?.addEventListener('submit', (e) => { e.preventDefault(); ask($('analyst-input').value); });
  $('analyst-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(e.target.value); } });
  document.addEventListener('rg:ai-status', renderAvailability);
  document.addEventListener('rg:gov-ask-shown', () => {
    renderContext();
    if (selectedGeoid) setSelectedTract(selectedGeoid);
    // Re-apply the latest answer's highlights (without moving the camera).
    const last = [...thread].reverse().find(t => t.state === 'done' && t.a);
    if (last) { setTractHighlight((last.a.mapFocus?.tractIds || []).filter(g => findTractFeature(g))); setFacilityEmphasis((last.a.mapFocus?.facilityIds || []).filter(id => findFacilityFeature(id))); }
  });
  document.addEventListener('rg:travel-mode', () => { renderContext(); if (selectedGeoid) showTract(selectedGeoid, false); });
  document.addEventListener('rg:tract-click', (e) => showTract(e.detail.geoid, false));
  document.addEventListener('rg:ask-about-tract', (e) => {
    showTract(e.detail.geoid, true);
    if (getAIStatus().analyst) ask(`Explain the service-gap pattern in census tract ${e.detail.geoid} and how it compares with the rest of the region.`);
  });
  $('analyst-clear')?.addEventListener('click', clearThread);
  loadAIStatus().then(renderAvailability);
}

function renderAvailability() {
  const s = getAIStatus(); const on = s.checked && s.analyst;
  const form = $('analyst-form'); if (!form) return;
  form.classList.toggle('is-disabled', !on);
  $('analyst-input').disabled = !on; $('analyst-submit').disabled = !on;
  document.querySelectorAll('#analyst-suggestions button').forEach(b => { b.disabled = !on; });
  const setup = $('analyst-setup');
  if (setup) setup.innerHTML = s.checked && !on ? setupNoticeHTML('analyst') : '';
}
function renderSuggestions() {
  const el = $('analyst-suggestions'); if (!el) return;
  el.innerHTML = SUGGESTIONS.map(t => `<button type="button" class="example-chip">${escapeHtml(t)}</button>`).join('');
  el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => ask(b.textContent)));
}
function currentLayer() { return document.querySelector('input[name="gov-ask-layer"]:checked')?.value || 'lisa'; }
function renderContext() {
  const el = $('analyst-context'); if (!el) return;
  const t = selectedGeoid ? findTractFeature(selectedGeoid) : null;
  el.innerHTML = `<span class="ctx-label">Context</span>
    <span class="ctx-chip">${AppState.mode === 'walk' ? 'Walking' : 'Driving'} catchments</span>
    <span class="ctx-chip">${escapeHtml(LAYER_NAME[currentLayer()])}</span>
    ${t ? `<span class="ctx-chip ctx-chip-accent">Tract ${escapeHtml(selectedGeoid)} · ${escapeHtml(t.properties.county_name || '')}<button type="button" class="chip-x" id="analyst-clear-tract" aria-label="Clear selected tract">×</button></span>` : ''}`;
  $('analyst-clear-tract')?.addEventListener('click', () => { selectedGeoid = null; setSelectedTract(null); $('analyst-tract-detail').hidden = true; renderContext(); });
}

/* ── Tract selection ─────────────────────────────────────────────────── */
function showTract(geoid, fly) {
  const feat = findTractFeature(geoid); const box = $('analyst-tract-detail');
  if (!feat || !box) return;
  selectedGeoid = geoid;
  setSelectedTract(geoid);
  box.hidden = false;
  box.innerHTML = `<div class="section-label">Selected area</div><div id="analyst-tract-body"></div>`;
  renderTractDetail(feat, $('analyst-tract-body'), { idPrefix: 'ask' });
  renderContext();
  if (fly) fitToTracts([geoid], { maxZoom: 12 });
}

/* ── Ask ─────────────────────────────────────────────────────────────── */
async function ask(raw) {
  const question = String(raw || '').trim().slice(0, AI_CLIENT_CONFIG.limits.questionChars);
  if (busy || !question) return;
  if (!getAIStatus().analyst) { renderAvailability(); return; }
  busy = true; setBusy(true);
  $('analyst-input').value = '';
  const item = { q: question, a: null, state: 'loading' };
  thread.push(item);
  renderThread();

  try {
    const r = await aiRequest('analyze', {
      question,
      context: { mode: AppState.mode, layer: currentLayer(), selectedTract: selectedGeoid },
      history: thread.filter(t => t.a && t.state === 'done').slice(-AI_CLIENT_CONFIG.limits.historyTurns)
        .map(t => ({ q: t.q, a: String(t.a.answer || '').slice(0, 700) })),
    });
    item.a = r; item.state = 'done';
    syncMap(r);
  } catch (e) {
    item.state = 'error';
    item.error = e instanceof AIClientError ? e.userMessage : 'Something went wrong. Please try again.';
  }
  busy = false; setBusy(false);
  renderThread();
}
function setBusy(on) {
  const b = $('analyst-submit'); if (!b) return;
  b.disabled = on || !getAIStatus().analyst; b.classList.toggle('is-busy', on); b.setAttribute('aria-busy', String(on));
}
function clearThread() {
  thread = []; renderThread(); setTractHighlight([]); setFacilityEmphasis([]);
  const toggle = $('gov-ask-facilities-toggle');
  setFacilityFilter(null); setFacilitiesLayout(toggle?.checked ? 'visible' : 'none');
}

/* ── Map synchronisation (existing layers only) ─────────────────────── */
function syncMap(r) {
  const focus = r.mapFocus || {};
  if (focus.mode && focus.mode !== AppState.mode) setTravelMode(focus.mode);
  if (focus.layer && focus.layer !== currentLayer()) setAskLayer(focus.layer);
  const tracts = (focus.tractIds || []).filter(g => findTractFeature(g));
  const facs = (focus.facilityIds || []).filter(id => findFacilityFeature(id));
  setTractHighlight(tracts);
  setFacilityEmphasis(facs);
  // Unless the analyst has switched all resources on, show only the ones this answer references.
  const toggle = $('gov-ask-facilities-toggle');
  if (toggle && !toggle.checked) {
    setFacilityFilter(facs.length ? ['in', ['get', 'facility_id'], ['literal', facs]] : null);
    setFacilitiesLayout(facs.length ? 'visible' : 'none');
  }
  if (tracts.length) fitToTracts(tracts);
  else if (facs.length) {
    const pts = facs.map(id => findFacilityFeature(id).geometry.coordinates);
    const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1]);
    try { AppState.map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: fitPadding(), maxZoom: 12.5, duration: motion(700) }); } catch (_) {}
  }
  renderContext();
}

/* ── Rendering ───────────────────────────────────────────────────────── */
function renderThread() {
  const el = $('analyst-thread'); if (!el) return;
  $('analyst-clear').hidden = !thread.length;
  el.innerHTML = thread.map((t, i) => `<article class="qa" data-i="${i}">
      <div class="qa-q"><span class="qa-q-label">You asked</span>${escapeHtml(t.q)}</div>
      ${t.state === 'loading' ? loadingHTML() : t.state === 'error' ? `<div class="ai-error"><strong>${escapeHtml(t.error)}</strong><span>Maps, layers and tract details still work.</span></div>` : answerHTML(t.a, i)}
    </article>`).join('');
  wireThread(el);
  const last = el.lastElementChild; if (last) last.scrollIntoView({ block: 'nearest', behavior: motion(1) ? 'smooth' : 'auto' });
}
function loadingHTML() {
  return `<div class="qa-a is-loading" aria-busy="true"><div class="ai-label"><span class="ai-spark" aria-hidden="true"></span>Analyzing ReliefGrid data…</div>
    <div class="ai-progress small"><div class="ai-step active"><span class="ai-step-dot"></span>Selecting the relevant analysis</div><div class="ai-step"><span class="ai-step-dot"></span>Reading precomputed tract results</div><div class="ai-step"><span class="ai-step-dot"></span>Explaining findings</div></div>
    <div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>`;
}
function answerHTML(a, i) {
  if (!a) return '';
  const findings = (a.keyFindings || []).map(f => `<li>${escapeHtml(f.text)}${(f.tractIds || []).length ? `<span class="finding-refs">${f.tractIds.slice(0, 6).map(g => `<button type="button" class="tract-ref" data-tract="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('')}</span>` : ''}</li>`).join('');
  const tracts = (a.mapFocus?.tractIds || []).map(g => findTractFeature(g)).filter(Boolean);
  const evidence = tracts.length ? `<div class="evidence">
      <div class="evidence-head"><span class="section-label">Referenced areas</span><span class="muted small">Values from ReliefGrid data · ${AppState.mode === 'walk' ? 'walk' : 'drive'}</span></div>
      <div class="table-scroll"><table class="evidence-table"><thead><tr><th>Tract</th><th>County</th><th title="Community Need">Need</th><th title="Service Access (0–100)">Access</th><th title="Service Gap">Gap</th><th>Cluster</th></tr></thead><tbody>
      ${tracts.slice(0, 12).map(f => { const p = f.properties; const lisa = p.lisa_mismatch_index_label || 'ns';
        return `<tr data-tract="${escapeHtml(p.GEOID)}" tabindex="0"><td>${escapeHtml(p.GEOID)}</td><td>${escapeHtml(p.county_name || '—')}</td><td>${number(p.need_score)}</td><td>${number(p.access_index, 0)}</td><td>${number(p.mismatch_index)}</td><td><span class="lisa-tag lisa-${lisa}" title="${escapeHtml(LISA_LABELS[lisa] || '')}">${escapeHtml(lisa === 'ns' ? '—' : lisa)}</span></td></tr>`; }).join('')}
      </tbody></table></div>${tracts.length > 12 ? `<div class="muted small">+${tracts.length - 12} more highlighted on the map</div>` : ''}</div>` : '';
  const facs = (a.mapFocus?.facilityIds || []).map(id => findFacilityFeature(id)).filter(Boolean);
  const facList = facs.length ? `<div class="evidence"><div class="section-label">Referenced resources</div>${facs.slice(0, 8).map(f => `<button type="button" class="fac-ref" data-fac="${escapeHtml(f.properties.facility_id)}">${escapeHtml(f.properties.name)}</button>`).join('')}</div>` : '';
  const limits = (a.limitations || []).length ? `<div class="qa-limits"><div class="section-label">Limitations</div><ul>${a.limitations.map(l => `<li>${escapeHtml(l)}</li>`).join('')}</ul></div>` : '';
  const warn = (a.grounding?.unverifiedFigures || []).length
    ? `<div class="ai-note ai-note-warn">Some figures in this answer (${a.grounding.unverifiedFigures.slice(0, 5).map(escapeHtml).join(', ')}) could not be matched to ReliefGrid’s data. Rely on the tract values shown in the table and on the map.</div>` : '';
  const follow = (a.followUps || []).length ? `<div class="followups">${a.followUps.slice(0, 3).map(f => `<button type="button" class="example-chip" data-follow="${escapeHtml(f)}">${escapeHtml(f)}</button>`).join('')}</div>` : '';
  return `<div class="qa-a ${a.answerable === false ? 'is-unanswerable' : ''}">
    <div class="ai-label"><span class="ai-spark" aria-hidden="true"></span>ReliefGrid analysis</div>
    <div class="prose">${renderProse(a.answer || '')}</div>
    ${findings ? `<ul class="findings">${findings}</ul>` : ''}
    ${warn}${evidence}${facList}${limits}
    <div class="ai-foot">AI-assisted analysis based on ReliefGrid data${a.meta?.sources?.length ? ` · used: ${a.meta.sources.map(escapeHtml).join(', ')}` : ''}.</div>
    ${follow}</div>`;
}
function wireThread(el) {
  el.querySelectorAll('[data-tract]').forEach(n => {
    const go = () => { showTract(n.dataset.tract, true); };
    n.addEventListener('click', go);
    n.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
  el.querySelectorAll('[data-fac]').forEach(b => b.addEventListener('click', () => {
    const f = findFacilityFeature(b.dataset.fac); if (!f) return;
    setFacilityEmphasis([b.dataset.fac]);
    flyToPoint(f.geometry.coordinates, 12.5);
  }));
  el.querySelectorAll('[data-follow]').forEach(b => b.addEventListener('click', () => ask(b.dataset.follow)));
}

// Exposed for UI tests only.
export function _analystState() { return { turns: thread.length, busy, selectedGeoid }; }
