/* ============================================================================
 * ReliefGrid — pure geo / interpretation helpers (no browser dependencies).
 * ----------------------------------------------------------------------------
 * These were previously inlined in js/shared.js and js/gov.js. They live here
 * so the browser UI and the server-side AI analyst tools run the *same* code:
 * the plain-language reading of an area that a planner sees in the Service
 * Gaps panel is exactly the one the AI is given. Nothing here computes
 * research scores — need_score, access_index, mismatch_index and the LISA
 * labels are read as-is from the precomputed tract GeoJSON.
 * ==========================================================================*/

export function haversineKm(lng1, lat1, lng2, lat2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
export function kmToMiles(km) { return km * 0.621371; }

/** Vertex-average of the first ring. Unchanged from the original UI helper so
 *  existing on-screen figures (e.g. the Capacity gap analysis) stay identical. */
export function featureCentroid(feat) {
  try {
    const coords = feat.geometry.coordinates[0];
    const lng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    return [lng, lat];
  } catch (_) { return null; }
}

/** Like featureCentroid, but also handles MultiPolygon (first polygon's outer
 *  ring). Used for map framing and by the AI tools; returns null if invalid. */
export function robustCentroid(feat) {
  const g = feat && feat.geometry; if (!g) return null;
  const ring = g.type === 'MultiPolygon' ? g.coordinates?.[0]?.[0] : g.type === 'Polygon' ? g.coordinates?.[0] : null;
  if (!Array.isArray(ring) || !ring.length) return null;
  const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
  const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

/** Bounding box [[minLng,minLat],[maxLng,maxLat]] of polygon features. */
export function featuresBounds(features) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === 'number') { if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0]; if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1]; return; }
    c.forEach(visit);
  };
  (features || []).forEach(f => { if (f?.geometry?.coordinates) visit(f.geometry.coordinates); });
  return Number.isFinite(minX) ? [[minX, minY], [maxX, maxY]] : null;
}

/** Nearest point features to a coordinate (straight-line). */
export function nearestFrom(features, fromCoords, n = 3, filterFn = null) {
  if (!fromCoords) return [];
  return (features || [])
    .filter(f => !filterFn || filterFn(f))
    .map(f => ({ feature: f, distKm: haversineKm(fromCoords[0], fromCoords[1], f.geometry.coordinates[0], f.geometry.coordinates[1]) }))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, n);
}

/** Plain-language reading of one tract's precomputed LISA / need / access
 *  values. This is the wording shown in the Service Gaps panel. */
export function tractInsight(p) {
  const lisa = p.lisa_mismatch_index_label || 'ns';
  if (lisa === 'HH') return { tag: 'Priority for review', tagClass: 'gap-tag-hh', headline: 'High need, low access',
    body: 'This area has relatively high housing-instability risk but comparatively limited access to homelessness-related services — and sits inside a broader cluster of similarly underserved neighborhoods, not an isolated data point.', action: 'Area for further service-planning review' };
  if (lisa === 'LL') return { tag: 'Currently well-served', tagClass: 'gap-tag-ll', headline: 'Lower need, strong access',
    body: 'This area has comparatively lower housing-instability risk and relatively strong access to nearby services, inside a cluster of similarly well-served neighborhoods.', action: null };
  if (lisa === 'HL') return { tag: 'Isolated high-need tract', tagClass: 'gap-tag-hl', headline: 'High need, but neighbors are not',
    body: 'This tract shows high housing-instability risk while its immediate neighbors do not — worth a closer look to confirm the pattern holds before treating it as a cluster.', action: null };
  if (lisa === 'LH') return { tag: 'Contextual', tagClass: 'gap-tag-lh', headline: 'Lower need, surrounded by higher-need areas',
    body: 'This tract itself shows lower measured need but sits among higher-need neighbors — access here may still matter to the surrounding area.', action: null };
  const needHigh = +p.need_score > 0, accessLow = +p.access_index < 50;
  return { tag: 'Not a significant cluster', tagClass: 'gap-tag-ns',
    headline: needHigh && accessLow ? 'Above-average need, below-average access' : needHigh ? 'Above-average need' : accessLow ? 'Below-average access' : 'Near typical need and access',
    body: 'This tract does not fall inside a statistically significant need/access cluster — read this pattern with more caution than the highlighted cluster areas.', action: null };
}

export const LISA_LABELS = {
  HH: 'High need / low access', LL: 'Low need / high access',
  HL: 'Isolated high-need', LH: 'Isolated low-need', ns: 'Not significant',
};
