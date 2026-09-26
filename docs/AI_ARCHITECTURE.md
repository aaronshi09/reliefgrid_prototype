# ReliefGrid AI architecture

ReliefGrid is not a chatbot on top of a map. The language models sit **between** the user and ReliefGrid's own data: they translate natural language into queries ReliefGrid can run, and they explain results ReliefGrid computed. The data and calculations stay authoritative.

```
                            RELIEFGRID AI
                                 |
                  user request (surface decides the task)
                    /                                  \
       Resource Navigator                         Ask ReliefGrid
     (Find Resources page)                  (Analyze Service Gaps page)
     primary: Gemini                            primary: OpenAI
            |                                           |
   1. interpret → structured needs         classify question (rules first)
      (existing categories only)           retrieve ONLY relevant stored data
   2. ReliefGrid search in the browser      one structured explanation call
      (computeResults, same rules as        validate ids + figures vs context
       the guided flow)                             |
   3. optional: rank returned ids with      UI renders evidence from its own data
      verified reason codes (no AI text)
            \                                      /
                    RELIEFGRID RESPONSE + MAP SYNC
```

One provider serves each request, and requests are never sent to both. The UI doesn't name the model.

## Where each piece lives

| Concern | File |
| --- | --- |
| Provider, model, routing, fallback, limits (all AI config) | `server/ai/config.js` |
| Task router (one provider per request, opt-in fallback) | `server/ai/router.js` |
| Gemini adapter (official `@google/genai` SDK) and OpenAI adapter (official `openai` SDK, Responses API), same interface | `server/ai/providers/gemini.js`, `openai.js` |
| Navigator workflows: interpret, explain, location context | `server/ai/workflows/navigator.js` |
| Analyst workflow: classify → retrieve → explain → validate | `server/ai/workflows/analyst.js` |
| Question classification (rules first, model only if undecided) | `server/analytics/classify.js` |
| Deterministic context retrieval | `server/analytics/retrieve.js` |
| Methodology text parsed from the Data & Methods page | `server/analytics/methodology.js` |
| Stored-data query functions used by retrieval | `server/data/analyst-tools.js` |
| Redaction, numeric / GEOID grounding checks | `server/ai/validate.js` |
| HTTP wrapper (origin check, size limit, rate limit, safe errors) | `server/http.js` |
| Endpoints | `api/ai/{status,interpret,explain,analyze,location-context}.js` |
| Browser config and client (timeouts, redaction, error copy) | `js/ai/config.js`, `js/ai/client.js` |
| Navigator UI | `js/ai/navigator.js` (drives `js/seeker.js` via its public API) |
| Analyst UI + map sync | `js/ai/analyst.js` (uses `js/gov.js` renderers and layers) |
| Shared taxonomy / interpretation code (browser and server) | `js/core/taxonomy.js`, `js/core/analysis.js` |

## Resource Navigator (Gemini)

**Model:** `gemini-3.5-flash-lite` by default, set in one place (`server/ai/config.js`, overridable with `GEMINI_MODEL`). It is Google's fastest, lowest-cost current Gemini model, and it supports strict JSON-schema output. That fits short, latency-sensitive interpretation calls; the larger Flash/Pro models add cost and latency without benefit here. (`gemini-2.5-flash` is deprecated with limited access.)

**SDK:** the official `@google/genai` SDK, via the Interactions API (`client.interactions.create`) with a JSON-schema `response_format`. Requests are sent with `store: false`, so Google does not keep them for later retrieval. ReliefGrid enforces its own hard deadline on every call and disables SDK retries.

1. **Interpret** (`POST /api/ai/interpret`). The request text (≤ 600 characters, with phone numbers, emails and ID-like numbers stripped in the browser *and* on the server) goes to Gemini with this schema, designed from the dataset and the existing Find Help logic:

   | Field | Values | Maps onto (existing ReliefGrid logic) |
   | --- | --- | --- |
   | `requestType` | `service_request` / `unclear` / `unrelated` | Only `service_request` triggers a search; the other two get a clarifying question or a scope message plus category buttons |
   | `categories` | the 8 Find Help ids: `shelter`, `food`, `health`, `behavioral_health`, `legal`, `housing_support`, `outreach`, `other` | `SEEKER_CATEGORIES` → `resource_group` values in `longisland_facilities.geojson` (`other` = `public_benefits` + `other`) |
   | `urgency` | `immediate` / `soon` / `planning` / `unspecified` | `immediate` → the existing **Open now** filter |
   | `transportation` | `no_car` / `walking` / `public_transit` / `driving` / `unspecified` | The guided flow's radii (walking 2.5 km, no car / transit 12 km, driving 24 km), applied only when a location is known |
   | `walkInsNeeded` | boolean | The **Walk-ins** filter, only for healthcare, mental health and legal (the only data that models walk-ins) |
   | `locationText` | town name or `""` | The existing prototype town lookup (`lookupTown`); street addresses are rejected |
   | `householdContext` | `children`, `family`, `older_adult`, `disability`, `veteran`, `youth`, `pets` | Shown as info chips only. The data has **no eligibility fields**, so these never filter results |
   | `unmatchedNeeds` | short labels | Shown as "ReliefGrid doesn't have a category for …" |
   | `clarifyingQuestion` | text or `""` | Shown only for `unclear` requests |
   | `safetyConcern` | boolean | Shows the 911 / 988 notice |

   The server re-validates every field against these lists. Unknown values and extra fields are discarded, and model-written text (the clarifying question, unmatched needs) is dropped if it contains digits, links or addresses. That way Gemini can't smuggle in a resource name, phone number or address.
