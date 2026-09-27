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
- **AI Resource Navigator** (Find Help page), powered by Gemini through the official `@google/genai` SDK: it interprets a request into ReliefGrid's existing categories and filters, shows editable "Needs identified" chips, and can suggest first calls. Suggestions are chosen only from ReliefGrid's own results, with reasons verified against the data.
- **Ask ReliefGrid** (dashboard page), powered by OpenAI through the official `openai` SDK: ReliefGrid classifies each question, retrieves only the relevant stored metrics and documented methodology, and the model explains them in a short brief. Referenced tracts are highlighted on the existing layers, with an evidence table, "Analysis based on" provenance, and an "Ask about this area" hand-off from Service Gaps.
- **Backend** (`api/`, `server/`): a provider-agnostic AI layer with task routing, optional fallback, input limits, rate limiting and grounding checks. Gemini calls use `@google/genai` and OpenAI calls use `openai` — the only two dependencies.
- **Shared pure core** (`js/core/`): the taxonomy and interpretation helpers are now used by both the browser and the server, so the AI reads exactly what the UI shows.
- **Unchanged:** every data file, schema and research value (need, access, gap, LISA, Moran's I), the availability service and its demo data, and the provider portal. The only data-handling additions are *display* safeguards (for example, ACS "not available" sentinels are shown as missing).
- **Small fixes found while testing:**
  - The Service Gaps map didn't match its default radio button on first visit.
  - Resource filters from Find Help leaked into the dashboard.
  - Framing used a fixed centre, which put Long Island behind the panel.

## 2. Running locally

Requirements: **Node.js 22+**. Dependencies: Google's official Gen AI SDK (`@google/genai`) and OpenAI's official SDK (`openai`).

```bash
npm install                 # installs @google/genai and openai
cp .env.example .env        # then add GEMINI_API_KEY — see §3 (the app also runs without keys)
npm run dev                 # http://localhost:8787
npm run check               # offline tests of the AI grounding rules (no keys, no network)
```

`npm run dev` serves the static site and mounts the same `api/ai/*` handlers used in production. It never serves `.env`, `server/` or `api/` source.

> Opening `index.html` directly from disk won't work (browsers block `fetch` of local files). Any static server works for the non-AI app; the AI features need the Node server or a deployed backend.

### Testing the Resource Navigator API locally

With `GEMINI_API_KEY` in `.env` and `npm run dev` running:

```bash
# 1. Is the navigator enabled? (never returns the key)
curl http://localhost:8787/api/ai/status
#  → {"ok":true,"features":{"navigator":true,...},"setup":{"missing":[...]}}

# 2. Interpret a request (structured needs only — no resources)
curl -X POST http://localhost:8787/api/ai/interpret \
  -H "Content-Type: application/json" \
  -d '{"text":"I need somewhere to sleep tonight and I don'\''t have a car"}'
#  → {"ok":true,"needs":{"requestType":"service_request","categories":["shelter"],
#      "urgency":"immediate","transportation":"no_car",...},"meta":{...}}

# 3. Off-topic input is recognised, never searched
curl -X POST http://localhost:8787/api/ai/interpret -H "Content-Type: application/json" \
  -d '{"text":"Write me an essay about George Washington."}'
#  → "requestType":"unrelated","categories":[]
```

Then open http://localhost:8787 → **Find Resources** and try the examples in the input box. Failures are returned as a short code (`not_configured`, `rate_limited`, `unavailable`, `timeout`, `bad_output`, `blocked`); the server log shows the provider status, never the request text.

### Testing Ask ReliefGrid (analytics API) locally

With `OPENAI_API_KEY` in `.env` and `npm run dev` running:

```bash
curl http://localhost:8787/api/ai/status            # → "analyst":true

curl -X POST http://localhost:8787/api/ai/analyze -H "Content-Type: application/json" \
  -d '{"question":"Where are the largest service gaps?","context":{"mode":"drive","layer":"lisa"}}'
#  → {"ok":true,"scope":"answered","answer":"…","areas":[…],"mapFocus":{"tractIds":[…],"layer":"mismatch_index",…},
#     "metricsUsed":["Drive catchments","Service Gap",…],"limitations":[…],"grounding":{"unverifiedFigures":[]}}

# selected-area context (what the map sends when a tract is clicked)
curl -X POST http://localhost:8787/api/ai/analyze -H "Content-Type: application/json" \
  -d '{"question":"Explain this area.","context":{"mode":"drive","selectedTract":"36103190605"}}'

# off-topic → fixed scope message, no OpenAI call
curl -X POST http://localhost:8787/api/ai/analyze -H "Content-Type: application/json" \
  -d '{"question":"Write me an essay about World War II."}'
```

In the browser: **Analyze Service Gaps → Ask ReliefGrid**, try the suggested questions, click a tract and ask "Explain this area."

## 3. Configuration (environment variables)

| Variable | Required for | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | Resource Navigator | Get one at Google AI Studio. |
| `OPENAI_API_KEY` | Ask ReliefGrid | Get one from the OpenAI platform dashboard. |
| `GEMINI_MODEL` / `OPENAI_MODEL` | — | Defaults `gemini-3.5-flash-lite` / `gpt-6-luna` (set only in `server/ai/config.js`). |
| `OPENAI_REASONING_EFFORT` | — | `none`/`low`/`medium`/`high`; default `low`. |
| `GEMINI_THINKING_LEVEL` | — | Optional `minimal`/`low`/`medium`/`high`; unset uses the model default. |
| `AI_ALLOW_FALLBACK` | — | `true` lets a task retry once on the other provider when the primary is unavailable (same data, same tools). Default off. |
| `GEMINI_MAPS_GROUNDING` | — | `true` enables optional Google Maps travel/area context on resource detail pages. Default off. |
| `AI_ALLOWED_ORIGINS` | split hosting | Comma-separated origins allowed to call the API cross-origin. |
| `AI_RATE_LIMIT_PER_MIN` | — | Per-IP budget (default 40; best-effort, per instance). |
| `OPENROUTESERVICE_API_KEY` | walk/drive travel times, route lines, landmark search | Free key at openrouteservice.org; server-side only. Towns, ZIPs and addresses work without it. |

**Setting keys locally:** put them in `.env` (git-ignored). **In production:** set them as environment variables / secrets in your host's dashboard. Never put keys in `index.html`, `js/`, or any committed file. The browser never receives a key; `/api/ai/status` reports only which features are enabled.

## 4. Deploying

**Recommended: Vercel (static site and functions from one repo).**
1. Import the repository in Vercel (framework preset: *Other*; no build command; output directory: root). Vercel installs `@google/genai` and `openai` from `package.json` automatically; set the project's Node.js version to **22.x or newer** (Settings → Build and Deployment).
2. Add `GEMINI_API_KEY` (and `OPENAI_API_KEY` for Ask ReliefGrid) under *Settings → Environment Variables*, for the Production environment.
3. Deploy (environment-variable changes only apply to deployments made **after** the change — redeploy if the key was added later). `vercel.json` bundles the data files the analyst tools read and sets a 60 s function limit.

**Verifying a production deployment**
1. `curl https://<your-app>.vercel.app/api/ai/status` → `"navigator":true`. If it is `false`, the key isn't visible to the deployment: check the variable's environment scope and redeploy.
2. `curl -X POST https://<your-app>.vercel.app/api/ai/interpret -H "Content-Type: application/json" -d '{"text":"I need food"}'` → `"categories":["food"]`. An error code such as `unavailable` means the call reached Gemini but failed — open *Vercel → Deployments → Functions/Logs*: the log line names the provider status (for example `404 (check GEMINI_MODEL)` or `401/403` for an invalid key) without any user text.
3. In the browser, run the example requests on **Find Resources** and confirm the "Needs identified" chips, the map update, and that every card is a normal ReliefGrid listing.
4. **Ask ReliefGrid:** `curl https://<your-app>.vercel.app/api/ai/status` → `"analyst":true`; then POST `{"question":"Where are the largest service gaps?"}` to `/api/ai/analyze` → `"scope":"answered"` with `areas`, `metricsUsed` and an empty `grounding.unverifiedFigures`. In the browser, open Analyze Service Gaps → Ask ReliefGrid, run the suggested questions, click a tract and ask "Explain this area." Errors appear in the function logs as `openai <ErrorClass> <status>` (e.g. `404 (check OPENAI_MODEL)`, `401` for a bad key) — never with the question text.
5. Confirm keys are not exposed: view the page source and the network responses for `/api/ai/*` — neither key ever appears (each is only sent server-to-provider in a request header).

**Split hosting (for example, keep GitHub Pages for the site).**
The GitHub Pages copy at `aaronshi09.github.io/reliefgrid_prototype` is already wired this way: `js/ai/config.js` points that host at `https://reliefgrid-prototype.vercel.app`, and the server allows that origin by default (`DEFAULT_ALLOWED_ORIGINS` in `server/ai/config.js`). If the AI panel ever says no backend was found, open *For developers* — it names the URL checked and why it failed (404 = static-only host, 401 = Vercel Deployment Protection, 403 = origin not allowed).
1. Deploy this repository to Vercel as above (it serves `/api/ai/*`).
2. In the Pages copy of `index.html`, set `<meta name="reliefgrid-api-base" content="https://your-app.vercel.app">`.
3. On the backend, set `AI_ALLOWED_ORIGINS=https://<you>.github.io`.

Other Node hosts work too: each `api/ai/*.js` file exports a standard `(req, res)` handler, and `server/dev-server.mjs` can run as a plain Node server behind HTTPS.

## Location-aware Find Help

People can ask "I need food near me", "somewhere to stay — I don't have a car", "legal help near 11550" or "healthcare within walking distance". The roles stay separate:

| Layer | Responsibility |
| --- | --- |
| Gemini | Understands the request, including location intent ("near me", a named town/ZIP) and transport intent (no car, walking, can drive, stated limits like "within 5 miles"). It never computes distances or travel times. |
| ReliefGrid | The only source of resources: category and availability filters over `longisland_facilities.geojson`, then ranking. |
| Location services | Resolve the search origin and compute walk/drive times **to ReliefGrid facilities only** (see below). |
| MapLibre | Displays everything: results, the search origin, and an optional route line. |

**Why not Google Maps Platform?** Google's terms prohibit using Geocoding and Routes content "with or near a non-Google map" (Terms of Service §3.2.3(e); Service Specific Terms, Geocoding §6.2, Routes §19.2), and ReliefGrid's map is MapLibre. The feature therefore uses providers whose data may be shown on any map. The existing "Get Directions" buttons still open Google Maps through plain links, which need no API key.

**How a location is resolved**
1. **ZIP code or Long Island town/village/hamlet:** looked up in the browser from `data/li_places.json`, built by `scripts/build-li-places.mjs` from public-domain U.S. Census 2025 Gazetteer files and filtered to ReliefGrid's own Nassau/Suffolk tracts. Nothing is sent anywhere.
2. **Street address:** `POST /api/geo/geocode` → U.S. Census Geocoder (public, no key). The result must fall inside a Nassau/Suffolk tract.
3. **Landmark:** falls back to openrouteservice search (OpenStreetMap), if configured.
4. **"Use my location":** the browser's own geolocation, requested **only** when that button is pressed, rounded to about 100 m and kept in memory.

**Travel times** (`POST /api/geo/travel-times`, openrouteservice Matrix): these run only once a location and a travel mode are set.
- The mode comes from what the person said (no car / walking → walk; can drive → drive), or from the Distance / Walk / Drive switch in the results panel.
- The pipeline is: ReliefGrid category filter → straight-line prefilter (within 8 km for walking, 60 km for driving) → the **25 nearest** candidates → **one** Matrix request → rank by travel time, then apply any stated or default limit (30-minute walk; 15-minute drive for "not too far").
- If nothing is within the limit, every match is still shown, routed ones first, and the panel says so.
- Cards show route time ("12 min walk · 0.8 mi route") separately from straight-line distance ("0.6 mi straight-line").
- Transit isn't calculated and is never implied; no-car requests use walking times with a note.
- **Route line** (`POST /api/geo/route`): drawn on MapLibre only when the person presses a card's route button.

**Calls per search**
- Plain "I need food": no location calls at all.
- Town or ZIP: 0 location calls.
- Address: 1 Census call (free).
- With a travel mode: 1 Matrix call (≤ 25 destinations).
- Each "show route" press: 1 Directions call.

Map panning or zooming never triggers requests, repeats are de-duplicated for 10 minutes in server memory, and the per-IP rate limit applies.

**Setup (manual):**
1. Create a free openrouteservice account and API key at https://openrouteservice.org/dev/#/signup.
2. Add it to Vercel as `OPENROUTESERVICE_API_KEY` (Production), then redeploy.
3. Keep this key server-side only; it's never sent to the browser.
4. Review openrouteservice's current terms and plan limits when you sign up; their pages render in the browser, so I couldn't quote them here.
5. Show attribution. ReliefGrid already displays "openrouteservice · © OpenStreetMap contributors" wherever travel times or routes appear.

Without the key, towns, ZIPs, addresses, "Use my location" and straight-line ranking all still work; the Walk/Drive options are simply hidden.

**Test locally:** add the key to `.env`, run `npm run dev`, open Find Resources, and try "I need food near Manhasset", "I can drive and need legal help near Brentwood" or "I need somewhere to stay and I don't have a car". Then press a card's route button.

**Test production:**
1. `GET /api/ai/status` → `"location":{"travelTimes":true,…}`.
2. `POST /api/geo/travel-times` with `{"origin":[-73.69,40.79],"mode":"walk","facilityIds":["<an id from the dataset>"]}` → `durationSec` values.
3. Try the searches above on the live site.

## 5. What works without AI

Everything except the two AI surfaces:
- Category browsing, the town lookup and "Use my location", quick filters, the guided questions, results list + map, resource detail, and Saved.
- Overview, Resource Network (search, filters, availability badges), Service Gaps (all layers, drive/walk, tract details), Capacity charts, Provider Updates, and Data & Methods.
- The Ask ReliefGrid page still shows the layers, legend and tract details.

With no keys (or no backend), the AI inputs are disabled and a short setup notice is shown. The app never shows simulated AI output.

## 6. Limitations and unfinished work

- **Availability is simulated demo data** (see [AVAILABILITY.md](AVAILABILITY.md)); both AI features label it as such.
- **Location:** towns and ZIPs come from bundled Census data (area centres, not addresses), and addresses from the Census Geocoder. Travel times are openrouteservice estimates without live traffic; transit isn't calculated.
- **Service Access is one combined score per tract.** For category questions ("where is food least accessible?") the analyst uses straight-line distance to the nearest listing and says so.
- Tracts have no neighbourhood names in the data, so answers refer to GEOIDs and counties.
- **Numeric grounding is a heuristic.** Every figure in an Ask ReliefGrid brief is compared with the numbers ReliefGrid supplied for that request, and anything unmatched is flagged to the user. It cannot prove every sentence is correct, so the evidence table is always rendered from ReliefGrid's own data rather than from the model's text.
- **Question routing is rules-first.** Unusual wording falls back to a small OpenAI classification call. A question the rules misread may retrieve less relevant data — the "Analysis based on" line shows what was used.
- **"Nearby tracts" means the six nearest by centroid distance**, as a descriptive comparison. It is not the LISA queen-contiguity neighbour set, which isn't stored.
- Rate limiting is per serverless instance. Use your host's WAF / edge rate limits for production.
- **Google Maps grounding** is optional and off by default, and its request shape follows the Gemini API as documented at the time of writing. Verify it against the current docs before relying on it.
- **Tested without a live key.** The live providers were tested with **mocked responses** that follow the SDK's request and response formats (`npm run check`, plus browser tests of every example request). Run the checks in "Verifying a production deployment" once against the real key.
