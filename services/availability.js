/* ============================================================================
 * ReliefGrid — Real-Time Resource Availability Service
 * ----------------------------------------------------------------------------
 * PROTOTYPE NOTICE
 * This service currently serves SIMULATED availability data. ReliefGrid does not yet
 * have live feeds from shelters, HMIS systems, food pantries, or other
 * providers. Every record returned here should be presented to end users as
 * "Demo data" until a real integration replaces the DemoFileAdapter below.
 *
 * ARCHITECTURE
 * The service is source-agnostic. It merges availability records from a list of
 * registered "adapters", newest-wins, with locally-entered provider updates
 * always taking precedence. To connect a real system later you implement one
 * AvailabilityAdapter and register it — no UI code changes required.
 *
 *   AvailabilityAdapter {
 *     id: string                       // stable slug, e.g. "hmis-clarity"
 *     label: string                    // human label shown in the UI
 *     trustLevel: 'verified'|'reported'|'simulated'
 *     async fetchAll(): AvailabilityRow[]
 *     async fetchOne(facilityId): AvailabilityRow | null   // optional
 *   }
 *
 *   AvailabilityRow {
 *     facility_id: string              // must match longisland_facilities.geojson
 *     availability: {
 *       total_capacity?:    number     // e.g. shelter beds
 *       available_capacity?: number
 *       meals_available?:   number     // food pantry packages / meals
 *       next_service_time?: string     // "4:00 PM", "Tomorrow 10:00 AM"
 *       wait_minutes?:      number     // healthcare / intake queue
 *       walk_ins?:          boolean
 *       accepting_clients?: boolean
 *       open_now?:          boolean
 *       message?:           string     // short free-text status note
 *       updated_minutes_ago?: number   // demo only — relative to load time
 *       last_updated?:      string     // ISO 8601 — real adapters use this
 *       update_source?:     string     // key into SOURCES
 *     }
 *   }
 *
 * FUTURE INTEGRATION POINTS (see registerAdapter calls at bottom of file):
 *   - ProviderPortalAdapter   provider-entered updates (today: localStorage;
 *                             later: POST /api/availability + auth)
 *   - HmisAdapter             HUD HMIS bed inventory / nightly census export
 *   - BitfocusClarityAdapter  Clarity Human Services API (Looker/Data Bridge)
 *   - TwoOneOneAdapter        211 / iCarol resource availability
 *   - FindhelpAdapter         findhelp (Aunt Bertha) program availability
 *   - UniteUsAdapter          Unite Us network resource capacity
 *   - OpenReferralAdapter     Open Referral HSDS `service_capacity` objects
 *   - GovOpenDataAdapter      county / state open-data availability endpoints
 * ==========================================================================*/

/* ── Status vocabulary ──────────────────────────────────────────────────── */
export const STATUS = {
  available: { key: 'available', label: 'Available',            short: 'A', glyph: '✓', color: '#1a7f37', bg: '#dcfce7', fg: '#14532d' },
  limited:   { key: 'limited',   label: 'Limited Availability', short: 'L', glyph: '!', color: '#b45309', bg: '#fef3c7', fg: '#7c2d12' },
  full:      { key: 'full',      label: 'Full',                 short: 'F', glyph: '×', color: '#b91c1c', bg: '#fee2e2', fg: '#7f1d1d' },
  closed:    { key: 'closed',    label: 'Closed',               short: 'C', glyph: '–', color: '#4b5563', bg: '#f3f4f6', fg: '#1f2937' },
  unknown:   { key: 'unknown',   label: 'Unknown',              short: '?', glyph: '?', color: '#9ca3af', bg: '#f9fafb', fg: '#4b5563' },
};

/* ── Source vocabulary ──────────────────────────────────────────────────── */
export const SOURCES = {
  provider:          { label: 'Provider reported',            trust: 'reported' },
  hmis:              { label: 'HMIS bed inventory',           trust: 'verified' },
  coordinated_entry: { label: 'Coordinated entry system',     trust: 'verified' },
  clarity:           { label: 'Bitfocus Clarity',             trust: 'verified' },
  '211':             { label: '211 Long Island',              trust: 'reported' },
  findhelp:          { label: 'findhelp',                      trust: 'reported' },
  unite_us:          { label: 'Unite Us network',             trust: 'reported' },
  open_data:         { label: 'Government open data',          trust: 'verified' },
  demo_simulation:   { label: 'Demo simulation',              trust: 'simulated' },
};

/* ── Freshness thresholds (minutes) ─────────────────────────────────────── */
const FRESH_MAX = 60;     // < 1 hour  → fresh
const AGING_MAX = 360;    // < 6 hours → aging, otherwise stale

export function freshnessOf(minutesAgo) {
  if (minutesAgo == null || !Number.isFinite(minutesAgo)) return 'unknown';
  if (minutesAgo < FRESH_MAX) return 'fresh';
  if (minutesAgo < AGING_MAX) return 'aging';
  return 'stale';
}

export const FRESHNESS_LABELS = {
  fresh:   'Fresh',
  aging:   'Aging',
  stale:   'Stale',
  unknown: 'Unknown',
};

