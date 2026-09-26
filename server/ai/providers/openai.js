/* ============================================================================
 * OpenAI adapter — OpenAI's official Node SDK (`openai`), Responses API.
 * Implements the provider interface used by server/ai/router.js:
 *   generateJSON({ system, prompt, schema, schemaName, timeoutMs }) → object
 *
 * Structured Outputs (strict json_schema) means the reply is shape-checked by
 * the API as well as by ReliefGrid's own validators. Requests are sent with
 * store:false. The API key is read from the server environment only
 * (server/ai/config.js) and is only ever sent to OpenAI in a request header.
 * ==========================================================================*/
import OpenAI from 'openai';
import { aiConfig } from '../config.js';
import { AIError, codeForUpstreamStatus } from '../errors.js';
import { parseJSONLoose } from './util.js';

let cached = { key: null, client: null };
function client() {
  const { apiKey } = aiConfig().providers.openai;
  if (!apiKey) throw new AIError('not_configured', 'OPENAI_API_KEY missing');
  if (cached.key !== apiKey) cached = { key: apiKey, client: new OpenAI({ apiKey, maxRetries: 0 }) };
  return cached.client;
}

/** One SDK call under a hard deadline, with every failure mapped to a user-safe
 *  AIError. Details go to server logs only — never user text or the key. */
async function guarded(timeoutMs, fn) {
  const ctrl = new AbortController();
  let timer;
  const deadline = new Promise((_, rej) => { timer = setTimeout(() => { ctrl.abort(); rej(new AIError('timeout', 'openai deadline exceeded')); }, Math.max(1000, timeoutMs)); });
  try {
    return await Promise.race([fn(ctrl.signal), deadline]);
  } catch (e) {
    if (e instanceof AIError) throw e;
    if (ctrl.signal.aborted || e?.name === 'APIUserAbortError' || e?.constructor?.name === 'APIConnectionTimeoutError') throw new AIError('timeout', 'openai request aborted');
    const status = Number(e?.status);
    const detail = `openai ${e?.constructor?.name || e?.name || 'error'}${status ? ` ${status}` : ''}${e?.message ? ` — ${String(e.message).slice(0, 160)}` : ''}`;
    if (Number.isFinite(status) && status > 0) {
      if (status === 404) throw new AIError('unavailable', `${detail} (check OPENAI_MODEL)`);
      if (status === 400 && /content|policy|safety/i.test(String(e?.message))) throw new AIError('blocked', detail);
      throw new AIError(codeForUpstreamStatus(status), detail);
    }
    throw new AIError('unavailable', detail); // APIConnectionError (network)
  } finally {
    clearTimeout(timer);
  }
}

export const openai = {
  id: 'openai',

  async generateJSON({ system, prompt, schema, schemaName, timeoutMs = 20000, maxOutputTokens = 2000, reasoningEffort }) {
    const cfg = aiConfig().providers.openai;
    const params = {
      model: cfg.model,
      instructions: system,
      input: prompt,
      store: false,
      max_output_tokens: maxOutputTokens,
      text: { format: { type: 'json_schema', name: schemaName || 'reliefgrid_output', strict: true, schema } },
    };
    const effort = reasoningEffort ?? cfg.reasoningEffort;
    if (effort) params.reasoning = { effort };
    const res = await guarded(timeoutMs, (signal) => client().responses.create(params, { signal }));

    const refused = (res?.output || []).some(o => o?.type === 'message' && (o.content || []).some(c => c?.type === 'refusal'));
    if (refused) throw new AIError('blocked', 'openai refusal');
    if (res?.status && res.status !== 'completed') {
      throw new AIError(res.status === 'failed' ? 'unavailable' : 'bad_output', `openai response ${res.status}${res.incomplete_details?.reason ? ` (${res.incomplete_details.reason})` : ''}`);
    }
    return parseJSONLoose(res?.output_text || '');
  },
};
