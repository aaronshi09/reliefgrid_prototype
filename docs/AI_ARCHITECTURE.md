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
   3. optional: explain returned ids        UI renders evidence from its own data
            \                                      /
                    RELIEFGRID RESPONSE + MAP SYNC
```

One provider serves each request, and requests are never sent to both. The UI doesn't name the model.

## Where each piece lives

| Concern | File |
| --- | --- |
| Provider, model, routing, fallback, limits (all AI config) | `server/ai/config.js` |
| Task router (one provider per request, opt-in fallback) | `server/ai/router.js` |
| Gemini / OpenAI adapters (plain `fetch`, same interface) | `server/ai/providers/gemini.js`, `openai.js` |
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

1. **Interpret** (`POST /api/ai/interpret`). The request text (≤ 600 characters, with phone numbers, emails and ID-like numbers stripped in the browser *and* on the server) goes to Gemini with a strict JSON schema. The allowed categories are the eight existing Find Help categories from `js/core/taxonomy.js`. The server re-validates every field: unknown categories are dropped, and a street address is never accepted as a location.
2. **Retrieve** (browser). `applySeekerPlan()` in `js/seeker.js` maps needs onto the *existing* filters, using the same rules as the rule-based guided flow:
   - "needed now" → *Open now*
   - walking / no car → the guided flow's travel radii
   - walk-ins → only for categories whose data models it
   - the same relaxation safety net when nothing matches

   Results come from `computeResults()` over `longisland_facilities.geojson`. Needs with no matching category ("childcare") and household details are shown honestly, not used to invent matches.
3. **Explain** (`POST /api/ai/explain`, optional). The browser sends only the **ids** of the top results, plus their already-displayed availability status and distance. The server looks up every other fact in the dataset. The model may reference only those ids; anything else is removed, and a summary containing contact details or links is rejected.
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
