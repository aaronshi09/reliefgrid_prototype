/* ============================================================================
 * ReliefGrid AI — browser client for ReliefGrid's own AI backend.
 * ----------------------------------------------------------------------------
 * - One fetch wrapper with a hard timeout and user-safe error messages (raw
 *   upstream errors never reach the page).
 * - Strips obvious personal identifiers before anything leaves the browser.
 * - Never logs request text to the console and never stores it.
 * ==========================================================================*/
import { AI_CLIENT_CONFIG } from './config.js';

const USER_MESSAGES = {
  not_configured: 'AI assistance isn’t set up on this deployment yet.',
  unavailable: 'ReliefGrid’s AI service is temporarily unavailable. Please try again in a moment.',
  rate_limited: 'Too many requests right now. Please wait a moment and try again.',
  timeout: 'This is taking longer than expected. Please try again.',
  network: 'Can’t reach ReliefGrid’s AI service. Check your connection and try again.',
  bad_output: 'The AI response couldn’t be read reliably, so nothing was shown. Please try rephrasing.',
  blocked: 'That request couldn’t be processed. Try describing it a different way.',
  invalid_request: 'That request couldn’t be sent. Please shorten it or rephrase and try again.',
  unknown: 'Something went wrong with AI assistance. Please try again.',
};

export class AIClientError extends Error {
  constructor(code) { super(code); this.code = USER_MESSAGES[code] ? code : 'unknown'; this.userMessage = USER_MESSAGES[this.code]; }
}

/* ── Status (is the backend reachable / which features are configured) ── */
let status = { checked: false, reachable: false, navigator: false, analyst: false, locationContext: false, missing: [] };
let statusPromise = null;

export function getAIStatus() { return status; }
export function loadAIStatus() {
  if (statusPromise) return statusPromise;
  statusPromise = (async () => {
    try {
      const r = await timedFetch(url('status'), { method: 'GET' }, AI_CLIENT_CONFIG.timeoutsMs.status);
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      status = {
        checked: true, reachable: true,
        navigator: !!j?.features?.navigator, analyst: !!j?.features?.analyst,
        locationContext: !!j?.features?.locationContext,
        missing: Array.isArray(j?.setup?.missing) ? j.setup.missing.filter(s => /^[A-Z_]+$/.test(s)) : [],
      };
    } catch (_) {
      // No backend (e.g. static hosting) — AI surfaces show a setup notice.
      status = { checked: true, reachable: false, navigator: false, analyst: false, locationContext: false, missing: [] };
    }
    document.dispatchEvent(new CustomEvent('rg:ai-status', { detail: status }));
    return status;
  })();
  return statusPromise;
}

/* ── Requests ─────────────────────────────────────────────────────────── */
function url(key) { return AI_CLIENT_CONFIG.apiBase + AI_CLIENT_CONFIG.endpoints[key]; }

async function timedFetch(u, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(u, { ...init, signal: ctrl.signal, credentials: 'omit' }); }
  finally { clearTimeout(timer); }
}

/** POST to an AI endpoint. Resolves with parsed JSON or throws AIClientError. */
export async function aiRequest(key, body) {
  let res;
  try {
    res = await timedFetch(url(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, AI_CLIENT_CONFIG.timeoutsMs[key] || 30000);
  } catch (e) {
    throw new AIClientError(e && e.name === 'AbortError' ? 'timeout' : 'network');
  }
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON (e.g. 404 page) */ }
  if (!res.ok || !json || json.ok === false) {
    const code = json?.error?.code || (res.status === 404 ? 'not_configured' : res.status === 429 ? 'rate_limited' : 'unavailable');
    throw new AIClientError(code);
  }
  return json;
}

/* ── Privacy: minimise what is sent to the AI provider ─────────────────── */
/** Remove emails, phone numbers, SSN-like and long ID numbers, and street
 *  numbers before a request leaves the browser. Town names are kept because
 *  they are used for the (prototype) location lookup. */
export function redactSensitive(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, '[number]')
    .replace(/(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]')
    .replace(/\b\d{7,}\b/g, '[number]')
    .replace(/\b\d{1,6}\s+(?:[A-Z][\w.]*\s){0,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Drive|Tpke|Turnpike|Hwy|Highway)\b\.?/gi, '[street address]')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── Rendering helper: tiny, safe markdown subset for AI prose ─────────── */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
/** Paragraphs, "- " bullets and **bold** only; everything is escaped first. */
export function renderProse(text) {
  const lines = esc(text).split(/\n+/).map(l => l.trim()).filter(Boolean);
  let html = '', inList = false;
  for (const l of lines) {
    const bullet = /^[-•*]\s+(.*)$/.exec(l);
    if (bullet) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${bold(bullet[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += `<p>${bold(l)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}
function bold(s) { return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); }

/** Friendly setup / unavailable notice shared by both AI surfaces. */
export function setupNoticeHTML(feature) {
  const s = status;
  const envName = feature === 'analyst' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
  const dev = !s.reachable
    ? `No ReliefGrid AI backend was found for this page. Run <code>npm run dev</code> locally, or deploy the <code>api/</code> functions (see README).`
    : `Set <code>${envName}</code> in the server environment to enable it (see README).`;
  return `<div class="ai-setup" role="note"><div class="ai-setup-title"><span class="ai-spark" aria-hidden="true"></span>AI assistance is not available here</div>
    <div class="ai-setup-body">${feature === 'analyst' ? 'All maps, layers and tract details on this page still work.' : 'You can still browse by category, use your location, and filter results below.'}</div>
    <details class="ai-setup-dev"><summary>For developers</summary><div>${dev}</div></details></div>`;
}
