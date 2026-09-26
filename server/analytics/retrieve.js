/* ============================================================================
 * ReliefGrid analytics — deterministic context retrieval.
 * ----------------------------------------------------------------------------
 * Step 2 of Ask ReliefGrid: for the classified domains, pull ONLY the relevant
 * precomputed values from ReliefGrid's own files and package them as a small,
 * labelled context. Nothing here recomputes the research: need_score,
 * access_index, mismatch_index, LISA labels / p-values and Moran's I are read
 * as stored. Descriptive helpers (rankings, medians, nearest tracts or
 * listings by straight-line distance) say so in their output.
 *
 * The same context drives three things:
 *   - what the model is allowed to see (and therefore to cite),
 *   - which tract / facility ids an answer may reference (allow-lists),
 *   - "Analysis based on …" (metricsUsed) and the default map focus.
 * ==========================================================================*/
import { executeTool } from '../data/analyst-tools.js';
import { getTracts, getFacilities, getDiagnostics, tractById, normMode } from '../data/store.js';
import { tractInsight, robustCentroid, haversineKm, LISA_LABELS } from '../../js/core/analysis.js';
import { RESOURCE_LABELS } from '../../js/core/taxonomy.js';
import { methodologyContext } from './methodology.js';

const r = (x, d) => (x == null || !Number.isFinite(+x) ? null : Math.round(+x * 10 ** d) / 10 ** d);
const acs = (x) => (x == null || !Number.isFinite(+x) || +x <= -99999 ? null : +x);
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (s, q) => s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];

export const METRIC_LABELS = {
  need: 'Community Need', access: 'Service Access (E2SFCA)', gap: 'Service Gap', lisa: 'Service Gap clusters (LISA)',
  moran: "Moran's I diagnostics", drive: 'Drive catchments', walk: 'Walk catchments', resources: 'Resource locations',
  distance: 'Straight-line distance to listings', acs: 'ACS indicators (poverty, rent burden, renters)', methods: 'ReliefGrid methodology documentation',
};
const DEFAULT_LAYER = {
  need_access: 'lisa', lisa: 'lisa', service_gap: 'mismatch_index', community_need: 'need_score', service_access: 'access_index',
  category_access: 'lisa', mode_comparison: 'lisa', investigation: 'lisa', overview: 'lisa',
};

function compactTract(p) {
  return {
    geoid: p.GEOID, county: p.county_name,
    need_score: r(p.need_score, 2), access_index: r(p.access_index, 1), mismatch_index: r(p.mismatch_index, 2),
    lisa_cluster: p.lisa_mismatch_index_label || 'ns', lisa_p: r(p.lisa_mismatch_index_p, 3),
  };
}
const withAcs = (p) => ({ ...compactTract(p), poverty_rate: r(p.poverty_rate, 3), rent_burden_rate: r(p.rent_burden_rate, 3), renter_share: r(p.renter_share, 3), population: acs(p.pop_total) });

async function regionalMedians(mode) {
  const fc = await getTracts(mode);
  const ps = fc.features.map(f => f.properties);
  return {
    description: 'Median of all 665 tracts (descriptive, unweighted) — for comparison only',
    need_score: r(median(ps.map(p => +p.need_score)), 2), access_index: r(median(ps.map(p => +p.access_index)), 1), mismatch_index: r(median(ps.map(p => +p.mismatch_index)), 2),
  };
}

async function nearbyTracts(feat, mode, k = 6) {
  const c = robustCentroid(feat); if (!c) return [];
  const fc = await getTracts(mode);
  return fc.features.filter(f => f.properties.GEOID !== feat.properties.GEOID)
    .map(f => ({ f, km: (() => { const cc = robustCentroid(f); return cc ? haversineKm(c[0], c[1], cc[0], cc[1]) : Infinity; })() }))
    .sort((a, b) => a.km - b.km).slice(0, k)
    .map(({ f, km }) => ({ ...compactTract(f.properties), centroid_distance_km: r(km, 1) }));
}

async function nearbyResources(feat, k = 8) {
  const c = robustCentroid(feat); if (!c) return { listings: [] };
  const fac = await getFacilities();
  const all = fac.features.map(f => ({ f, km: haversineKm(c[0], c[1], f.geometry.coordinates[0], f.geometry.coordinates[1]) })).sort((a, b) => a.km - b.km);
  const row = ({ f, km }) => ({ facility_id: f.properties.facility_id, name: f.properties.name, category: RESOURCE_LABELS[f.properties.resource_group], straight_line_km: r(km, 1) });
  const nearestByCategory = {};
  all.forEach(x => { const g = RESOURCE_LABELS[x.f.properties.resource_group]; if (!nearestByCategory[g]) nearestByCategory[g] = row(x); });
  return {
    method: 'Straight-line distance from the tract centroid to mapped ReliefGrid listings (not travel time).',
    nearest: all.slice(0, k).map(row),
    within_5_km: all.filter(x => x.km <= 5).length,
    nearest_by_category: nearestByCategory,
  };
}

