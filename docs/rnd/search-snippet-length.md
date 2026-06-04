# Search Snippet Length

_Status: shipped_
_Started: 2026-06-04 - Decided: 2026-06-04_

## Hypothesis

`search_notes` now collapses repeated same-line hits, but a single matching line
can still be very long. A copied status line, minified blob, or pasted log line
can dominate the result text even when the useful evidence is near the query. A
measured fixture can test whether query-centered snippets reduce output load
without hiding the matching line or changing the tool schema.

## Fixture

`scripts/bench-search-snippet-length.mjs` builds three synthetic notes and calls
`searchInContents` for query `migration` with `maxResults: 5`:

- `migration-status.md` has one very long matching status line
- `migration-plan.md` has short focused matches
- `release-notes.md` has one short related match

The fixture measures the visible snippet strings returned by the matcher, which
are the same strings `search_notes` renders to clients.

## Metric

Primary metric: max snippet chars. Secondary guardrails are total snippet chars,
oversized snippet rows, and whether every snippet still contains the query.

Ship bar: max snippet chars at or below 240, total snippet chars at or below 640,
zero oversized snippet rows, and every snippet still contains the query.

| metric | before | after |
|---|---:|---:|
| Max snippet chars | 2152 | 237 |
| Total snippet chars | 2285 | 370 |
| Oversized snippet rows | 1 | 0 |
| Snippets keep query | true | true |
| Clears length bars | false | true |

Baseline command samples:

- `node scripts/bench-search-snippet-length.mjs --json`: max snippet chars 2152,
  total snippet chars 2285, oversized snippet rows 1, snippets keep query true,
  clears length bars false.
- `node scripts/bench-search-snippet-length.mjs --json`: max snippet chars 2152,
  total snippet chars 2285, oversized snippet rows 1, snippets keep query true,
  clears length bars false.

After command samples:

- `node scripts/bench-search-snippet-length.mjs --json`: max snippet chars 237,
  total snippet chars 370, oversized snippet rows 0, snippets keep query true,
  clears length bars true.
- `node scripts/bench-search-snippet-length.mjs --json`: max snippet chars 237,
  total snippet chars 370, oversized snippet rows 0, snippets keep query true,
  clears length bars true.

Current rows:

| note | rows | snippet chars | max snippet chars | oversized rows |
|---|---:|---:|---:|---:|
| `migration-plan.md` | 2 | 61 | 45 | 0 |
| `migration-status.md` | 2 | 255 | 237 | 0 |
| `release-notes.md` | 1 | 54 | 54 | 0 |

## Safety review

The fixture uses in-memory synthetic note bodies and reads the built
`searchInContents` implementation. It performs no vault I/O, writes no notes,
does not touch permissions, and emits only aggregate size metrics. Any prototype
must keep literal matching, case sensitivity, ranking order, folder filtering,
max-result handling, and at least one visible query occurrence per snippet.

## Kill criterion

Stop without a runtime change if a snippet-length prototype hides the query,
changes result ordering, adds a new public parameter or result shape, or makes
short normal snippets worse.

## Decision

Shipped. `search_notes` now caps long matching lines with query-centered
snippets. The fixture clears the length bars while preserving literal matching,
ranking order, case sensitivity, folder filtering, max-result handling, and a
visible query occurrence in every snippet.
