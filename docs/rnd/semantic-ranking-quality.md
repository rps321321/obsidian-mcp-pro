# Semantic Ranking Quality

_Status: shipped_
_Started: 2026-06-04 - Decided: 2026-06-04_

## Hypothesis

`search_semantic` returns note-level results, but the store currently ranks each
note by its single best chunk. That can let a note with one incidental matching
chunk outrank notes that are focused on the query. A measured ranking fixture can
test whether note-level focus improves result order without changing tool names,
schemas, or result shapes.

## Fixture

The fixture is `scripts/bench-semantic-ranking-quality.mjs`.

It populates the embedding store with synthetic vectors for six notes:

- two focused cat notes with grade-3 relevance,
- one mixed pet overview with grade-2 relevance,
- one kitchen note with a single perfect cat chunk but grade-1 note relevance,
- dog and weather distractors with grade-0 relevance.

Run:

```powershell
npm run build
node scripts/bench-semantic-ranking-quality.mjs --json
```

## Metric

Primary metric: NDCG@3 for the `cat care` query. Secondary guardrails are
precision@3, the top result's relevance grade, and whether an incidental grade-1
note ranks ahead of a focused grade-3 note.

Ship bar: NDCG@3 at or above 0.900, precision@3 at 1.000, top relevance grade 3,
and no incidental grade-1 note ahead of a focused grade-3 note.

| metric | before | after |
|---|---:|---:|
| NDCG@3 | 0.690 | 1.000 |
| Precision@3 | 0.667 | 1.000 |
| Top relevance grade | 1 | 3 |
| Incidental before focused | true | false |

Baseline command samples:

- `node scripts/bench-semantic-ranking-quality.mjs --json`: NDCG@3 0.690,
  precision@3 0.667, top relevance 1, incidental before focused true.
- `node scripts/bench-semantic-ranking-quality.mjs --json`: NDCG@3 0.690,
  precision@3 0.667, top relevance 1, incidental before focused true.

Current top five:

| rank | note | rel | score | chunk |
|---:|---|---:|---:|---:|
| 1 | `kitchen-with-cat.md` | 1 | 1.000 | 1 |
| 2 | `cats-care.md` | 3 | 0.999 | 1 |
| 3 | `cat-health.md` | 3 | 0.998 | 1 |
| 4 | `pet-overview.md` | 2 | 0.973 | 1 |
| 5 | `dogs.md` | 0 | 0.105 | 1 |

## Safety review

The fixture creates a temporary vault path and writes no note files. It calls the
compiled embedding store with synthetic in-memory chunks and vectors, then clears
the store and removes the temp directory. It performs no provider calls, no
network calls, and no real vault reads or writes. Output contains only synthetic
note names, heading labels, scores, and aggregate metrics.

## Kill criterion

Stop if a ranking prototype cannot clear the ship bar without changing the public
semantic tool surface, hiding the best matching snippet, or adding a provider/API
call during search.

## Decision

Ship. `searchEmbeddings` now keeps the best-scoring chunk as the returned snippet
source, but ranks notes by a small focus signal from their top chunks:

```text
0.8 * bestChunkScore + 0.2 * averageTopThreeChunkScores
```

This preserves the existing note-level result shape and best-chunk snippet while
preventing a note with one incidental perfect chunk from outranking focused notes.
A regression test pins the fixture shape at the embedding-store layer.

Measured after the prototype with:

```powershell
npm run build
node scripts/bench-semantic-ranking-quality.mjs --json
node scripts/bench-semantic-ranking-quality.mjs --json
```

Both runs reached NDCG@3 1.000, precision@3 1.000, top relevance grade 3, and no
incidental-before-focused ordering.