async function lisaSummary(mode, clusterTypes = []) {
  const [fc, diag] = await Promise.all([getTracts(mode), getDiagnostics(mode)]);
  const ps = fc.features.map(f => f.properties);
  const of = (k) => ps.filter(p => (p.lisa_mismatch_index_label || 'ns') === k);
  const hh = of('HH').sort((a, b) => b.mismatch_index - a.mismatch_index);
  const ll = of('LL').sort((a, b) => a.mismatch_index - b.mismatch_index);
  const focus = clusterTypes.length ? clusterTypes : ['HH', 'LL'];
  const byCounty = (list) => list.reduce((o, p) => { o[p.county_name] = (o[p.county_name] || 0) + 1; return o; }, {});
  return {
    mode,
    service_gap_cluster_counts: diag.lisa_counts?.mismatch_index || null,
    community_need_cluster_counts: diag.lisa_counts?.need_score || null,
    cluster_counts_by_county: { HH: byCounty(of('HH')), LL: byCounty(of('LL')), HL: byCounty(of('HL')), LH: byCounty(of('LH')) },
    cluster_labels: LISA_LABELS,
    global_morans_i: (diag.global_moran || []).filter(g => g.weights === diag.primary_weights).map(g => ({ variable: g.variable, I: g.I, p: g.p_sim })),
    need_access_relationship: diag.validation_gate ? { bivariate_I: diag.validation_gate.bivariate_I, p: diag.validation_gate.p_sim, interpretation: diag.validation_gate.interpretation } : null,
    examples: {
      ...(focus.includes('HH') ? { HH_largest_gap: hh.slice(0, 8).map(compactTract) } : {}),
      ...(focus.includes('LL') ? { LL_smallest_gap: ll.slice(0, 6).map(compactTract) } : {}),
      ...(focus.includes('HL') || !clusterTypes.length ? { HL_all: of('HL').map(compactTract) } : {}),
      ...(focus.includes('LH') || !clusterTypes.length ? { LH_all: of('LH').map(compactTract) } : {}),
    },
    note: `Cluster membership comes from the stored LISA labels (${diag.permutations} permutations, p < ${diag.p_threshold}, ${diag.primary_weights} weights). Examples are ranked by stored Service Gap values.`,
  };
}

async function layerSummary(layer, mode) {
  if (layer === 'lisa') return lisaSummary(mode);
  const key = ['need_score', 'access_index', 'mismatch_index'].includes(layer) ? layer : 'mismatch_index';
  const fc = await getTracts(mode);
  const ps = fc.features.map(f => f.properties).filter(p => Number.isFinite(+p[key]));
  const s = ps.map(p => +p[key]).sort((a, b) => a - b);
  const d = key === 'access_index' ? 1 : 2;
  const sorted = [...ps].sort((a, b) => +b[key] - +a[key]);
  return {
    layer: key, mode,
    distribution: { description: 'Descriptive distribution of the stored values across tracts', min: r(s[0], d), p25: r(quantile(s, 0.25), d), median: r(quantile(s, 0.5), d), p75: r(quantile(s, 0.75), d), max: r(s[s.length - 1], d), tracts: s.length },
    highest: sorted.slice(0, 5).map(compactTract),
    lowest: sorted.slice(-5).reverse().map(compactTract),
  };
}

async function needAccess(mode, county) {
  const fc = await getTracts(mode);
  let hh = fc.features.map(f => f.properties).filter(p => p.lisa_mismatch_index_label === 'HH');
  if (county) hh = hh.filter(p => p.county_name === county);
  const byNeed = [...hh].sort((a, b) => b.need_score - a.need_score);
  const byGap = [...hh].sort((a, b) => b.mismatch_index - a.mismatch_index);
  return {
    mode, definition: 'ReliefGrid classifies "high need / low access" areas as tracts in the statistically significant HH Service Gap cluster (stored LISA label).',
    filters: { county: county || null },
    hh_cluster_tracts: hh.length,
    hh_by_county: hh.reduce((o, p) => { o[p.county_name] = (o[p.county_name] || 0) + 1; return o; }, {}),
    highest_need_in_cluster: byNeed.slice(0, 8).map(withAcs),
    largest_gap_in_cluster: byGap.slice(0, 5).map(compactTract),
  };
}

