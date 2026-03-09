# Jules Handoff: University Crawler

## Purpose
This app checks whether multiple target websites are consistent with a single canonical admissions source.

Core workflow:
1. Crawl canonical and target pages.
2. Extract snippets.
3. Resolve canonical candidates for each watched field.
4. Adjudicate each `(watched field, target URL)` pair with deterministic checks first, then selective Ollama semantic checks.
5. Return contract-compliant findings and UI-facing diagnostics.

## Read First
1. `CANON_API.md` (integration contract and prompting pattern)
2. `server/index.js` (`/api/scan` pipeline and matching logic)
3. `src/App.tsx` (scan UX, progress, and result presentation)

## Canonical API Contract
Canonical base URL is a single input (example: `http://localhost:4000/api/admissions`).
From that base, backend calls:
1. `/api/admissions/claims?format=jsonl` (primary semantic source)
2. `/api/admissions/flat` (deterministic fallback)
3. `/api/admissions` (snapshot fallback)

Expected per-fact output contract:
```json
{
  "fact": "string",
  "canonical_ref": "claim_id or kv_index key",
  "status": "match|fuzzy_match|no_match",
  "confidence": 0.0,
  "reason": "short explanation"
}
```

## Current Matching Design
### Candidate selection
- `getCanonicalCandidates(...)` ranks claims + flat refs.
- Field-aware weighting prioritizes canonical label alignment over raw value similarity.
- Role-sensitive penalties/boosts reduce title drift (`Chancellor` vs `Vice Chancellor`).

### Deterministic adjudication
- Field kind classification: `name | email | amount | date | policy | text`.
- Names: exact-name fast path + role mention weighting.
- Amounts: currency/context-aware extraction; suppress contact-only numeric snippets.
- Policies: normalized intent scoring (`require`, `hardcopy`, `document`, `submit`, `mail`) with contradiction handling.

### Semantic adjudication (Ollama)
- Only used for uncertain pairs.
- Guardrails:
  - max call budget (`SEMANTIC_MAX_CALLS`)
  - skip confident deterministic outcomes
  - canonical ref constrained to allowed candidates

## Important Runtime Knobs
`server/.env.example` includes:
- `OLLAMA_ENABLED`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
- `OLLAMA_TIMEOUT_MS` (default `900000`)
- `SEMANTIC_MAX_CALLS` (default `18`)

## Known Good/Bad Patterns from Recent Iteration
### Fixed
- Canonical ref drift to unrelated entries for title fields.
- `Vice Chancellor for Finance and Administration` incorrectly mapping to fee entries.
- Contact phone numbers incorrectly fuzzy-matching application fees.
- Equivalent hard-copy policy wording now returns `fuzzy_match` instead of hard `no_match`.

### Still Needs Work
- Better recall for policy fields across highly varied wording.
- Better extraction precision for `found_value` on long snippets.
- Field-specific calibration and an offline evaluation harness.

## Recommended Next Roadmap
1. Build a labeled regression/eval suite from real scans.
2. Separate extraction from adjudication strictly (value extraction first, then comparison).
3. Add typed canonical claims (currency/value/date/name entities) upstream when feasible.
4. Add contradiction reason codes (`missing`, `conflicting`, `ambiguous`) behind current status labels.
5. Add true backend progress streaming (SSE/WebSocket) for per-pair completion reporting.

## Intended Direction for Jules
Use this instruction baseline:

> You are a world-class AI expert specializing on LLMs, regex, NLPs and NERs, and relevant fields. Optimize and refine the app, its canonical source format, readings, its crawler backend, its normalizations, its policy matching logics, prompting, and all of it.  
>  
> Make sure that the approach of the crawler is best-in-class in efficiency and accuracy as it tries to ensure multiple websites containing different sets of information are consistent compared to a single canonical source of truth.

Practical interpretation:
- Optimize for correctness first, then latency.
- Keep deterministic checks authoritative for typed fields.
- Use LLM narrowly and auditable (small prompt scope + evidence IDs).
- Preserve the CANON API contract and output compatibility.
