/* Shared helpers for provider adapters. */
import { AIError } from '../errors.js';

/** Parse model output as JSON, tolerating code fences / leading prose. */
export function parseJSONLoose(text) {
  if (typeof text !== 'string' || !text.trim()) throw new AIError('bad_output', 'empty model output');
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) { /* fall through */ } }
  throw new AIError('bad_output', 'model output was not valid JSON');
}

/**
 * Convert the JSON Schema used throughout ReliefGrid (OpenAI strict-mode
 * compatible) into Gemini's OpenAPI-subset schema: upper-case types,
 * `nullable` instead of ["x","null"], no additionalProperties.
 */
export function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  let type = s.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter(t => t !== 'null');
    if (type.includes('null')) out.nullable = true;
    type = nonNull[0];
  }
  if (type) out.type = String(type).toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum.filter(v => v !== null);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (typeof s.minimum === 'number') out.minimum = s.minimum;
  if (typeof s.maximum === 'number') out.maximum = s.maximum;
  if (typeof s.maxItems === 'number') out.maxItems = s.maxItems;
  return out;
}

export function isTimeout(e) { return e && (e.name === 'TimeoutError' || e.name === 'AbortError'); }

/** Short, content-free description of an upstream error body for server logs. */
export async function upstreamDetail(res) {
  try {
    const j = await res.json();
    const msg = j?.error?.message || j?.error?.status || '';
    return `http ${res.status}${msg ? ` — ${String(msg).slice(0, 160)}` : ''}`;
  } catch (_) { return `http ${res.status}`; }
}