async function selectedArea(geoid, mode) {
  const [d, w] = await Promise.all([tractById(geoid, 'drive'), tractById(geoid, 'walk')]);
  const main = (mode === 'walk' ? w : d) || d || w;
  if (!main) return null;
  const p = main.properties;
  const insight = tractInsight(p);
  return {
    tract: {
      ...withAcs(p),
      median_household_income: acs(p.median_hh_inc),
      drive: d ? compactTract(d.properties) : null, walk: w ? compactTract(w.properties) : null,
      reliefgrid_interpretation: { tag: insight.tag, headline: insight.headline, explanation: insight.body },
    },
    regional_medians: await regionalMedians(mode),
    nearby_tracts: { method: 'Six nearest tracts by centroid distance (descriptive context, not the LISA neighbour set)', tracts: await nearbyTracts(main, mode) },
  };
}

/**
 * Build the context for a classified question.
 * @returns {{ blocks: object, metrics: string[], allowedTracts: Set, allowedFacilities: Set,
 *             defaultTracts: string[], defaultFacilities: string[], layer: string|null, subject: string|null }}
 */
export async function buildContext(cls, { mode: uiMode, layer: uiLayer, selectedTract }) {
  const p = cls.params;
  const mode = normMode(p.mode || uiMode);
  const domains = cls.domains;
  const blocks = {};
  const metrics = new Set([mode === 'walk' ? METRIC_LABELS.walk : METRIC_LABELS.drive]);
  let defaultTracts = [], defaultFacilities = [];
  const subject = p.geoid || (domains.includes('selected_area') || domains.includes('resources') || domains.includes('mode_comparison') ? selectedTract : null) || null;
  const has = (d) => domains.includes(d);

  if (has('selected_area') || (subject && (has('resources') || has('mode_comparison')))) {
    const s = subject ? await selectedArea(subject, mode) : null;
    if (s) {
      blocks.selected_area = s;
      [METRIC_LABELS.need, METRIC_LABELS.access, METRIC_LABELS.gap, METRIC_LABELS.lisa, METRIC_LABELS.acs].forEach(m => metrics.add(m));
      defaultTracts.push(subject);
    }
  }
  if (has('need_access') || has('investigation')) {
    blocks.high_need_low_access = await needAccess(mode, p.county);
    [METRIC_LABELS.need, METRIC_LABELS.access, METRIC_LABELS.lisa].forEach(m => metrics.add(m));
    defaultTracts.push(...blocks.high_need_low_access.highest_need_in_cluster.map(t => t.geoid));
  }
  const rankings = !p.definitionOnly && !has('map_explanation');
  if (has('service_gap') && rankings && !(has('selected_area') && subject)) {
    blocks.service_gap_ranking = await executeTool('rank_tracts', { metric: 'mismatch_index', order: p.order === 'lowest' ? 'lowest' : 'highest', mode, county: p.county || undefined, limit: 10 });
    [METRIC_LABELS.gap, METRIC_LABELS.need, METRIC_LABELS.access].forEach(m => metrics.add(m));
    defaultTracts.push(...blocks.service_gap_ranking.tracts.map(t => t.geoid));
  }
  if (has('community_need') && rankings) {
    blocks.community_need_ranking = await executeTool('rank_tracts', { metric: 'need_score', order: p.order === 'lowest' ? 'lowest' : 'highest', mode, county: p.county || undefined, limit: 10 });
    [METRIC_LABELS.need, METRIC_LABELS.acs].forEach(m => metrics.add(m));
    defaultTracts.push(...blocks.community_need_ranking.tracts.map(t => t.geoid));
  }
  if (has('service_access') && rankings) {
    blocks.service_access_ranking = await executeTool('rank_tracts', { metric: 'access_index', order: p.order === 'highest' ? 'highest' : 'lowest', mode, county: p.county || undefined, limit: 10 });
    metrics.add(METRIC_LABELS.access);
    defaultTracts.push(...blocks.service_access_ranking.tracts.map(t => t.geoid));
  }
  if ((has('category_access') || has('investigation')) && p.category) {
    blocks.category_proximity = await executeTool('category_proximity', { resource_group: p.category, mode, scope: 'gap_clusters', order: 'farthest', limit: 8 });
    blocks.category_inventory = await executeTool('resource_inventory', { resource_group: p.category, county: p.county || undefined });
    [METRIC_LABELS.resources, METRIC_LABELS.distance, METRIC_LABELS.lisa].forEach(m => metrics.add(m));
    if (!blocks.category_proximity.error) {
      defaultTracts.push(...blocks.category_proximity.tracts.map(t => t.geoid));
      defaultFacilities.push(...new Set(blocks.category_proximity.tracts.map(t => t.nearest_listing.facility_id)));
    }
  }
  if (has('lisa')) {
    blocks.spatial_clusters = await lisaSummary(mode, p.clusterTypes);
    [METRIC_LABELS.lisa, METRIC_LABELS.moran].forEach(m => metrics.add(m));
    const ex = blocks.spatial_clusters.examples;
    defaultTracts.push(...[...(ex.HH_largest_gap || []), ...(ex.LL_smallest_gap || [])].map(t => t.geoid));
  }
  if (has('mode_comparison') || p.compareModes) {
    blocks.drive_vs_walk = await executeTool('compare_travel_modes', {});
    [METRIC_LABELS.drive, METRIC_LABELS.walk, METRIC_LABELS.access, METRIC_LABELS.lisa].forEach(m => metrics.add(m));
    if (!subject) defaultTracts.push(...blocks.drive_vs_walk.hh_in_both_modes.example_geoids);
  }
  if (has('resources')) {
    const feat = subject ? await tractById(subject, mode) : null;
    blocks.resources = feat ? { near_tract: subject, ...(await nearbyResources(feat)) } : await executeTool('resource_inventory', { county: p.county || undefined, resource_group: p.category || undefined });
    metrics.add(METRIC_LABELS.resources);
    if (feat) { metrics.add(METRIC_LABELS.distance); defaultFacilities.push(...blocks.resources.nearest.map(x => x.facility_id)); }
  }
  if (has('map_explanation')) {
    const layer = p.layerMentioned || (['lisa', 'mismatch_index', 'need_score', 'access_index'].includes(uiLayer) ? uiLayer : 'lisa');
    blocks.current_layer = { layer, ...(await layerSummary(layer, mode)) };
    const cl = blocks.current_layer;
    defaultTracts.push(...(layer === 'lisa' ? (cl.examples?.HH_largest_gap || []) : (cl.highest || [])).slice(0, 8).map(t => t.geoid));
    metrics.add(layer === 'lisa' ? METRIC_LABELS.lisa : layer === 'need_score' ? METRIC_LABELS.need : layer === 'access_index' ? METRIC_LABELS.access : METRIC_LABELS.gap);
  }
  if (has('overview') || (!Object.keys(blocks).length && !has('methodology'))) {
    const ov = await executeTool('get_study_overview', { mode });
    delete ov.definitions; delete ov.cluster_labels; if (ov.resources) delete ov.resources.category_labels;
    blocks.study_overview = ov;
    [METRIC_LABELS.lisa, METRIC_LABELS.moran, METRIC_LABELS.resources].forEach(m => metrics.add(m));
  }
  // Methodology text accompanies methodology questions and layer explanations.
  if (has('methodology') || has('map_explanation') || has('selected_area') || has('investigation')) {
    const topics = [];
    if (has('service_gap') || has('need_access') || has('selected_area') || has('map_explanation') || has('investigation')) topics.push('service_gap');
    if (has('service_access') || has('mode_comparison')) topics.push('service_access');
    if (has('community_need')) topics.push('community_need');
    if (has('lisa')) topics.push('lisa');
    if (has('resources') || has('category_access')) topics.push('resources');
    blocks.methodology = await methodologyContext(topics, mode);
    metrics.add(METRIC_LABELS.methods);
  }

  const json = JSON.stringify(blocks);
  const allowedTracts = new Set([...json.matchAll(/"(36\d{9})"/g)].map(m => m[1]));
  const allowedFacilities = new Set([...json.matchAll(/"facility_id":"([^"]+)"/g)].map(m => m[1]));
  const primary = domains.find(d => DEFAULT_LAYER[d]);
  return {
    blocks, mode, subject: blocks.selected_area ? subject : null,
    explicitLayer: p.layerMentioned || null, // a layer the user named always wins
    metrics: [...metrics],
    allowedTracts, allowedFacilities,
    defaultTracts: [...new Set(defaultTracts)].filter(g => allowedTracts.has(g)).slice(0, 30),
    defaultFacilities: [...new Set(defaultFacilities)].filter(f => allowedFacilities.has(f)).slice(0, 12),
    layer: has('map_explanation') ? (p.layerMentioned || null) : (primary ? DEFAULT_LAYER[primary] : null),
  };
}
