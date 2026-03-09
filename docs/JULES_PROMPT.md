# Jules Prompt (Copy/Paste)

You are a world-class AI expert specializing in LLM systems, regex, NLP/NER pipelines, web extraction, and retrieval-grounded adjudication.

Your task is to optimize and refine this repository end-to-end:
- canonical source format handling
- crawler extraction quality
- deterministic normalization/matching
- policy and semantic matching logic
- prompting strategy
- latency/cost controls
- UI evidence clarity

Goal: maximize consistency-checking accuracy between multiple target websites and one canonical source of truth.

## Hard Requirements
1. Read and follow `CANON_API.md` as the integration contract.
2. Preserve output compatibility:
```json
{
  "fact": "string",
  "canonical_ref": "claim_id or kv_index key",
  "status": "match|fuzzy_match|no_match",
  "confidence": 0.0,
  "reason": "short explanation"
}
```
3. Prefer canonical claims API as primary and flat canon as deterministic fallback:
- `/api/admissions/claims?format=jsonl` (primary)
- `/api/admissions/flat` (fallback)
4. Continue iterating until results are materially improved against the labeled cases in `fixtures/eval/expected-labels.v1.json`.

## Model Provider Directive
Use Ollama if available. If not, use any equivalent provider available in your environment (Gemini/OpenAI/Anthropic/local HF), but keep behavior and output contract identical.

Prioritize:
1. Deterministic checks for typed fields (names, emails, dates, amounts).
2. Narrow semantic adjudication only when deterministic evidence is inconclusive.
3. Evidence-linked outputs and reproducibility.

## Baseline Inputs (from `notes.txt`)
Canonical URL:
- `http://localhost:4000/api/admissions`

Target URLs:
1. `https://www.upou.edu.ph/about/office-of-the-chancellor/`
2. `https://registrar.upou.edu.ph/admission/`
3. `https://registrar.upou.edu.ph/bachelors-program/`
4. `https://our.upou.edu.ph/oas`

Watched fields:
1. `Chancellor`
2. `Vice Chancellor for Academic Affairs`
3. `Vice Chancellor for Finance and Administration`
4. `Hard copies of admission documents by mail`
5. `UgAT requirement`
6. `UPCAT requirement`
7. `Tuition per unit`
8. `Application fee (Filipino undergraduate)`
9. `Application fee (Foreign undergraduate)`
10. `Admission inquiries email`
11. `Technical support email`
12. `Mailing address`
13. `1st Trimester AY 2026-2027 deadline`

Machine-readable inputs:
- `fixtures/eval/inputs.notes-baseline.json`

## If Local APIs Are Unavailable
Use included fixtures:
- `fixtures/canonical/admissions.snapshot.json`
- `fixtures/canonical/admissions.flat.json`
- `fixtures/canonical/admissions.claims.jsonl`
- `fixtures/targets/upou-target-snapshots.json`
- `fixtures/eval/inputs.notes-baseline.json`
- `fixtures/eval/expected-labels.v1.json`

## Success Criteria
1. Reduced canonical reference drift (wrong canonical picked for watched field).
2. Stronger typed-field precision (avoid phone-number/fee cross-matches).
3. Better policy paraphrase recognition with contradiction detection.
4. Stable, explainable confidence calibration.
5. Maintained or improved runtime practicality.
