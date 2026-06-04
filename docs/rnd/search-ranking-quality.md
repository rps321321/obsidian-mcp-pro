# Search Ranking Quality

_Status: shipped_
_Started: 2026-06-04 - Decided: 2026-06-04_

## Hypothesis

`search_notes` used to rank lexical matches by raw match count. A long or noisy
note with many incidental mentions could outrank shorter notes whose title and
body are more focused on the user's query. A lightweight focus signal should
improve lexical search ranking without changing the tool schema or adding
provider calls.

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
| NDCG@3 | 0.690 | 1.000 |
| Precision@3 | 0.667 | 1.000 |
| Top relevance grade | 1 | 3 |
| Incidental before focused | true | false |

Baseline command samples:

- `node scripts/bench-search-ranking-quality.mjs --json`: NDCG@3 0.690,
  precision@3 0.667, top relevance 1, incidental before focused true.
- `node scripts/bench-search-ranking-quality.mjs --json`: NDCG@3 0.690,
  precision@3 0.667, top relevance 1, incidental before focused true.

After command samples:

- `node scripts/bench-search-ranking-quality.mjs --json`: NDCG@3 1.000,
  precision@3 1.000, top relevance 3, incidental before focused false.
- `node scripts/bench-search-ranking-quality.mjs --json`: NDCG@3 1.000,
  precision@3 1.000, top relevance 3, incidental before focused false.

Current top five:

| rank | note | rel | snippet lines | score |
|---:|---|---:|---:|---:|
| 1 | `migration-checklist.md` | 3 | 2 | 9.847 |
| 2 | `migration-plan.md` | 3 | 2 | 9.402 |
| 3 | `release-notes.md` | 2 | 1 | 1.173 |
| 4 | `zz-glossary.md` | 0 | 1 | 1.173 |
| 5 | `meeting-transcript.md` | 1 | 2 | 0.000 |

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

Shipped. `search_notes` now scores literal matches with a small focus signal from
note paths and headings, plus dampening for repeated matches on the same line.
The fixture clears the ship bar while preserving tool names, parameters, result
shape, literal matching, and the matched line snippets shown for each matching
line.
