/* ============================================================================
 * ReliefGrid AI — task router.
 * ----------------------------------------------------------------------------
 *                          RELIEFGRID AI
 *                               |
 *                    task (chosen by endpoint)
 *                  /                           \
 *     navigator.* (Resource Navigator)    analyst.* (Ask ReliefGrid)
 *            primary: Gemini                 primary: OpenAI
 *                  \                           /
 *                  same ReliefGrid data either way
 *
 * Each request goes to exactly ONE provider. If AI_ALLOW_FALLBACK=true and
 * the task is marked fallbackSafe, a retryable failure (unavailable, timeout,
 * rate limit, missing key) is retried once on the other provider — the data
 * handed to the model is identical, so capabilities don't silently change.
 * Tasks that depend on a provider-only capability (Google Maps grounding)
 * never fall back.
 * ==========================================================================*/
import { aiConfig, providerConfigured } from './config.js';
import { AIError } from './errors.js';
import { gemini } from './providers/gemini.js';
import { openai } from './providers/openai.js';

const PROVIDERS = { gemini, openai };

/**
 * @param {string} task  key in aiConfig().tasks
 * @param {(provider, taskConfig) => Promise<any>} fn
 * @returns {Promise<{ result:any, provider:string, fallbackUsed:boolean }>}
 */
export async function runTask(task, fn) {
  const c = aiConfig();
  const t = c.tasks[task];
  if (!t) throw new AIError('unavailable', `unknown task ${task}`);
  const order = [t.primary];
  if (c.allowFallback && t.fallbackSafe && t.fallback) order.push(t.fallback);
  const candidates = order.filter(providerConfigured);
  if (!candidates.length) throw new AIError('not_configured', `no provider configured for ${task}`);

  let lastErr = null;
  for (const name of candidates) {
    try {
      const result = await fn(PROVIDERS[name], t);
      return { result, provider: name, fallbackUsed: name !== t.primary };
    } catch (e) {
      lastErr = e instanceof AIError ? e : new AIError('unavailable', e?.name || 'error');
      if (!lastErr.retryable) throw lastErr;
      if (name !== candidates[candidates.length - 1]) console.warn(`[reliefgrid-ai] ${task}: ${name} ${lastErr.code}; trying fallback`);
    }
  }
  throw lastErr;
}
