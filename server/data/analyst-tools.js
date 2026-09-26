/* ============================================================================
 * ReliefGrid — deterministic data tools for the "Ask ReliefGrid" analyst.
 * ----------------------------------------------------------------------------
 * The language model can reach ReliefGrid data ONLY through these functions.
 * They read the precomputed research values (need_score, access_index,
 * mismatch_index, LISA labels, Moran's I diagnostics) exactly as stored in the
 * GeoJSON / JSON files and return them — they never recompute or reweight the
 * research methodology. Where a tool adds a descriptive summary (counts,
 * medians, straight-line distances), the output says so explicitly.
 * ==========================================================================*/
import { getFacilities, getTracts, getDiagnostics, tractById, normMode } from './store.js';
import { tractInsight, robustCentroid, haversineKm, LISA_LABELS } from '../../js/core/analysis.js';
import { RESOURCE_LABELS, RESOURCE_GROUPS } from '../../js/core/taxonomy.js';

const r = (x, d) => (x == null || !Number.isFinite(+x) ? null : Math.round(+x * 10 ** d) / 10 ** d);
// ACS uses large negative sentinels (e.g. -666666666) for "not available".
const acs = (x) => (x == null || !Number.isFinite(+x) || +x <= -99999 ? null : +x);
const COUNTIES = ['Nassau', 'Suffolk'];
const CLUSTERS = ['HH', 'LL', 'HL', 'LH', 'ns'];
const METRICS = ['mismatch_index', 'need_score', 'access_index', 'mismatch_pct', 'poverty_rate', 'rent_burden_rate', 'renter_share', 'median_hh_inc'];

const DEFINITIONS = {
  need_score: 'Community Need: standardized composite of poverty rate, rent burden (≥30% of income on rent) and renter share (2022 ACS 5-year). 0 = regional average; higher = greater housing-instability risk.',
  access_index: 'Service Access: E2SFCA score of resources reachable within a 15-minute catchment, weighted by competing household demand, percentile-ranked 0–100. One combined score per tract — not broken down by service category.',
  mismatch_index: 'Service Gap: Community Need minus Service Access (both standardized). Positive = need exceeds access.',
  mismatch_pct: 'Percentile rank (0–100) of the Service Gap across tracts.',
  lisa: 'LISA clusters of the Service Gap at the 5% level: HH = significant cluster of high gap (high need / low access), LL = low gap, HL / LH = spatial outliers, ns = not significant.',
};

function tractRow(p) {
  return {
    geoid: p.GEOID, county: p.county_name,
    need_score: r(p.need_score, 2), access_index: r(p.access_index, 1), mismatch_index: r(p.mismatch_index, 2), mismatch_pct: r(p.mismatch_pct, 1),
    lisa_cluster: p.lisa_mismatch_index_label || 'ns', lisa_p: r(p.lisa_mismatch_index_p, 3),
    poverty_rate: r(p.poverty_rate, 3), rent_burden_rate: r(p.rent_burden_rate, 3), renter_share: r(p.renter_share, 3),
    population: acs(p.pop_total), median_household_income: acs(p.median_hh_inc),
  };
}
const median = (arr) => { const a = arr.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const mean = (arr) => { const a = arr.filter(Number.isFinite); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
/** Top-quintile need threshold — same definition as the Overview "High-Need Areas" tile. */
function highNeedThreshold(features) {
  const vals = features.map(f => +f.properties.need_score).filter(Number.isFinite).sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length * 0.8)] : null;
}

