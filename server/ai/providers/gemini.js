/* ============================================================================
 * Gemini adapter (Google Generative Language REST API, v1beta).
 * Implements the provider interface used by server/ai/router.js:
 *   generateJSON({ system, prompt, schema, timeoutMs })      → object
 *   runTools({ system, messages, tools, execute, ... })     → { text }
 *   groundedMapsContext({ system, prompt, latLng, ... })    → { text, sources }
 * No SDK dependency — plain fetch — so it runs on any Node 18+ host.
 * ==========================================================================*/
import { aiConfig } from '../config.js';
import { AIError, codeForUpstreamStatus } from '../errors.js';
import { parseJSONLoose, toGeminiSchema, isTimeout, upstreamDetail } from './util.js';

const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

async function generate(body, timeoutMs) {
  const cfg = aiConfig().providers.gemini;
  if (!cfg.apiKey) throw new AIError('not_configured', 'GEMINI_API_KEY missing');
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/models/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
  } catch (e) {
    throw new AIError(isTimeout(e) ? 'timeout' : 'unavailable', 'gemini request failed');
  }
  if (!res.ok) throw new AIError(codeForUpstreamStatus(res.status), `gemini ${await upstreamDetail(res)}`);
  const json = await res.json().catch(() => null);
  if (!json) throw new AIError('bad_output', 'gemini returned non-JSON');
  if (json.promptFeedback?.blockReason) throw new AIError('blocked', `gemini prompt blocked: ${json.promptFeedback.blockReason}`);
  const cand = json.candidates?.[0];
  if (!cand) throw new AIError('bad_output', 'gemini returned no candidate');
  if (BLOCKED.has(cand.finishReason)) throw new AIError('blocked', `gemini finish ${cand.finishReason}`);
  return cand;
}

function textOf(cand) {
  return (cand.content?.parts || []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
}

export const gemini = {
  id: 'gemini',

  async generateJSON({ system, prompt, schema, timeoutMs = 20000, temperature = 0.1 }) {
    const cand = await generate({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
    }, timeoutMs);
    return parseJSONLoose(textOf(cand));
  },

  /**
   * Function-calling loop. Gemini cannot combine function calling with a
   * response schema, so the final answer is requested as JSON in the system
   * prompt and validated by the caller.
   */
  async runTools({ system, messages, tools, execute, maxSteps = 6, deadline }) {
    const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
    const functionDeclarations = tools.map(t => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) }));
    for (let step = 0; ; step++) {
      const last = step >= maxSteps;
      const remaining = deadline - Date.now();
      if (remaining < 2000) throw new AIError('timeout', 'gemini tool loop out of time');
      const cand = await generate({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig: { mode: last ? 'NONE' : 'AUTO' } },
        generationConfig: { temperature: 0.2 },
      }, remaining);
      const calls = (cand.content?.parts || []).filter(p => p.functionCall);
      if (!calls.length || last) return { text: textOf(cand) };
      contents.push(cand.content); // includes any thought signatures — must be echoed back unchanged
      const parts = [];
      for (const p of calls) {
        const result = await execute(p.functionCall.name, p.functionCall.args || {});
        parts.push({ functionResponse: { name: p.functionCall.name, response: { result } } });
      }
      contents.push({ role: 'user', parts });
    }
  },

  /** Optional: Grounding with Google Maps (external location context). */
  async groundedMapsContext({ system, prompt, latLng, timeoutMs = 25000 }) {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ googleMaps: {} }],
      generationConfig: { temperature: 0.2 },
    };
    if (latLng) body.toolConfig = { retrievalConfig: { latLng: { latitude: latLng[1], longitude: latLng[0] } } };
    const cand = await generate(body, timeoutMs);
    const chunks = cand.groundingMetadata?.groundingChunks || [];
    const sources = chunks.map(c => c.maps || c.web).filter(Boolean)
      .map(s => ({ title: String(s.title || '').slice(0, 120), uri: String(s.uri || '') }))
      .filter(s => /^https:\/\//.test(s.uri));
    return { text: textOf(cand), sources };
  },
};