2. **Retrieve** (browser). `applySeekerPlan()` in `js/seeker.js` applies the needs through the same rules as the rule-based guided flow, including its relaxation safety net: when nothing matches, it loosens walk-ins, then distance, then open now, and tells the user it did. The quick-filter buttons reflect the result. Results come from `computeResults()` over the dataset; nothing else can add a resource. Matching markers are the existing `facilities` layer, filtered to the results. Selecting a result, or a suggested first call, sets the existing marker's `selected` state and flies to it. If nothing matches, the panel says so and offers to remove filters, drop the location, or start a new search. It never asks the model for alternatives.
3. **Suggest first calls** (`POST /api/ai/explain`, optional). The browser sends only the top result **ids**, plus the availability status, open-now, walk-ins and distance it already displays. The server looks up all other facts. Gemini returns only `{ facilityId, reasons[] }`, where reasons come from a fixed list (`matches_need`, `closest`, `listed_available`, `listed_open`, `walk_ins`, `mentions_families`). The server drops ids ReliefGrid didn't return and reason codes the data doesn't support, and the browser re-checks the ids. **Gemini writes no text about resources:** every displayed word comes from ReliefGrid templates and data.
4. **Location context** (`POST /api/ai/location-context`, off by default). This uses Gemini's Google Maps grounding for one listing, based on the listing's coordinates, never the user's. It is rendered as *External · Google Maps*, separate from ReliefGrid's listing, with its sources.

## Ask ReliefGrid (OpenAI)

**Model:** `gpt-6-luna` with `reasoning.effort: "low"`, set in one place (`server/ai/config.js`; override with `OPENAI_MODEL` / `OPENAI_REASONING_EFFORT`). ReliefGrid retrieves the data deterministically, so the model's job is only to interpret the supplied values. OpenAI's efficient tier supports that with Structured Outputs at a fraction of the cost and latency of `gpt-6-sol` or `gpt-6-astra`.

**SDK:** the official `openai` Node SDK, via the Responses API (`client.responses.create`). Every call uses a strict `json_schema` output, `store: false`, SDK retries disabled, and a hard deadline that ReliefGrid owns.

`POST /api/ai/analyze` runs a deterministic pipeline (`server/ai/workflows/analyst.js`):

1. **Sanitize.** At most 500 characters, control characters removed, personal identifiers redacted. Census tract GEOIDs are kept, since they are public geography.
2. **Classify** (`server/analytics/classify.js`). Pattern families assign one or more domains: `service_gap`, `need_access`, `community_need`, `service_access`, `category_access`, `lisa`, `mode_comparison`, `resources`, `methodology`, `map_explanation`, `selected_area`, `investigation` or `overview`. They also extract parameters: travel mode, county, service category, cluster type, typed GEOID, "this area", siting intent, a named layer, and whether it's a definition-only question. Short follow-ups ("what about walking?") reuse the previous turn's domains.
   - If the rules can't decide, one small structured call (`analyst.classify`, reasoning `none`) chooses from the same fixed list. It sees only the question text, never data.
   - **These replies make no model call:** off-topic questions get a fixed scope message; "this area" with nothing selected asks the user to click a tract; an unknown GEOID says ReliefGrid has no such tract.
