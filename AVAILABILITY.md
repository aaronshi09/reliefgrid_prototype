# ReliefGrid — Real-Time Resource Availability (Prototype)

This document describes the availability feature underneath ReliefGrid's two
shells: the **Find Help** consumer experience and the **provider / government
dashboard**.

> **Prototype notice.** ReliefGrid has **no live feeds** from shelters, HMIS,
> food pantries, healthcare providers, or coordinated entry today. Every
> availability value in this build is **simulated** and is labelled *Demo
> data* wherever it appears in the product. The code is structured so real
> integrations can replace the simulated source without touching either
> shell's UI.

---

## Where things live

| File | Role |
| --- | --- |
| `services/availability.js` | The availability **service layer**: status vocabulary, freshness logic, adapter interface, merge/precedence, provider-update persistence, change events. This is the only file a backend integration needs to touch. |
| `data/availability_demo.json` | The checked-in **simulated dataset** (~32 Long Island resources). Loaded by `DemoFileAdapter`. |
| `js/shared.js` | Shared substrate for both shells: the one MapLibre map instance, facility/tract data loading, map layers, and the `enrichFacilitiesWithAvailability()` bridge that copies availability onto the map's facility features. |
| `js/seeker.js` | The **Find Help** shell — need-based search, results list + map, resource detail, guided matching, saved resources. Reads availability through `Availability.get()`; never touches `localStorage` directly except for the user's own saved list. |
| `js/gov.js` | The **provider / government dashboard** shell — Overview, Resource Network, Service Gaps, Capacity, and Provider Updates. Provider Updates is where availability is *written*. |
| `main.js` | Bootstraps the map/data/availability service once, then wires the landing page and the router that switches between the two shells. |

---

## Data model

An **availability record** is attached to a resource by `facility_id`
(matching `longisland_facilities.geojson`). All fields are optional:

```jsonc
{
  "total_capacity":     40,          // e.g. shelter beds
  "available_capacity": 7,
  "meals_available":    34,          // food pantry packages / meals
  "next_service_time":  "Today 4:00 PM",
  "wait_minutes":       35,          // healthcare / intake queue
  "walk_ins":           true,
  "accepting_clients":  true,
  "open_now":           true,
  "message":            "Families prioritized",   // short free-text note
  "updated_minutes_ago": 12,         // DEMO ONLY (anchored to page load)
  "last_updated":       "2026-09-20T14:02:00Z",   // real adapters use this
  "update_source":      "provider"   // see SOURCES in availability.js
}
```

### Derived status (`deriveStatus`)

`Available` · `Limited Availability` · `Full` · `Closed` · `Unknown`

Status is always shown with **text + a glyph**, never colour alone. Map
badges use the letters `A / L / F / C`. ReliefGrid deliberately keeps
*"resource exists in the network"* and *"resource is currently reporting
availability"* visually distinct — see the Capacity dashboard.

### Freshness (`freshnessOf`)

`Fresh` < 1 h · `Aging` < 6 h · `Stale` ≥ 6 h. Stale records still display,
with a warning that the information may be out of date, and are counted
separately in the government dashboard.

---

## Adapter architecture

The service merges records from an ordered list of **adapters**
(`Availability.registerAdapter`). Later adapters override earlier ones
field-by-field, so the **provider portal always wins**.

```
DemoFileAdapter  ─┐
(future) HmisAdapter ─┼─▶  AvailabilityService.refresh()  ─▶  merged Map<facility_id, record>
(future) 211Adapter  ─┤            │
ProviderPortalAdapter ┘            └─▶ normalize() ─▶ status, freshness, source, relative time
```

To add a real source, implement one adapter and register it — no changes to
`js/seeker.js` or `js/gov.js` are needed:

```js
class HmisAdapter {
  id = 'hmis-clarity';
  label = 'HMIS bed inventory';
  trustLevel = 'verified';
  async fetchAll() {
    const res = await fetch('https://api.example.org/bed-inventory', { headers: { Authorization: `Bearer ${TOKEN}` } });
    const rows = await res.json();
    return rows.map(r => ({
      facility_id: mapToReliefGridId(r.projectId),
      availability: {
        total_capacity: r.bedCount,
        available_capacity: r.availableBeds,
        accepting_clients: r.acceptingReferrals,
        last_updated: r.asOf,        // ISO 8601
        update_source: 'hmis',
      },
    }));
  }
}

// in services/availability.js, before the provider adapter:
Availability.registerAdapter(new HmisAdapter());
```

Candidate integrations already stubbed in comments: **provider portal API**,
**HMIS**, **Bitfocus / Clarity**, **211 / iCarol**, **findhelp**, **Unite
Us**, **Open Referral HSDS** (`service_capacity`), **government open data**.

### Provider portal persistence

Today: `localStorage` key `atlas.availability.providerUpdates.v1`
(`ProviderPortalAdapter._read` / `_write` in `services/availability.js`).

Production: replace those two method bodies with authenticated
`GET/POST /api/availability`. Nothing else in the app changes — `js/gov.js`'s
Provider Updates page calls `Availability.applyProviderUpdate()`, which is
unaware of where the data ends up.

---

## How an update reaches both audiences

1. A provider submits the form on **Provider Updates**
   (`js/gov.js → onProviderSubmit`).
2. `Availability.applyProviderUpdate()` writes it, then calls `refresh()` and
   fires a change event.
3. `main.js` is subscribed once at bootstrap: it re-enriches the shared
   facility GeoJSON and pushes the update to the MapLibre `facilities`
   source — the *same* map both shells read from.
4. `js/gov.js` and `js/seeker.js` each subscribe separately and re-render
   whatever they currently have open (a resource card, a detail page, the
   Capacity charts) — so a judge can update a shelter's beds on the
   dashboard, switch to **Find Help**, and see it change with no reload.

---

## Safety

- Simulated data is never presented as real: persistent *Demo data* markers,
  a banner on the relevant pages, and a Data & Methods entry.
- Only **aggregate, resource-level** availability. No client/PII, no fake
  personal records. Saved resources live only in the visitor's own browser.