/** Human "x minutes ago" string. */
export function relativeTime(minutesAgo) {
  if (minutesAgo == null || !Number.isFinite(minutesAgo)) return 'time unknown';
  const m = Math.max(0, Math.round(minutesAgo));
  if (m < 1) return 'just now';
  if (m === 1) return '1 minute ago';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h === 1) return '1 hour ago';
  if (m < 24 * 60) return `${h} hours ago`;
  const d = Math.round(m / (60 * 24));
  if (d === 1) return 'yesterday';
  return `${d} days ago`;
}

/* ── Status derivation ──────────────────────────────────────────────────── */
/**
 * Map a raw availability object to a STATUS key. Ordering matters: an explicit
 * closed/at-capacity signal always wins over an "accepting" flag.
 */
export function deriveStatus(a) {
  if (!a || typeof a !== 'object') return 'unknown';
  if (a.open_now === false) return 'closed';

  // Bed / physical capacity (shelters, transitional housing)
  if (Number.isFinite(a.total_capacity) && a.total_capacity > 0 && Number.isFinite(a.available_capacity)) {
    if (a.accepting_clients === false || a.available_capacity <= 0) return 'full';
    const ratio = a.available_capacity / a.total_capacity;
    return ratio <= 0.12 ? 'limited' : 'available';
  }

  // Meal / package inventory (food pantries)
  if (Number.isFinite(a.meals_available)) {
    if (a.meals_available <= 0) return 'full';
    if (a.meals_available <= 10) return 'limited';
    return 'available';
  }

  // Walk-in services (healthcare, legal intake)
  if (a.walk_ins === true) {
    return Number.isFinite(a.wait_minutes) && a.wait_minutes >= 60 ? 'limited' : 'available';
  }
  if (a.walk_ins === false && a.accepting_clients === true) return 'limited'; // by appointment only

  // Generic intake flag
  if (a.accepting_clients === true) return 'available';
  if (a.accepting_clients === false) return 'full';
  return 'unknown';
}

/* ── Adapters: demo file + provider portal ──────────────────────────────── */

/**
 * DemoFileAdapter — loads the checked-in simulated dataset.
 * REPLACE THIS with a real adapter (or several) when live feeds exist.
 */
class DemoFileAdapter {
  constructor(url = './data/availability_demo.json') {
    this.id = 'demo-file';
    this.label = 'Demo simulation';
    this.trustLevel = 'simulated';
    this.url = url;
  }
  async fetchAll() {
    const res = await fetch(this.url);
    if (!res.ok) throw new Error(`demo availability ${res.status}`);
    const doc = await res.json();
    return (doc.records || []).map(r => ({
      facility_id: r.facility_id,
      availability: { update_source: 'demo_simulation', ...r.availability },
    }));
  }
}

/**
 * ProviderPortalAdapter — provider-entered updates.
 * TODAY: persisted in localStorage so the prototype works offline / on GitHub
 * Pages with no backend.
 * LATER: swap the read/write bodies for `fetch('/api/availability', ...)` against
 * an authenticated endpoint. The rest of the app is unaffected.
 */
const LS_KEY = 'atlas.availability.providerUpdates.v1';

class ProviderPortalAdapter {
  constructor() {
    this.id = 'provider-portal';
    this.label = 'Provider reported';
    this.trustLevel = 'reported';
  }
  _read() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); }
    catch { return {}; }
  }
  _write(obj) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch { /* ignore quota / privacy mode */ }
  }
  async fetchAll() {
    const store = this._read();
    return Object.entries(store).map(([facility_id, availability]) => ({ facility_id, availability }));
  }
  /** Persist one provider update. Returns the stored availability object. */
  put(facilityId, patch) {
    const store = this._read();
    const merged = {
      ...(store[facilityId] || {}),
      ...patch,
      update_source: 'provider',
      last_updated: new Date().toISOString(),
    };
    // Drop empty-string / null keys so they don't mask demo values unintentionally
    Object.keys(merged).forEach(k => { if (merged[k] === '' || merged[k] === undefined) delete merged[k]; });
    store[facilityId] = merged;
    this._write(store);
    return merged;
  }
  clear(facilityId) {
    const store = this._read();
    if (facilityId) delete store[facilityId]; else Object.keys(store).forEach(k => delete store[k]);
    this._write(store);
  }
}

/* ── Service singleton ──────────────────────────────────────────────────── */

const providerAdapter = new ProviderPortalAdapter();

class AvailabilityService {
  constructor() {
    /** @type {Array<{id:string,label:string,trustLevel:string,fetchAll:Function}>} */
    this.adapters = [];
    /** merged availability keyed by facility_id → raw availability object */
    this._raw = new Map();
    /** facility metadata keyed by facility_id (from the GeoJSON) */
    this._meta = new Map();
    this._listeners = new Set();
    this._loadedAt = Date.now();
    this._providerIds = new Set();
    this.providerAdapter = providerAdapter;
  }

  registerAdapter(adapter) { this.adapters.push(adapter); return this; }

