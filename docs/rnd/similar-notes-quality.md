# Similar Notes Quality

_Status: active_
_Started: 2026-06-04 - Decided: pending_

## Hypothesis

`find_similar_notes` computes one centroid from every source-note chunk. If a source
note has unrelated appendices or copied material, that centroid can drift away from
the note's main topic and return off-topic notes first. A measured fixture can test
whether source-note anchoring or top-chunk selection improves similar-note quality
without adding provider calls during search.

## Fixture

The fixture is `scripts/bench-similar-notes-quality.mjs`.

It populates the embedding store with synthetic vectors:

- `source-cat-care.md`: one cat-care chunk plus two unrelated kitchen appendix
  chunks, excluded from returned hits.
- two focused cat notes with grade-3 relevance,
- one mixed pet overview with grade-2 relevance,
- one kitchen note and one dog note with grade-0 relevance.

Run:

```powershell
npm run build
node scripts/bench-similar-notes-quality.mjs --json
```

## Metric

Primary metric: NDCG@3 for notes similar to `source-cat-care.md`. Secondary
guardrails are precision@3, the top result's relevance grade, and whether an
off-topic grade-0 note ranks first.

Ship bar: NDCG@3 at or above 0.900, precision@3 at 1.000, top relevance grade 3,
and no off-topic top result.

| metric | before | after |
|---|---:|---:|
| NDCG@3 | 0.418 | |
| Precision@3 | 0.667 | |
| Top relevance grade | 0 | |
| Off-topic top result | true | |

Baseline command samples:

- `node scripts/bench-similar-notes-quality.mjs --json`: NDCG@3 0.418,
  precision@3 0.667, top relevance 0, off-topic top result true.
- `node scripts/bench-similar-notes-quality.mjs --json`: NDCG@3 0.418,
  precision@3 0.667, top relevance 0, off-topic top result true.

Current top five:

| rank | note | rel | score | chunk |
|---:|---|---:|---:|---:|
| 1 | `kitchen-recipes.md` | 0 | 0.857 | 1 |
| 2 | `pet-overview.md` | 2 | 0.759 | 1 |
| 3 | `cats-care.md` | 3 | 0.581 | 2 |
| 4 | `cat-health.md` | 3 | 0.549 | 1 |
| 5 | `dogs.md` | 0 | 0.000 | 1 |

## Safety review

The fixture creates a temporary vault path and writes no note files. It calls the
compiled embedding store with synthetic chunks and vectors, computes the same
source centroid used by `find_similar_notes`, then clears the store and removes
the temp directory. It performs no provider calls, no network calls, and no real
vault reads or writes.

## Kill criterion

Stop if a prototype cannot clear the ship bar without changing the public
`find_similar_notes` surface, adding a live embedding/provider call during search,
or hiding the current best matching candidate chunk.

## Decision

Active. The next step is a prototype that anchors the source representation to
the source note's focused chunks while preserving the existing result shape.
