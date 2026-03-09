# Canon API Integration Spec (for `university-crawler`)

## Update Summary

- Canon source is now Supabase-backed.
- Use these endpoints from admissions-hub:
  - `GET /api/admissions` → full canonical snapshot (`data`)
  - `GET /api/admissions/claims?format=jsonl` → atomic matcher claims (preferred)
  - `GET /api/admissions/flat` → low-noise flat canon (`sections`, `section_summaries`, `announcements`, `contacts`, `kv_index`)

## Required Crawler Changes

- Add payload adapters for:
  - snapshot (`/api/admissions`)
  - claims JSONL (`/api/admissions/claims?format=jsonl`)
  - flat canon (`/api/admissions/flat`)
- Matching strategy:
  - Primary: compare extracted facts against claims (`claim_id`, `canonical_text`, `aliases`, `entities`)
  - Fallback: compare exact/fuzzy against `flat.kv_index`
- Handle flat section shapes:
  - object (`label:value`)
  - array (plain list)
  - mixed (`{ pairs, items }`)

## Suggested Classification Thresholds

- `match >= 0.82`
- `fuzzy_match 0.62–0.81`
- `no_match < 0.62`

Tune after real crawl results.

## Output Contract (per extracted fact)

Return:

```json
{
  "fact": "string",
  "canonical_ref": "claim_id or kv_index key",
  "status": "match|fuzzy_match|no_match",
  "confidence": 0.0,
  "reason": "short explanation"
}
```

## Regression Cases To Add

- Conflicting/tentative deadlines
- Duplicate labels with multiple values (e.g., application fee variants)
- Contact drift (email/address changes)
- Policy negation errors (“allowed” vs “not allowed”)

## Note to Crawler Agent

Please migrate canonical comparisons to the new API contract above.  
Prefer claims-based matching for semantic checks, and use flat `kv_index` for deterministic checks (dates, fees, contacts, officials).

## Recommended Algorithm (field-by-field adjudication)

Avoid one large prompt with all URLs + all fields.  
Run a scoped loop per watched field and per URL.

1. Fetch canonical datasets once per run:
   - `GET /api/admissions/flat`
   - `GET /api/admissions/claims?format=jsonl`
2. For each watched field:
   - Resolve candidate canonical references from:
     - flat keys in `kv_index`
     - related claims (`claim_id`, `aliases`, `canonical_text`)
3. For each target URL:
   - Crawl and extract clean paragraph/snippet blocks.
   - Keep stable snippet IDs for evidence tracing.
4. For each `(watched field, target URL)` pair:
   - Step A (deterministic): exact/normalized checks for names, emails, dates, fees.
   - Step B (semantic): if Step A is inconclusive, call Ollama using only top canonical candidates + top snippets.
   - Return `match | fuzzy_match | no_match` with confidence and evidence IDs.
5. Aggregate results:
   - by URL
   - by watched field
   - overall consistency score and priority findings.

## How to Use Existing 3 Inputs

Current inputs:
1. canonical source URL
2. target URLs
3. watched fields

Recommended mapping:
- Keep `canonical source URL` as base and call:
  - `/api/admissions/claims?format=jsonl`
  - `/api/admissions/flat`
- Keep `target URLs` as crawl sources.
- Keep `watched fields` as loop drivers (one check unit per field per URL).

## Ollama Prompting Spec

Use one prompt per `(watched field, target URL)` pair.

### System Prompt

```text
You are a strict admissions consistency checker.
Use only the provided evidence.
If evidence is missing or ambiguous, return no_match.
Return valid JSON only.
```

### User Payload Template

```json
{
  "watched_field": "1st Trimester AY 2026-2027 deadline",
  "canonical_candidates": [
    {
      "canonical_ref": "Important Deadlines.1st Trimester AY 2026-2027",
      "text": "March 31, 2026 (tentative per OAS) or May 30, 2026 (tentative per OUR)."
    },
    {
      "canonical_ref": "claim_id:important-deadlines-item-3",
      "text": "1st Trimester AY 2026-2027: March 31, 2026 ... or May 30, 2026 ..."
    }
  ],
  "target_url": "https://example.edu/admissions",
  "target_snippets": [
    {
      "id": "s12",
      "text": "Application deadline for 1st trimester AY 2026-2027 is May 30, 2026."
    },
    {
      "id": "s20",
      "text": "Dates are tentative pending final memo."
    }
  ],
  "rules": {
    "labels": ["match", "fuzzy_match", "no_match"]
  }
}
```

### Required Model Output

```json
{
  "watched_field": "string",
  "status": "match|fuzzy_match|no_match",
  "confidence": 0.0,
  "canonical_ref": "claim_id or kv_index key",
  "target_snippet_ids": ["s12"],
  "reason": "short explanation"
}
```

## Practical Defaults

- Candidate retrieval:
  - top 3 from `kv_index` lexical lookup
  - top 3 from claims semantic/alias lookup
- Decision thresholds:
  - `match >= 0.82`
  - `fuzzy_match 0.62–0.81`
  - `no_match < 0.62`
- Prioritize deterministic checks when fields include:
  - names
  - emails
  - explicit dates
  - explicit fees/amounts
