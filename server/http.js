/* ============================================================================
 * ReliefGrid AI — shared HTTP handler wrapper.
 * Works as a Vercel Node function (export default handler) and inside the
 * local dev server. Responsibilities: method + origin checks, body size
 * limit, best-effort per-IP rate limiting, no-store caching, and mapping every
 * failure to a small, user-safe error code. Request text is never logged.
 * ==========================================================================*/
import { aiConfig } from './ai/config.js';
import { AIError } from './ai/errors.js';

const buckets = new Map(); // best-effort: per server instance only
function rateLimited(ip, perMin) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now > b.reset) { b = { count: 0, reset: now + 60_000 }; buckets.set(ip, b); }
  b.count++;
  if (buckets.size > 5000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  return b.count > perMin;
}
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (Array.isArray(xf) ? xf[0] : (xf || '')).split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}
function sameOrigin(req, origin) {
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
}
async function readBody(req, maxBytes) {
  if (req.body !== undefined && req.body !== null) { // pre-parsed by the platform
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const s = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (Buffer.byteLength(s) > maxBytes) throw new AIError('invalid_request', 'body too large');
    try { return JSON.parse(s || '{}'); } catch (_) { throw new AIError('invalid_request', 'body not JSON'); }
  }
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new AIError('invalid_request', 'body too large');
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch (_) { throw new AIError('invalid_request', 'body not JSON'); }
}
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

export function createHandler({ methods = ['POST'], handle }) {
  return async function handler(req, res) {
    const cfg = aiConfig();
    const origin = req.headers.origin;
    const crossAllowed = origin && cfg.allowedOrigins.includes(origin);
    if (crossAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', [...methods, 'OPTIONS'].join(', '));
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') { res.statusCode = crossAllowed ? 204 : 403; return res.end(); }

    const path = String(req.url || '').split('?')[0];
    try {
      if (!methods.includes(req.method)) throw new AIError('method_not_allowed');
      if (origin && !crossAllowed && !sameOrigin(req, origin)) throw new AIError('forbidden', 'origin not allowed');
      if (req.method === 'POST' && rateLimited(clientIp(req), cfg.rateLimitPerMin)) throw new AIError('rate_limited', 'local rate limit');
      const body = req.method === 'POST' ? await readBody(req, cfg.limits.bodyBytes) : null;
      const data = await handle(body, req);
      send(res, 200, { ok: true, ...data });
    } catch (e) {
      const err = e instanceof AIError ? e : new AIError('unavailable', e?.name || 'error');
      // Log codes and provider status only — never user text or API keys.
      console.error(`[reliefgrid-ai] ${req.method} ${path} → ${err.code}${err.detail ? ` (${err.detail})` : ''}`);
      send(res, err.status, { ok: false, error: { code: err.code } });
    }
  };
}
