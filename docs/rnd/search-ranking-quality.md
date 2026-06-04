# Search Ranking Quality

_Status: active_
_Started: 2026-06-04 - Decided: pending_

## Hypothesis

`search_notes` ranks lexical matches by raw match count. A long or noisy note with
many incidental mentions can outrank shorter notes whose title and body are more
focused on the user's query. A measured fixture can test whether a lightweight
focus signal improves lexical search ranking without changing the tool schema or
adding provider calls.

## Fixture

The fixture is `scripts/bench-search-ranking-quality.mjs`.

It calls `searchInContents` with synthetic note bodies for query `migration`:

- `meeting-transcript.md`: grade-1 relevance, eight incidental mentions,
- `migration-plan.md`: grade-3 relevance, four focused mentions,
- `migration-checklist.md`: grade-3 relevance, three focused mentions,
- `release-notes.md`: grade-2 relevance, one related mention,
- `zz-glossary.md`: grade-0 relevance, one generic definition,
- `cooking.md`: grade-0 relevance, no match.

Run:

```powershell
npm run build
node scripts/bench-search-ranking-quality.mjs --json
```

## Metric

Primary metric: NDCG@3 for lexical `search_notes` ordering. Secondary guardrails
are precision@3, the top result's relevance grade, and whether an incidental
grade-1 note ranks before focused grade-3 notes.

Ship bar: NDCG@3 at or above 0.900, precision@3 at 1.000, top relevance grade 3,
and no incidental-before-focused ordering.

| metric | before | after |
|---|---:|---:|
| NDCG@3 | 0.690 | |
| Precision@3 | 0.667 | |
| Top relevance grade | 1 | |
| Incidental before focused | true | |

Baseline command samples:

- `node scripts/bench-search-ranking-quality.mjs --json`: NDCG@3 0.690,
  precision@3 0.667, top relevance 1, incidental before focused true.
- `node scripts/bench-search-ranking-quality.mjs --json`: NDCG@3 0.690,
  precision@3 0.667, top relevance 1, incidental before focused true.

Current top five:

| rank | note | rel | matches | score |
|---:|---|---:|---:|---:|
| 1 | `meeting-transcript.md` | 1 | 8 | 8 |
| 2 | `migration-plan.md` | 3 | 4 | 4 |
| 3 | `migration-checklist.md` | 3 | 3 | 3 |
| 4 | `release-notes.md` | 2 | 1 | 1 |
| 5 | `zz-glossary.md` | 0 | 1 | 1 |

## Safety review

The fixture uses in-memory synthetic note bodies and calls the compiled pure
scanner directly. It performs no filesystem writes, no provider calls, no network
calls, and no real vault reads. Any prototype must preserve escaped output,
literal string matching, case-sensitivity behavior, folder handling, and
`maxResults` bounds.

## Kill criterion

Stop if a prototype cannot clear the ship bar without changing `search_notes`
tool parameters or return shape, adding semantic/provider calls, or hiding the
line snippets that explain each lexical hit.

## Decision

Active. The next step is a ranking prototype that rewards focused title/body
matches without making long repeated notes disappear from the result set.
