/* ============================================================================
 * ReliefGrid AI — input hygiene and output grounding checks.
 * ==========================================================================*/

/** Trim, collapse whitespace, strip control characters, cap length. */
export function cleanText(v, max = 500) {
  return String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Server-side repeat of the browser's redaction (defence in depth). */
export function redactServerSide(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, '[number]')
    .replace(/(\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]')
    .replace(/\b\d{7,}\b/g, '[number]');
}

/* ── Numeric grounding ─────────────────────────────────────────────────
 * Every figure the analyst writes should trace back to a value a tool
 * returned (possibly rounded, or shown as a percentage). Figures that can't
 * be matched are reported to the UI, which tells the user to rely on the
 * data-sourced table instead. GEOIDs are validated separately.            */

/** Collect every number found in a JSON value (including inside strings). */
export function collectNumbers(value, out = new Set()) {
  if (value == null) return out;
  if (typeof value === 'number') { if (Number.isFinite(value)) out.add(value); return out; }
  if (typeof value === 'string') { numbersInText(value).forEach(n => out.add(n.value)); return out; }
  if (Array.isArray(value)) { value.forEach(v => collectNumbers(v, out)); return out; }
  if (typeof value === 'object') Object.values(value).forEach(v => collectNumbers(v, out));
  return out;
}

/** Numbers written in prose, with their shown precision and % marker. */
export function numbersInText(text) {
  const out = [];
  const re = /(^|[^\w.])([-−]?\d{1,3}(?:,\d{3})+(?:\.\d+)?|[-−]?\d+(?:\.\d+)?)(\s?%)?/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const raw = m[2].replace(/,/g, '').replace('−', '-');
    if (/^-?\d{11}$/.test(raw)) continue; // census tract GEOID
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
    out.push({ text: m[2] + (m[3] || ''), value, decimals, percent: !!m[3] });
  }
  return out;
}

const ALWAYS_OK = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 30, 50, 95, 99, 100, 999, 2020, 2022, 2023, 2024, 2025, 2026]);

/** Return the figures in `texts` that don't match any allowed number. */
export function unverifiedFigures(texts, allowedNumbers) {
  const allowed = [...allowedNumbers];
  const matches = (n) => {
    if (ALWAYS_OK.has(Math.abs(n.value)) && n.decimals === 0) return true;
    const tol = 0.5 * Math.pow(10, -n.decimals) + 1e-9;
    return allowed.some(v => {
      const cands = [v, Math.abs(v), v * 100, Math.abs(v) * 100];
      return cands.some(c => Math.abs(c - Math.abs(n.value)) <= tol || Math.abs(c - n.value) <= tol);
    });
  };
  const bad = [];
  texts.forEach(t => numbersInText(t).forEach(n => { if (!matches(n) && !bad.includes(n.text)) bad.push(n.text); }));
  return bad;
}

/** 11-digit Suffolk/Nassau tract GEOIDs mentioned in prose. */
export function geoidsInText(text) {
  return [...String(text).matchAll(/\b(36\d{9})\b/g)].map(m => m[1]);
}