3. **Retrieve** (`server/analytics/retrieve.js`). Only the blocks each domain needs are built from the stored files, typically 1–10 KB rather than the ~2.7 MB tract files.

   | Domain | Context sent |
   | --- | --- |
   | `service_gap` | Top 10 tracts by stored `mismatch_index` (optionally one county) |
   | `need_access` | Tracts in the stored HH cluster (ReliefGrid's definition of high need / low access), ranked by need, with ACS context |
   | `community_need` / `service_access` | Top / bottom 10 by the stored value |
   | `category_access` | Straight-line distance from HH-cluster tracts to the nearest listing of that category, plus the listing inventory |
   | `lisa` | Stored cluster counts (both variables) and by county, Moran's I, the need–access bivariate result, example HH / LL tracts, all HL / LH tracts |
   | `mode_comparison` | Drive vs walk cluster counts, overlap, median access, and the selected tract's values in both modes |
   | `selected_area` | The tract's stored values (both modes), ReliefGrid's own plain-language reading, ACS fields, the six nearest tracts by centroid, and regional medians |
   | `resources` | The nearest listings to the selected tract (straight-line), or inventory counts |
   | `map_explanation` | The named or current layer: stored-value distribution plus highest / lowest tracts (or the cluster summary) |
   | `methodology` | The Data & Methods text parsed from `index.html` at runtime, plus the LISA settings from `diagnostics_*.json` |
   | `investigation` | Need / access clusters, plus category proximity if a service is named |

4. **Explain.** One structured call returns `status` (`answered` / `insufficient_data`), `answer`, `keyFindings[{text, tractIds, facilityIds}]`, `referencedTractIds`, `referencedFacilityIds`, `suggestedLayer`, `limitations` and `followUps`. The system prompt forbids values that aren't in the context, restricts methodology to the documented text, and requires decision-support wording ("may warrant further investigation").
5. **Validate.**
   - Ids are kept only if they appear in the retrieved context.
   - Every figure in the prose is compared with the context numbers, allowing for rounding and percentages; unmatched figures are shown as unverified.
   - Tract ids in the prose that aren't in the context are flagged.
   - Directive siting language ("the county should build…") is flagged, and siting questions always get a fixed limitation about zoning, funding, land, capacity, community input, legal requirements and feasibility.
   - A layer the user names always wins over the model's suggestion.

**Response to the browser:**

```jsonc
{
  "ok": true,
  "scope": "answered" | "insufficient_data" | "out_of_scope" | "needs_selection",
  "answer": "…",
  "keyFindings": [{ "text": "…", "tractIds": ["36103190605"], "facilityIds": [] }],
  "areas": [{ "geoid": "36103190605", "county": "Suffolk", "role": "selected" | "referenced" }],
  "mapFocus": { "tractIds": [], "facilityIds": [], "layer": "mismatch_index", "mode": "drive" },
  "metricsUsed": ["Drive catchments", "Service Gap", "Community Need", "Service Access (E2SFCA)"],
  "domains": ["service_gap"],
  "limitations": ["…"],
  "followUps": ["…"],
  "grounding": { "unverifiedFigures": [], "directiveLanguage": false },
  "meta": { "task": "analyst.answer", "classifiedBy": "rules" | "model", "provider": "openai", "fallbackUsed": false }
}
```

**Map sync** (`js/ai/analyst.js`, reusing existing layers only):
- `mapFocus.layer` switches the existing research layer (radio + `setMapLayer`), and `mapFocus.mode` switches drive / walk if the question named one.
- `tractIds` feed the existing `tract-ai-*` outline layers (a filter on the existing `tracts` source; no new polygons), and the map fits to them.
- Referenced facilities are emphasised on the existing `facilities` layer, and only those are shown unless the user has turned all resources on.
- Clicking an evidence row or tract chip selects that tract with the existing selected-outline layer and opens its existing metric panel.
- "Analysis based on" lists `metricsUsed`, which comes from the retrieval step, not from the model.

## Fallback

`AI_ALLOW_FALLBACK=true` lets a task retry once on the other provider after a *retryable* failure (unavailable, timeout, rate limit, missing key). Only tasks marked `fallbackSafe` do this. These tasks hand the model the same ReliefGrid data or tools, so capabilities don't silently change. Maps grounding is Gemini-only and never falls back. With fallback off (the default), the user sees a graceful error and every non-AI feature keeps working.

## Privacy and safety

- API keys live only in server environment variables; the browser never sees them.
- Request text is not stored or logged; server logs contain error codes and provider HTTP status only.
- Identifiers are redacted before any provider call, and the UI asks people not to share personal details.
- The navigator does not ask for identifying information. It shows a 911 / 988 notice and states that ReliefGrid cannot contact emergency services.
- Upstream error bodies are never forwarded; the browser receives a short error code and shows plain-language copy. Every request has a hard client timeout.

## Swapping or adding a provider

Implement `generateJSON()` and `runTools()` (see either adapter), register it in `PROVIDERS` in `router.js`, and point a task at it in `config.js`. No frontend changes are needed.
