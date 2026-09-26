/* ============================================================================
 * OpenAI adapter (Chat Completions REST API).
 * Implements the same provider interface as gemini.js:
 *   generateJSON({ system, prompt, schema, schemaName, timeoutMs }) → object
 *   runTools({ system, messages, tools, execute, finalSchema, ... }) → { text }
 * Structured output uses strict json_schema, so the final answer is shape-
 * checked by the API as well as by ReliefGrid's own validator.
 * ==========================================================================*/
import { aiConfig } from '../config.js';
import { AIError, codeForUpstreamStatus } from '../errors.js';
import { parseJSONLoose, isTimeout, upstreamDetail } from './util.js';

async function complete(body, timeoutMs) {
  const cfg = aiConfig().providers.openai;
  if (!cfg.apiKey) throw new AIError('not_configured', 'OPENAI_API_KEY missing');
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, ...body }),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
  } catch (e) {
    throw new AIError(isTimeout(e) ? 'timeout' : 'unavailable', 'openai request failed');
  }
  if (!res.ok) throw new AIError(codeForUpstreamStatus(res.status), `openai ${await upstreamDetail(res)}`);
  const json = await res.json().catch(() => null);
  const choice = json?.choices?.[0];
  if (!choice) throw new AIError('bad_output', 'openai returned no choice');
  if (choice.finish_reason === 'content_filter' || choice.message?.refusal) throw new AIError('blocked', 'openai refusal / content filter');
  return choice;
}

const responseFormat = (schema, name) => (schema ? { type: 'json_schema', json_schema: { name: name || 'reliefgrid_output', strict: true, schema } } : undefined);

export const openai = {
  id: 'openai',

  async generateJSON({ system, prompt, schema, schemaName, timeoutMs = 20000 }) {
    const choice = await complete({
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      response_format: responseFormat(schema, schemaName),
    }, timeoutMs);
    return parseJSONLoose(choice.message?.content || '');
  },

  async runTools({ system, messages, tools, execute, finalSchema, finalSchemaName, maxSteps = 6, deadline }) {
    const msgs = [{ role: 'system', content: system }, ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }))];
    const toolDefs = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    for (let step = 0; ; step++) {
      const last = step >= maxSteps;
      const remaining = deadline - Date.now();
      if (remaining < 2000) throw new AIError('timeout', 'openai tool loop out of time');
      const choice = await complete({
        messages: msgs,
        tools: toolDefs,
        tool_choice: last ? 'none' : 'auto',
        response_format: responseFormat(finalSchema, finalSchemaName),
      }, remaining);
      const calls = choice.message?.tool_calls || [];
      if (!calls.length || last) return { text: choice.message?.content || '' };
      msgs.push({ role: 'assistant', content: choice.message.content ?? null, tool_calls: calls });
      for (const c of calls) {
        let args = {};
        try { args = JSON.parse(c.function?.arguments || '{}'); } catch (_) { args = {}; }
        const result = await execute(c.function?.name, args);
        msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
      }
    }
  },
};
