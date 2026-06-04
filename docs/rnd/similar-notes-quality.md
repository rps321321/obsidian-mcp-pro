# Similar Notes Quality

_Status: shipped_
_Started: 2026-06-04 - Decided: 2026-06-04_

## Hypothesis

`find_similar_notes` used to compute one centroid from every source-note chunk. If
a source note had unrelated appendices or copied material, that centroid could drift
away from the note's main topic and return off-topic notes first. Source-note
anchoring should improve similar-note quality without adding provider calls during
search.

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
| NDCG@3 | 0.418 | 1.000 |
| Precision@3 | 0.667 | 1.000 |
| Top relevance grade | 0 | 3 |
| Off-topic top result | true | false |

Baseline command samples:

- `node scripts/bench-similar-notes-quality.mjs --json`: NDCG@3 0.418,
  precision@3 0.667, top relevance 0, off-topic top result true.
- `node scripts/bench-similar-notes-quality.mjs --json`: NDCG@3 0.418,
  precision@3 0.667, top relevance 0, off-topic top result true.

After command samples:

- `node scripts/bench-similar-notes-quality.mjs --json`: NDCG@3 1.000,
  precision@3 1.000, top relevance 3, off-topic top result false.
- `node scripts/bench-similar-notes-quality.mjs --json`: NDCG@3 1.000,
  precision@3 1.000, top relevance 3, off-topic top result false.

Current top five:

| rank | note | rel | score | chunk |
|---:|---|---:|---:|---:|
| 1 | `cats-care.md` | 3 | 1.000 | 2 |
| 2 | `cat-health.md` | 3 | 0.998 | 1 |
| 3 | `pet-overview.md` | 2 | 0.975 | 1 |
| 4 | `kitchen-recipes.md` | 0 | 0.099 | 1 |
| 5 | `dogs.md` | 0 | 0.000 | 1 |

## Safety review

The fixture creates a temporary vault path and writes no note files. It calls the
compiled embedding store with synthetic chunks and vectors, computes the same
source-anchored query vector used by `find_similar_notes`, then clears the store
and removes the temp directory. It performs no provider calls, no network calls,
and no real vault reads or writes.

## Kill criterion

Stop if a prototype cannot clear the ship bar without changing the public
`find_similar_notes` surface, adding a live embedding/provider call during search,
or hiding the current best matching candidate chunk.

## Decision

Shipped. `find_similar_notes` now builds a source-anchored query vector by giving
chunks that align with the source note's opening chunk more weight. The fixture
clears the ship bar while preserving tool names, parameters, result shape, and the
best matching candidate chunk shown for each note.
