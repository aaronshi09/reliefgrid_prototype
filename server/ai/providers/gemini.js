/* ============================================================================
 * Gemini adapter — Google's official Gen AI SDK (@google/genai).
 * Implements the provider interface used by server/ai/router.js:
 *   generateJSON({ system, prompt, schema, timeoutMs })      → object
 *   runTools({ system, messages, tools, execute, ... })     → { text }
 *   groundedMapsContext({ system, prompt, latLng, ... })    → { text, sources }
 *
 * generateJSON (the Resource Navigator path) uses the Interactions API — the
 * SDK's recommended interface for new projects — with a JSON-Schema
 * response_format and store:false so Google does not retain the request for
 * later retrieval. Tool-calling and Maps grounding use models.generateContent,
 * which the SDK still fully supports.
 *
 * The API key is read from the server environment only (server/ai/config.js)
 * and never leaves this process.
 * ==========================================================================*/
import { GoogleGenAI } from '@google/genai';
import { aiConfig } from '../config.js';
import { AIError, codeForUpstreamStatus } from '../errors.js';
import { parseJSONLoose, toGeminiSchema } from './util.js';

let cached = { key: null, client: null };
function client() {
  const { apiKey } = aiConfig().providers.gemini;
  if (!apiKey) throw new AIError('not_configured', 'GEMINI_API_KEY missing');
  if (cached.key !== apiKey) cached = { key: apiKey, client: new GoogleGenAI({ apiKey }) };
  return cached.client;
}

/**
 * Run one SDK call under a hard deadline we own (the SDK's own timeout timer
 * does not keep a serverless event loop alive), and translate every failure
 * into a user-safe AIError. Details go to server logs only — never user text.
 */
async function guarded(timeoutMs, fn) {
  const ctrl = new AbortController();
  let timer;
  const deadline = new Promise((_, rej) => { timer = setTimeout(() => { ctrl.abort(); rej(new AIError('timeout', 'gemini deadline exceeded')); }, Math.max(1000, timeoutMs)); });
  try {
    return await Promise.race([fn(ctrl.signal), deadline]);
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (ctrl.signal.aborted || e?.name === 'AbortError' || e?.name === 'RequestAbortedError' || e?.name === 'RequestTimeoutError') throw new AIError('timeout', 'gemini request aborted');
    const status = Number(e?.status);
    const detail = `gemini ${e?.name || 'error'}${status ? ` ${status}` : ''}${e?.message ? ` — ${String(e.message).slice(0, 160)}` : ''}`;
    if (Number.isFinite(status) && status > 0) {
      if (status === 404) throw new AIError('unavailable', `${detail} (check GEMINI_MODEL)`);
      throw new AIError(codeForUpstreamStatus(status), detail);
    }
    throw new AIError('unavailable', detail); // e.g. APIConnectionError (network)
  } finally {
    clearTimeout(timer);
  }
}

const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

export const gemini = {
  id: 'gemini',

  /** Structured JSON via the Interactions API. */
  async generateJSON({ system, prompt, schema, timeoutMs = 20000, maxOutputTokens = 1024 }) {
    const { model, thinkingLevel } = aiConfig().providers.gemini;
    const generation_config = { max_output_tokens: maxOutputTokens };
    if (thinkingLevel) generation_config.thinking_level = thinkingLevel;
    const interaction = await guarded(timeoutMs, (signal) => client().interactions.create({
      model,
      system_instruction: system,
      input: prompt,
      store: false,
      generation_config,
      response_format: { type: 'text', mime_type: 'application/json', schema },
    }, { maxRetries: 0, fetchOptions: { signal } }));

    if (interaction?.status && interaction.status !== 'completed') {
      const why = JSON.stringify(interaction.errors || []).toLowerCase();
      if (/safety|blocked|prohibited/.test(why)) throw new AIError('blocked', `gemini interaction ${interaction.status} (safety)`);
      throw new AIError(interaction.status === 'failed' ? 'unavailable' : 'bad_output', `gemini interaction ${interaction.status}`);
    }
    // output_text is assembled by the SDK from the final model_output step;
    // fall back to an `outputs` array in case the response shape differs.
    const text = interaction?.output_text
      || (Array.isArray(interaction?.outputs) ? interaction.outputs.filter(o => o?.type === 'text').map(o => o.text || '').join('') : '');
    return parseJSONLoose(text);
  },

  /**
   * Function-calling loop (used only if Ask ReliefGrid falls back to Gemini).
   * Gemini cannot combine function calling with a response schema here, so
   * the final answer is requested as JSON and validated by the caller.
   */
  async runTools({ system, messages, tools, execute, maxSteps = 6, deadline }) {
    const { model } = aiConfig().providers.gemini;
    const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
    const functionDeclarations = tools.map(t => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) }));
    for (let step = 0; ; step++) {
      const last = step >= maxSteps;
      const remaining = deadline - Date.now();
      if (remaining < 2000) throw new AIError('timeout', 'gemini tool loop out of time');
      const res = await guarded(remaining, (signal) => client().models.generateContent({
        model, contents,
        config: {
          systemInstruction: system,
          tools: [{ functionDeclarations }],
          toolConfig: { functionCallingConfig: { mode: last ? 'NONE' : 'AUTO' } },
          abortSignal: signal,
        },
      }));
      const cand = res?.candidates?.[0];
      if (!cand) throw new AIError('bad_output', 'gemini returned no candidate');
      if (BLOCKED.has(cand.finishReason)) throw new AIError('blocked', `gemini finish ${cand.finishReason}`);
      const calls = (cand.content?.parts || []).filter(p => p.functionCall);
      if (!calls.length || last) return { text: textOf(cand) };
      contents.push(cand.content); // includes thought signatures — echoed back unchanged
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
    const { model } = aiConfig().providers.gemini;
    const config = { systemInstruction: system, tools: [{ googleMaps: {} }] };
    if (latLng) config.toolConfig = { retrievalConfig: { latLng: { latitude: latLng[1], longitude: latLng[0] } } };
    const res = await guarded(timeoutMs, (signal) => client().models.generateContent({
      model, contents: [{ role: 'user', parts: [{ text: prompt }] }], config: { ...config, abortSignal: signal },
    }));
    const cand = res?.candidates?.[0];
    if (!cand) throw new AIError('bad_output', 'gemini returned no candidate');
    if (BLOCKED.has(cand.finishReason)) throw new AIError('blocked', `gemini finish ${cand.finishReason}`);
    const sources = (cand.groundingMetadata?.groundingChunks || []).map(c => c.maps || c.web).filter(Boolean)
      .map(s => ({ title: String(s.title || '').slice(0, 120), uri: String(s.uri || '') }))
      .filter(s => /^https:\/\//.test(s.uri));
    return { text: textOf(cand), sources };
  },
};

function textOf(cand) {
  return (cand.content?.parts || []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
}
