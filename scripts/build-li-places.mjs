/* ============================================================================
 * Build data/li_places.json — Long Island place names and ZIP codes.
 *   node scripts/build-li-places.mjs
 * Source: U.S. Census Bureau 2025 Gazetteer files (public domain):
 *   - places (villages, cities, CDPs/hamlets) for New York
 *   - county subdivisions (towns) for New York
 *   - ZIP Code Tabulation Areas (national)
 * Each entry's Census internal point is kept only if it falls inside one of
 * ReliefGrid's own Nassau/Suffolk census-tract polygons, so the service area
 * matches the research data exactly. Resolving a town or ZIP then needs no
 * external API at all (private, free, deterministic).
 * ==========================================================================*/
import { readFile, writeFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const ROOT = new URL('../', import.meta.url);
const BASE = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/';
const SRC = { places: `${BASE}2025_gaz_place_36.txt`, towns: `${BASE}2025_gaz_cousubs_36.txt`, zcta: `${BASE}2025_Gaz_zcta_national.zip` };

const text = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.text(); };
async function unzipFirst(u) {
  const buf = Buffer.from(await (await fetch(u)).arrayBuffer());
  // Minimal single-file ZIP reader (local file header → deflated data).
  const nameLen = buf.readUInt16LE(26), extraLen = buf.readUInt16LE(28), compSize = buf.readUInt32LE(18), method = buf.readUInt16LE(8);
  const start = 30 + nameLen + extraLen;
  let data = buf.subarray(start, compSize ? start + compSize : undefined);
  if (!compSize) { const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); data = buf.subarray(start, cd); }
  return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
}
const rows = (tsv) => { const [h, ...lines] = tsv.trim().split(/\r?\n/); const cols = h.split('|').map(s => s.trim()); return lines.map(l => Object.fromEntries(l.split('|').map((v, i) => [cols[i], v.trim()]))); };

// Point-in-polygon against ReliefGrid's tract polygons.
const tracts = JSON.parse(await readFile(new URL('tracts_drive_diagnostics.geojson', ROOT), 'utf8'));
const polys = tracts.features.flatMap(f => f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates);
const bbox = polys.flat(2).reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
function inRing(x, y, ring) { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; }
const onLongIsland = (x, y) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3] && polys.some(p => inRing(x, y, p[0]) && !p.slice(1).some(h => inRing(x, y, h)));

const r4 = (v) => Math.round(+v * 1e4) / 1e4;
const clean = (name) => name.replace(/\s+(CDP|village|city|town|borough)$/i, '').trim();
const places = new Map();
const add = (name, lat, lng, kind) => {
  const label = clean(name); const key = label.toLowerCase();
  if (!label || places.has(key)) return; // villages / hamlets win over same-named towns
  places.set(key, { name: label, lat: r4(lat), lng: r4(lng), kind });
};

const [placeRows, townRows, zctaRows] = [rows(await text(SRC.places)), rows(await text(SRC.towns)), rows(await unzipFirst(SRC.zcta))];
placeRows.filter(p => onLongIsland(+p.INTPTLONG, +p.INTPTLAT)).forEach(p => add(p.NAME, p.INTPTLAT, p.INTPTLONG, 'place'));
townRows.filter(t => /town$/i.test(t.NAME) && onLongIsland(+t.INTPTLONG, +t.INTPTLAT)).forEach(t => add(t.NAME, t.INTPTLAT, t.INTPTLONG, 'town'));
const zips = {};
zctaRows.filter(z => /^1[01]\d{3}$/.test(z.GEOID) && onLongIsland(+z.INTPTLONG, +z.INTPTLAT)).forEach(z => { zips[z.GEOID] = [r4(z.INTPTLONG), r4(z.INTPTLAT)]; });

const out = {
  source: 'U.S. Census Bureau, 2025 Gazetteer Files (places, county subdivisions, ZCTAs) — public domain. Filtered to ReliefGrid\'s Nassau/Suffolk tracts.',
  note: 'Coordinates are Census internal points (area centres), not addresses.',
  places: [...places.values()].sort((a, b) => a.name.localeCompare(b.name)),
  zips,
};
await writeFile(new URL('data/li_places.json', ROOT), JSON.stringify(out));
console.log(`places: ${out.places.length} (${out.places.filter(p => p.kind === 'town').length} towns) · ZIP codes: ${Object.keys(zips).length}`);