/* ── Tool definitions (JSON Schema, provider-neutral) ─────────────────── */
export const ANALYST_TOOLS = [
  {
    name: 'get_study_overview',
    description: 'Overview of the ReliefGrid study for one travel mode: tract and resource counts, Service Gap LISA cluster counts, global Moran\'s I diagnostics, the validation-gate interpretation, and definitions of every metric. Call this first for broad questions or to explain map patterns.',
    parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['drive', 'walk'] } }, required: ['mode'] },
  },
  {
    name: 'rank_tracts',
    description: 'Rank census tracts by a precomputed metric, optionally filtered by county and/or LISA Service Gap cluster. Returns tract rows with need, access, gap, cluster label and ACS context.',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: METRICS },
        order: { type: 'string', enum: ['highest', 'lowest'] },
        mode: { type: 'string', enum: ['drive', 'walk'] },
        county: { type: 'string', enum: COUNTIES },
        cluster: { type: 'string', enum: CLUSTERS },
        limit: { type: 'integer', minimum: 1, maximum: 15 },
      },
      required: ['metric', 'order', 'mode'],
    },
  },
  {
    name: 'get_tract',
    description: 'Full precomputed values for one census tract (11-digit GEOID) in both drive and walk modes, the plain-language cluster interpretation ReliefGrid shows planners, ACS context, and the three nearest mapped resources (straight-line).',
    parameters: { type: 'object', properties: { geoid: { type: 'string' }, mode: { type: 'string', enum: ['drive', 'walk'] } }, required: ['geoid'] },
  },
  {
    name: 'summarize_by_county',
    description: 'Descriptive comparison of Nassau vs Suffolk for one travel mode: tract counts, LISA cluster counts and shares, medians/means of existing tract values, and mapped resource counts by category.',
    parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['drive', 'walk'] } }, required: ['mode'] },
  },
  {
    name: 'resource_inventory',
    description: 'Counts of mapped resource listings by category and county, optionally filtered; lists the matching listings when there are 25 or fewer.',
    parameters: { type: 'object', properties: { resource_group: { type: 'string', enum: RESOURCE_GROUPS }, county: { type: 'string', enum: COUNTIES } } },
  },
  {
    name: 'category_proximity',
    description: 'For one service category, the straight-line distance from each tract\'s centroid to the nearest mapped listing of that category, for tracts in the Service Gap HH cluster, top-quintile need, or all tracts. Use for category-specific questions (e.g. emergency shelter, food). This is NOT the Service Access score.',
    parameters: {
      type: 'object',
      properties: {
        resource_group: { type: 'string', enum: RESOURCE_GROUPS },
        mode: { type: 'string', enum: ['drive', 'walk'] },
        scope: { type: 'string', enum: ['gap_clusters', 'high_need', 'all'] },
        order: { type: 'string', enum: ['farthest', 'nearest'] },
        limit: { type: 'integer', minimum: 1, maximum: 15 },
      },
      required: ['resource_group'],
    },
  },
  {
    name: 'compare_travel_modes',
    description: 'Compare the drive and walk analyses: LISA cluster counts in each mode, how many tracts are HH in both or only one mode (with example GEOIDs), and median Service Access per mode.',
    parameters: { type: 'object', properties: {} },
  },
];

export const TOOL_LABELS = {
  get_study_overview: 'study overview', rank_tracts: 'tract rankings', get_tract: 'tract profile',
  summarize_by_county: 'county summary', resource_inventory: 'resource inventory',
  category_proximity: 'category proximity', compare_travel_modes: 'drive vs. walk comparison',
};

