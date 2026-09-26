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
   1. interpret → structured needs         model calls ReliefGrid data tools
      (existing categories only)           (precomputed tract / LISA / resources)
   2. ReliefGrid search in the browser      answer validated against tool output
      (computeResults, same rules as        (ids filtered, figures checked)
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
| Gemini adapter (official `@google/genai` SDK) and OpenAI adapter (REST), same interface | `server/ai/providers/gemini.js`, `openai.js` |
| Navigator workflows: interpret, explain, location context | `server/ai/workflows/navigator.js` |
| Analyst workflow: tool loop and validation | `server/ai/workflows/analyst.js` |
| Deterministic data tools the analyst can call | `server/data/analyst-tools.js` |
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

`POST /api/ai/analyze` runs a function-calling loop (at most 6 tool rounds, 60 s budget). The model can reach data only through these tools, which read the files the browser loads:

| Tool | Returns |
| --- | --- |
| `get_study_overview` | Tract/resource counts, LISA cluster counts, global Moran's I, robustness, metric definitions |
| `rank_tracts` | Tracts ranked by an existing metric, filterable by county / cluster |
| `get_tract` | One tract, drive and walk values, ReliefGrid's own plain-language reading, 3 nearest listings |
| `summarize_by_county` | Descriptive Nassau vs Suffolk comparison of existing values (labelled as such) |
| `resource_inventory` | Listing counts by category / county |
| `category_proximity` | Straight-line distance to the nearest listing of a category (explicitly *not* the access score) |
| `compare_travel_modes` | Drive vs walk cluster membership |

The model returns strict JSON (`answer`, `keyFindings`, `mapFocus`, `limitations`, `followUps`). Before anything reaches the browser:
- tract and facility ids are kept only if a tool returned them in this request and they exist in the data;
- GEOIDs mentioned in prose that no tool returned are flagged;
- every figure in the prose is compared with the numbers in tool output (allowing rounding and percentages), and unmatched figures are shown to the user as unverified;
- an answer that consulted no data is rejected.

The browser then highlights the referenced tracts (an illuminated outline layer), switches to the suggested existing layer or mode, and renders an evidence table whose values come from its own copy of the data, not from the model's text.

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
