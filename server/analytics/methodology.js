/* ============================================================================
 * ReliefGrid analytics — methodology documentation, read from the project.
 * ----------------------------------------------------------------------------
 * The authoritative methodology text is the "Data & Methods" page in
 * index.html, plus the research diagnostics files. Methodology answers are
 * grounded in exactly that text (parsed here at runtime), so the assistant
 * cannot substitute a generic textbook description that differs from what
 * ReliefGrid actually documents.
 * ==========================================================================*/
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDiagnostics } from '../data/store.js';
import { LISA_LABELS } from '../../js/core/analysis.js';

const HERE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROOT = existsSync(join(HERE_ROOT, 'index.html')) ? HERE_ROOT : process.cwd();

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&ge;': '≥', '&le;': '≤', '&mdash;': '—', '&ndash;': '–', '&rarr;': '→', '&nbsp;': ' ' };
const text = (html) => html.replace(/<li>/g, '\n- ').replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m] ?? m).replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();

let cache = null;
/** { cards: [{ title, text }], layers: [{ key, name, hint }], source } */
export async function methodologyDocs() {
  if (cache) return cache;
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const cards = [...html.matchAll(/<div class="method-card[^"]*"><h3>([\s\S]*?)<\/h3>([\s\S]*?)<\/div>/g)]
    .map(m => ({ title: text(m[1]), text: text(m[2]) }))
    // The availability / AI cards describe the prototype, not the research method.
    .filter(c => c.title && c.text);
  const layers = [];
  const seen = new Set();
  for (const m of html.matchAll(/<input type="radio" name="gov-gaps-layer" value="([a-z_]+)"[^>]*><span>([^<]+)<\/span><span class="layer-hint">([^<]+)<\/span>/g)) {
    if (seen.has(m[1])) continue; seen.add(m[1]);
    layers.push({ key: m[1], name: text(m[2]), hint: text(m[3]) });
  }
  cache = { cards, layers, source: 'ReliefGrid Data & Methods page (index.html)' };
  return cache;
}

const CARD_TOPICS = {
  community_need: ['Community Need'],
  service_access: ['Service Access'],
  service_gap: ['Service Gap', 'Community Need', 'Service Access'],
  lisa: ['Service Gap'],
  resources: ['Resource network', 'Availability (prototype)'],
  limitations: ['Limitations'],
};

/** Methodology context for the given topics (always includes Limitations). */
export async function methodologyContext(topics, mode) {
  const { cards, layers, source } = await methodologyDocs();
  const wanted = new Set(['Limitations']);
  (topics.length ? topics : Object.keys(CARD_TOPICS)).forEach(t => (CARD_TOPICS[t] || []).forEach(x => wanted.add(x)));
  const diag = await getDiagnostics(mode);
  return {
    source,
    documented_methods: cards.filter(c => wanted.has(c.title)),
    map_layers: layers,
    lisa_settings: { permutations: diag.permutations, significance_threshold_p: diag.p_threshold, spatial_weights: diag.primary_weights, travel_mode: diag.mode },
    lisa_cluster_labels: LISA_LABELS,
    note: 'This is the complete methodology documentation available in ReliefGrid. Details not stated here (for example distance-decay functions or ACS variable codes) are not documented in the project.',
  };
}
