# ReliefGrid

**AI + geospatial intelligence for social-service accessibility on Long Island.**

ReliefGrid serves two audiences on one shared map and dataset:

| Experience | Who it's for | What it does |
| --- | --- | --- |
| **Find Resources** | People looking for help | Describe your situation in plain words → the **Resource Navigator** turns it into a structured search over ReliefGrid's listings. Category browsing, town lookup, filters, guided questions and saved resources all still work. |
| **Analyze Service Gaps** | Governments, CoCs, nonprofits | Tract-level Community Need, Service Access, Service Gap and LISA clusters (drive / walk), resource network, capacity dashboards, provider updates — plus **Ask ReliefGrid**, a grounded analyst that answers questions from the precomputed research data and highlights the evidence on the map. |

ReliefGrid's own data is the source of truth. AI only **interprets** requests and **explains** results; it never generates shelters, addresses, hours, eligibility, availability, distances, statistics or findings. See [docs/AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md).

---

## 1. What changed in this version

- **Visual redesign.** A dark navy design system (all tokens in `:root` of `style.css`), glass panels floating over a full-bleed map, a restyled dark basemap (Carto Dark Matter re-tinted in `applyBasemapTheme`), new compact category markers with a hover / selected / AI-match halo, dark-appropriate data ramps and legends, bottom sheets on mobile, reduced-motion support.
- **Navigation.** A "Find Resources / Analyze Service Gaps" mode switch; every existing page is kept.
- **AI Resource Navigator** (Find Help page) with editable "Needs identified" chips and an optional grounded summary.
- **Ask ReliefGrid** (new dashboard page) with an evidence table, map highlighting, and an "Ask about this area" hand-off from Service Gaps.
- **Backend** (`api/`, `server/`): a provider-agnostic AI layer with task routing, optional fallback, input limits, rate limiting and grounding checks. It has no npm dependencies.
- **Shared pure core** (`js/core/`): the taxonomy and interpretation helpers are now used by both the browser and the server, so the AI reads exactly what the UI shows.
- **Unchanged:** every data file, schema and research value (need, access, gap, LISA, Moran's I), the availability service and its demo data, and the provider portal. The only data-handling additions are *display* safeguards (for example, ACS "not available" sentinels are shown as missing).
- **Small fixes found while testing:**
  - The Service Gaps map didn't match its default radio button on first visit.
  - Resource filters from Find Help leaked into the dashboard.
  - Framing used a fixed centre, which put Long Island behind the panel.

## 2. Running locally

Requirements: **Node.js 18.17+** (no `npm install` needed; there are no dependencies).

```bash
cp .env.example .env        # then edit .env — see §3 (optional: the app runs without keys)
npm run dev                 # http://localhost:8787
npm run check               # offline tests of the AI grounding rules (no keys, no network)
```

`npm run dev` serves the static site and mounts the same `api/ai/*` handlers used in production. It never serves `.env`, `server/` or `api/` source.

> Opening `index.html` directly from disk won't work (browsers block `fetch` of local files). Any static server works for the non-AI app; the AI features need the Node server or a deployed backend.

## 3. Configuration (environment variables)

| Variable | Required for | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | Resource Navigator | Get one at Google AI Studio. |
| `OPENAI_API_KEY` | Ask ReliefGrid | Get one from the OpenAI platform dashboard. |
| `GEMINI_MODEL` / `OPENAI_MODEL` | — | Defaults `gemini-2.5-flash` / `gpt-5-mini`. |
| `AI_ALLOW_FALLBACK` | — | `true` lets a task retry once on the other provider when the primary is unavailable (same data, same tools). Default off. |
| `GEMINI_MAPS_GROUNDING` | — | `true` enables optional Google Maps travel/area context on resource detail pages. Default off. |
| `AI_ALLOWED_ORIGINS` | split hosting | Comma-separated origins allowed to call the API cross-origin. |
| `AI_RATE_LIMIT_PER_MIN` | — | Per-IP budget (default 20; best-effort, per instance). |

**Setting keys locally:** put them in `.env` (git-ignored). **In production:** set them as environment variables / secrets in your host's dashboard. Never put keys in `index.html`, `js/`, or any committed file. The browser never receives a key; `/api/ai/status` reports only which features are enabled.

## 4. Deploying

**Recommended: Vercel (static site and functions from one repo).**
1. Import the repository in Vercel (framework preset: *Other*; no build command; output directory: root).
2. Add `GEMINI_API_KEY` and `OPENAI_API_KEY` under *Settings → Environment Variables*.
3. Deploy. `vercel.json` bundles the data files the analyst tools read and sets a 60 s function limit.

**Split hosting (for example, keep GitHub Pages for the site).**
1. Deploy this repository to Vercel as above (it serves `/api/ai/*`).
2. In the Pages copy of `index.html`, set `<meta name="reliefgrid-api-base" content="https://your-app.vercel.app">`.
3. On the backend, set `AI_ALLOWED_ORIGINS=https://<you>.github.io`.

Other Node hosts work too: each `api/ai/*.js` file exports a standard `(req, res)` handler, and `server/dev-server.mjs` can run as a plain Node server behind HTTPS.

## 5. What works without AI

Everything except the two AI surfaces:
- Category browsing, the town lookup and "Use my location", quick filters, the guided questions, results list + map, resource detail, and Saved.
- Overview, Resource Network (search, filters, availability badges), Service Gaps (all layers, drive/walk, tract details), Capacity charts, Provider Updates, and Data & Methods.
- The Ask ReliefGrid page still shows the layers, legend and tract details.

With no keys (or no backend), the AI inputs are disabled and a short setup notice is shown. The app never shows simulated AI output.

## 6. Limitations and unfinished work

- **Availability is simulated demo data** (see [AVAILABILITY.md](AVAILABILITY.md)); both AI features label it as such.
- **Location is a prototype town lookup**, not a geocoder. Distances are straight-line estimates.
- **Service Access is one combined score per tract.** For category questions ("where is food least accessible?") the analyst uses straight-line distance to the nearest listing and says so.
- Tracts have no neighbourhood names in the data, so answers refer to GEOIDs and counties.
- **Numeric grounding is a heuristic.** It catches figures that match no tool value and flags them to the user, but it cannot prove every sentence is correct. The evidence table is always rendered from ReliefGrid's own data.
- Rate limiting is per serverless instance. Use your host's WAF / edge rate limits for production.
- **Google Maps grounding** is optional and off by default, and its request shape follows the Gemini API as documented at the time of writing. Verify it against the current docs before relying on it.
- The live providers were tested with **mocked HTTP responses** (`npm run check`, plus browser tests). Run a smoke test with real keys before a demo.
