/* ============================================================================
 * ReliefGrid — server-side read-only access to the SAME data files the
 * browser loads. Nothing is copied, transformed or re-computed on disk; files
 * are parsed once per server instance and cached in memory.
 * ==========================================================================*/
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Serverless bundles keep the relative layout; fall back to cwd just in case.
const ROOT = existsSync(join(HERE_ROOT, 'longisland_facilities.geojson')) ? HERE_ROOT : process.cwd();

const cache = new Map();
function readJSON(rel) {
  if (!cache.has(rel)) {
    const p = readFile(join(ROOT, rel), 'utf8').then(JSON.parse);
    p.catch(() => cache.delete(rel)); // allow a retry after a transient failure
    cache.set(rel, p);
  }
  return cache.get(rel);
}

export const normMode = (m) => (m === 'walk' ? 'walk' : 'drive');
export const getFacilities = () => readJSON('longisland_facilities.geojson');
export const getTracts = (mode) => readJSON(normMode(mode) === 'walk' ? 'tracts_walk_diagnostics.geojson' : 'tracts_drive_diagnostics.geojson');
export const getDiagnostics = (mode) => readJSON(`diagnostics_${normMode(mode)}.json`);

let facIndex = null;
export async function facilityById(id) {
  if (!facIndex) {
    const fc = await getFacilities();
    facIndex = new Map(fc.features.map(f => [f.properties.facility_id, f]));
  }
  return facIndex.get(id) || null;
}

const tractIndex = new Map();
export async function tractById(geoid, mode) {
  const m = normMode(mode);
  if (!tractIndex.has(m)) {
    const fc = await getTracts(m);
    tractIndex.set(m, new Map(fc.features.map(f => [f.properties.GEOID, f])));
  }
  return tractIndex.get(m).get(geoid) || null;
}
