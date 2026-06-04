# Search Snippet Quality

_Status: shipped_
_Started: 2026-06-04 - Decided: 2026-06-04_

## Hypothesis

`search_notes` now ranks focused notes ahead of repeated incidental mentions, but
the snippet rows can still repeat the same line once per literal hit. A noisy line
with the query repeated many times can spend result space on duplicate evidence.
A measured fixture can test whether duplicate same-line snippets can be collapsed
without changing tool names, parameters, or the note ranking logic.

## Fixture

`scripts/bench-search-snippet-quality.mjs` builds five synthetic notes and calls
`searchInContents` for query `migration` with `maxResults: 5`:

- two focused migration notes with query hits spread across separate lines
- one release note with a single mention
- one glossary note with a generic mention
- one meeting transcript with eight hits across two lines

The matcher output is the source that `search_notes` renders into text rows, so
the fixture measures visible snippet duplication without adding a tool surface.

## Metric

Primary metric: duplicate snippet rows, counted as `matches.length - unique line
count` for each returned note, summed across results. Ship only if duplicate
snippet rows fall to zero while every matching note still has at least one
visible snippet line.

| metric | before | after |
|---|---:|---:|
| Duplicate snippet rows | 6 | 0 |
| Unique line coverage | 0.667 | 1.000 |
| Total snippet rows | 18 | 12 |
| Unique snippet lines | 12 | 12 |

Baseline command samples:

- `node scripts/bench-search-snippet-quality.mjs --json`: duplicate snippet rows
  6, unique line coverage 0.667, total snippet rows 18, unique snippet lines 12.
- `node scripts/bench-search-snippet-quality.mjs --json`: duplicate snippet rows
  6, unique line coverage 0.667, total snippet rows 18, unique snippet lines 12.

After command samples:

- `node scripts/bench-search-snippet-quality.mjs --json`: duplicate snippet rows
  0, unique line coverage 1.000, total snippet rows 12, unique snippet lines 12.
- `node scripts/bench-search-snippet-quality.mjs --json`: duplicate snippet rows
  0, unique line coverage 1.000, total snippet rows 12, unique snippet lines 12.

Current rows:

| note | matches | unique lines | duplicate rows |
|---|---:|---:|---:|
| `migration-checklist.md` | 4 | 4 | 0 |
| `migration-plan.md` | 4 | 4 | 0 |
| `release-notes.md` | 1 | 1 | 0 |
| `zz-glossary.md` | 1 | 1 | 0 |
| `meeting-transcript.md` | 2 | 2 | 0 |

## Safety review

The fixture uses in-memory synthetic note bodies and reads the built
`searchInContents` implementation. It performs no vault I/O, writes no notes,
does not touch permissions, and emits only aggregate metric rows. Any prototype
must keep raw matching case sensitivity, note order, max-result caps, and folder
filter behavior intact.

## Kill criterion

Stop without a runtime change if collapsing duplicate snippet rows hides the
fact that a returned note matched the query, changes ranking, or requires a new
public parameter or result format.

## Decision

Shipped. `search_notes` now keeps raw literal hit counts for ranking, then
collapses returned matches to one snippet per source line. The fixture clears
the ship bar without changing tool names, parameters, result format, ranking
order, case sensitivity, folder filtering, or max-result handling.