/* ── Implementations ──────────────────────────────────────────────────── */
const IMPL = {
  async get_study_overview({ mode }) {
    const m = normMode(mode);
    const [tracts, diag, fac] = await Promise.all([getTracts(m), getDiagnostics(m), getFacilities()]);
    const byCounty = {}; tracts.features.forEach(f => { const c = f.properties.county_name; byCounty[c] = (byCounty[c] || 0) + 1; });
    const byGroup = {}; const facByCounty = {};
    fac.features.forEach(f => { const p = f.properties; byGroup[p.resource_group] = (byGroup[p.resource_group] || 0) + 1; facByCounty[p.county] = (facByCounty[p.county] || 0) + 1; });
    return {
      mode: m, tract_count: tracts.features.length, tracts_by_county: byCounty,
      service_gap_lisa_cluster_counts: diag.lisa_counts?.mismatch_index || null,
      community_need_lisa_cluster_counts: diag.lisa_counts?.need_score || null,
      lisa_settings: { permutations: diag.permutations, p_threshold: diag.p_threshold, weights: diag.primary_weights },
      global_morans_i_queen: (diag.global_moran || []).filter(g => g.weights === 'queen').map(g => ({ variable: g.variable, I: g.I, p: g.p_sim })),
      robustness_across_weights: diag.robustness || null,
      need_access_bivariate: diag.validation_gate ? { bivariate_I: diag.validation_gate.bivariate_I, p: diag.validation_gate.p_sim, interpretation: diag.validation_gate.interpretation } : null,
      resources: { total: fac.features.length, by_category: byGroup, by_county: facByCounty, category_labels: RESOURCE_LABELS },
      definitions: DEFINITIONS,
      cluster_labels: LISA_LABELS,
    };
  },

  async rank_tracts({ metric, order, mode, county, cluster, limit }) {
    const m = normMode(mode);
    if (!METRICS.includes(metric)) return { error: `metric must be one of ${METRICS.join(', ')}` };
    const tracts = await getTracts(m);
    let rows = tracts.features.map(f => f.properties).filter(p => Number.isFinite(+p[metric]));
    if (COUNTIES.includes(county)) rows = rows.filter(p => p.county_name === county);
    if (CLUSTERS.includes(cluster)) rows = rows.filter(p => (p.lisa_mismatch_index_label || 'ns') === cluster);
    const matched = rows.length;
    rows.sort((a, b) => (order === 'lowest' ? (+a[metric] - +b[metric]) : (+b[metric] - +a[metric])));
    return {
      mode: m, metric, order: order === 'lowest' ? 'lowest' : 'highest', filters: { county: county || null, cluster: cluster || null },
      matched_tract_count: matched, returned: Math.min(matched, clampInt(limit, 1, 15, 10)),
      tracts: rows.slice(0, clampInt(limit, 1, 15, 10)).map(tractRow),
      metric_definition: DEFINITIONS[metric] || null,
    };
  },

  async get_tract({ geoid, mode }) {
    const id = String(geoid || '').trim();
    const [d, w] = await Promise.all([tractById(id, 'drive'), tractById(id, 'walk')]);
    if (!d && !w) return { error: `No tract with GEOID ${id} in ReliefGrid data.` };
    const m = normMode(mode);
    const main = (m === 'walk' ? w : d) || d || w;
    const p = main.properties;
    const vals = (f) => f ? { need_score: r(f.properties.need_score, 2), access_index: r(f.properties.access_index, 1), mismatch_index: r(f.properties.mismatch_index, 2), mismatch_pct: r(f.properties.mismatch_pct, 1), lisa_cluster: f.properties.lisa_mismatch_index_label || 'ns', lisa_p: r(f.properties.lisa_mismatch_index_p, 3) } : null;
    const insight = tractInsight(p);
    const center = robustCentroid(main);
    const fac = await getFacilities();
    const nearest = center ? fac.features
      .map(f => ({ f, km: haversineKm(center[0], center[1], f.geometry.coordinates[0], f.geometry.coordinates[1]) }))
      .sort((a, b) => a.km - b.km).slice(0, 3)
      .map(({ f, km }) => ({ facility_id: f.properties.facility_id, name: f.properties.name, category: RESOURCE_LABELS[f.properties.resource_group], straight_line_km: r(km, 1) })) : [];
    return {
      geoid: p.GEOID, county: p.county_name, requested_mode: m,
      drive: vals(d), walk: vals(w),
      interpretation: { tag: insight.tag, headline: insight.headline, explanation: insight.body },
      acs_context: {
        population: acs(p.pop_total), median_household_income: acs(p.median_hh_inc),
        poverty_rate: r(p.poverty_rate, 3), rent_burden_rate: r(p.rent_burden_rate, 3), renter_share: r(p.renter_share, 3),
        renter_occupied_units: acs(p.renter_occ), eviction_filing_rate: r(p.eviction_filing_rate, 4),
        margins_of_error: { poverty_rate: r(p.poverty_moe, 3), rent_burden_rate: r(p.rent_burden_moe, 3), renter_share: r(p.renter_moe, 3) },
      },
      nearest_resources: nearest,
    };
  },

  async summarize_by_county({ mode }) {
    const m = normMode(mode);
    const [tracts, fac] = await Promise.all([getTracts(m), getFacilities()]);
    const out = {};
    COUNTIES.forEach(c => {
      const ps = tracts.features.map(f => f.properties).filter(p => p.county_name === c);
      const clusters = Object.fromEntries(CLUSTERS.map(k => [k, ps.filter(p => (p.lisa_mismatch_index_label || 'ns') === k).length]));
      const fs = fac.features.filter(f => f.properties.county === c);
      const byGroup = {}; fs.forEach(f => { byGroup[f.properties.resource_group] = (byGroup[f.properties.resource_group] || 0) + 1; });
      out[c] = {
        tracts: ps.length,
        lisa_cluster_counts: clusters,
        share_of_tracts_in_HH_cluster_pct: ps.length ? r((clusters.HH / ps.length) * 100, 1) : null,
        median: { need_score: r(median(ps.map(p => +p.need_score)), 2), access_index: r(median(ps.map(p => +p.access_index)), 1), mismatch_index: r(median(ps.map(p => +p.mismatch_index)), 2) },
        mean: { need_score: r(mean(ps.map(p => +p.need_score)), 2), access_index: r(mean(ps.map(p => +p.access_index)), 1), mismatch_index: r(mean(ps.map(p => +p.mismatch_index)), 2) },
        population_total: ps.reduce((s, p) => s + (acs(p.pop_total) || 0), 0),
        resources_total: fs.length, resources_by_category: byGroup,
      };
    });
    return { mode: m, counties: out, note: 'Descriptive statistics of existing tract values (unweighted by population). No research values were recomputed.' };
  },

  async resource_inventory({ resource_group, county }) {
    const fac = await getFacilities();
    let fs = fac.features;
    if (RESOURCE_GROUPS.includes(resource_group)) fs = fs.filter(f => f.properties.resource_group === resource_group);
    if (COUNTIES.includes(county)) fs = fs.filter(f => f.properties.county === county);
    const counts = {};
    fs.forEach(f => { const k = `${f.properties.resource_group}|${f.properties.county}`; counts[k] = (counts[k] || 0) + 1; });
    return {
      filters: { resource_group: resource_group || null, county: county || null },
      total: fs.length,
      counts: Object.entries(counts).map(([k, n]) => { const [g, c] = k.split('|'); return { category: RESOURCE_LABELS[g] || g, resource_group: g, county: c, count: n }; }),
      listings: fs.length <= 25 ? fs.map(f => ({ facility_id: f.properties.facility_id, name: f.properties.name, resource_group: f.properties.resource_group, type: f.properties.type, county: f.properties.county, address: f.properties.address || null })) : undefined,
      note: 'Counts of mapped listings in ReliefGrid’s dataset; they do not reflect capacity or current availability.',
    };
  },

  async category_proximity({ resource_group, mode, scope, order, limit }) {
    if (!RESOURCE_GROUPS.includes(resource_group)) return { error: `resource_group must be one of ${RESOURCE_GROUPS.join(', ')}` };
    const m = normMode(mode);
    const [tracts, fac] = await Promise.all([getTracts(m), getFacilities()]);
    const targets = fac.features.filter(f => f.properties.resource_group === resource_group);
    if (!targets.length) return { error: `No mapped listings in category ${resource_group}.` };
    const sc = ['gap_clusters', 'high_need', 'all'].includes(scope) ? scope : 'gap_clusters';
    const thr = highNeedThreshold(tracts.features);
    const pool = tracts.features.filter(f => sc === 'all' ? true : sc === 'high_need' ? (thr != null && +f.properties.need_score >= thr) : (f.properties.lisa_mismatch_index_label === 'HH'));
    const rows = pool.map(f => {
      const c = robustCentroid(f); if (!c) return null;
      let best = null;
      targets.forEach(t => { const km = haversineKm(c[0], c[1], t.geometry.coordinates[0], t.geometry.coordinates[1]); if (!best || km < best.km) best = { km, t }; });
      const p = f.properties;
      return { geoid: p.GEOID, county: p.county_name, lisa_cluster: p.lisa_mismatch_index_label || 'ns', need_score: r(p.need_score, 2), access_index: r(p.access_index, 1), nearest_km: best.km, nearest: best.t.properties };
    }).filter(Boolean);
    rows.sort((a, b) => (order === 'nearest' ? a.nearest_km - b.nearest_km : b.nearest_km - a.nearest_km));
    const kms = rows.map(x => x.nearest_km);
    const n = clampInt(limit, 1, 15, 10);
    return {
      category: RESOURCE_LABELS[resource_group], resource_group, mode: m, scope: sc,
      scope_definition: sc === 'gap_clusters' ? 'Tracts in the significant Service Gap HH cluster' : sc === 'high_need' ? 'Tracts in the top quintile of Community Need (same definition as the dashboard\'s High-Need Areas tile)' : 'All tracts',
      mapped_listings_in_category: targets.length,
      tracts_considered: rows.length,
      median_nearest_km: r(median(kms), 1),
      tracts_over_5km: kms.filter(k => k > 5).length,
      tracts_over_10km: kms.filter(k => k > 10).length,
      order: order === 'nearest' ? 'nearest' : 'farthest',
      tracts: rows.slice(0, n).map(x => ({ geoid: x.geoid, county: x.county, lisa_cluster: x.lisa_cluster, need_score: x.need_score, access_index: x.access_index, nearest_listing_km: r(x.nearest_km, 1), nearest_listing: { facility_id: x.nearest.facility_id, name: x.nearest.name } })),
      method_note: 'Straight-line distance from each tract centroid to the nearest mapped listing of this category. It is not the E2SFCA Service Access score and ignores road networks, transit, capacity and eligibility.',
    };
  },

  async compare_travel_modes() {
    const [d, w, dd, dw] = await Promise.all([getTracts('drive'), getTracts('walk'), getDiagnostics('drive'), getDiagnostics('walk')]);
    const lab = (fc) => new Map(fc.features.map(f => [f.properties.GEOID, f.properties.lisa_mismatch_index_label || 'ns']));
    const ld = lab(d), lw = lab(w);
    const both = [], driveOnly = [], walkOnly = [];
    ld.forEach((v, g) => { const wv = lw.get(g); if (v === 'HH' && wv === 'HH') both.push(g); else if (v === 'HH') driveOnly.push(g); else if (wv === 'HH') walkOnly.push(g); });
    return {
      service_gap_cluster_counts: { drive: dd.lisa_counts?.mismatch_index || null, walk: dw.lisa_counts?.mismatch_index || null },
      hh_in_both_modes: { count: both.length, example_geoids: both.slice(0, 10) },
      hh_drive_only: { count: driveOnly.length, example_geoids: driveOnly.slice(0, 10) },
      hh_walk_only: { count: walkOnly.length, example_geoids: walkOnly.slice(0, 10) },
      median_access_index: { drive: r(median(d.features.map(f => +f.properties.access_index)), 1), walk: r(median(w.features.map(f => +f.properties.access_index)), 1) },
      note: 'Drive and walk access values come from separate catchment analyses; compare rankings and cluster membership rather than treating the two scales as identical.',
    };
  },
};

/** Execute a tool by name with model-supplied args; never throws. */
export async function executeTool(name, args) {
  const fn = IMPL[name];
  if (!fn) return { error: `Unknown tool ${name}` };
  try { return await fn(args && typeof args === 'object' ? args : {}); }
  catch (e) { return { error: 'Tool failed to read ReliefGrid data.' }; }
}