  /** Feed the facilities GeoJSON so analytics / portal can resolve names. */
  registerResources(geojson) {
    (geojson?.features || []).forEach(f => {
      const p = f.properties || {};
      this._meta.set(p.facility_id, {
        facility_id: p.facility_id,
        name: p.name,
        resource_group: p.resource_group,
        type: p.type,
        county: p.county,
        address: p.address,
        website: p.source_url || null,
        coordinates: f.geometry?.coordinates || null,
        is_access_resource: p.is_access_resource === true || p.is_access_resource === 'true',
      });
    });
    return this;
  }

  /** Run every adapter and rebuild the merged map. */
  async refresh() {
    const rows = [];
    for (const a of this.adapters) {
      try {
        const r = await a.fetchAll();
        r.forEach(x => rows.push({ ...x, _adapter: a }));
      } catch (e) {
        console.warn(`[availability] adapter "${a.id}" failed`, e);
      }
    }
    // Precedence: later adapters override earlier ones per-field. Adapters are
    // registered demo-first, provider-last, so provider edits always win.
    const merged = new Map();
    for (const { facility_id, availability } of rows) {
      if (!facility_id) continue;
      merged.set(facility_id, { ...(merged.get(facility_id) || {}), ...availability });
    }
    this._raw = merged;
    this._providerIds = new Set(Object.keys(this.providerAdapter._read()));
    this._loadedAt = Date.now();
    this._emit();
    return this;
  }

  /* ── Reads ──────────────────────────────────────────────────────────── */

  /** Normalized availability for one facility, or null when we have nothing. */
  get(facilityId) {
    const raw = this._raw.get(facilityId);
    if (!raw) return null;
    return this._normalize(facilityId, raw);
  }

  /** All facilities that currently have an availability record. */
  all() {
    return [...this._raw.keys()].map(id => this.get(id)).filter(Boolean);
  }

  /** Convenience: status key for a facility even if it has no record. */
  statusOf(facilityId) {
    const rec = this.get(facilityId);
    return rec ? rec.status : 'unknown';
  }

  meta(facilityId) { return this._meta.get(facilityId) || null; }
  allMeta() { return [...this._meta.values()]; }

  _normalize(id, raw) {
    let lastUpdated;
    if (raw.last_updated) {
      lastUpdated = new Date(raw.last_updated);
    } else if (Number.isFinite(raw.updated_minutes_ago)) {
      // Anchor demo offsets to first load so "x minutes ago" advances naturally.
      lastUpdated = new Date(this._loadedAt - raw.updated_minutes_ago * 60000);
    } else {
      lastUpdated = null;
    }
    const minutesAgo = lastUpdated ? (Date.now() - lastUpdated.getTime()) / 60000 : null;
    const status = deriveStatus(raw);
    const sourceKey = raw.update_source || 'demo_simulation';
    const source = SOURCES[sourceKey] || SOURCES.demo_simulation;
    // "providerEntered" means it actually came through the provider portal in
    // this browser — not merely that a demo record is tagged update_source:provider.
    const providerEntered = this._providerIds.has(id);

    return {
      facility_id: id,
      hasData: true,
      raw,
      status,
      statusInfo: STATUS[status] || STATUS.unknown,
      lastUpdated,
      minutesAgo,
      freshness: freshnessOf(minutesAgo),
      relativeTime: relativeTime(minutesAgo),
      sourceKey,
      sourceLabel: source.label,
      sourceTrust: source.trust,
      providerEntered,
      // Prototype guarantee: nothing here is a real live feed.
      isDemo: true,
    };
  }

  /* ── Writes (provider portal) ───────────────────────────────────────── */

  async applyProviderUpdate(facilityId, patch) {
    this.providerAdapter.put(facilityId, patch);
    await this.refresh();
    return this.get(facilityId);
  }

  async clearProviderUpdate(facilityId) {
    this.providerAdapter.clear(facilityId);
    await this.refresh();
  }

  async resetProviderUpdates() {
    this.providerAdapter.clear();
    await this.refresh();
  }

  hasProviderUpdate(facilityId) {
    return Object.prototype.hasOwnProperty.call(this.providerAdapter._read(), facilityId);
  }

  /** [{ facility_id, ...availability }] for everything entered via the portal. */
  listProviderUpdates() {
    const store = this.providerAdapter._read();
    return Object.entries(store).map(([facility_id, availability]) => ({ facility_id, ...availability }));
  }

  /* ── Change notification ────────────────────────────────────────────── */
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { this._listeners.forEach(fn => { try { fn(this); } catch (e) { console.error(e); } }); }
}

/* ── Compose the prototype service ──────────────────────────────────────── */
export const Availability = new AvailabilityService();

// Demo first (lowest precedence), provider portal last (highest precedence).
Availability.registerAdapter(new DemoFileAdapter());
// ── FUTURE: register real adapters here, before the provider adapter if their
//    data should be overridable by providers, after it if it should win.
//    e.g. Availability.registerAdapter(new HmisAdapter({ baseUrl, token }));
Availability.registerAdapter({
  id: providerAdapter.id,
  label: providerAdapter.label,
  trustLevel: providerAdapter.trustLevel,
  fetchAll: () => providerAdapter.fetchAll(),
});

export default Availability;
