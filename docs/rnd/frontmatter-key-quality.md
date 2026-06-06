# Frontmatter Key Quality

_Status: active_
_Started: 2026-06-05 - Decided: _

## Hypothesis

People and agents often ask for normalized metadata names such as `status` even
when a vault has notes written with `Status` or `STATUS`. A key-normalized
`search_by_frontmatter` lookup may improve recall without changing value
matching, result shape, folder filtering, truncation, or displayed frontmatter.

## Fixture

Bench command:

```powershell
node scripts\bench-frontmatter-key-quality.mjs --json
```

The fixture creates a temporary five-note vault and calls
`search_by_frontmatter` through a real stdio MCP client with
`property: "status"`, `value: "ready"`, and `maxResults: 10`.

Relevant notes:

- `lower-status.md` has `status: ready`
- `title-status.md` has `Status: ready`
- `upper-status.md` has `STATUS: ready`

Guardrail notes:

- `blocked-status.md` has `status: blocked`
- `owner-ready.md` has `owner: ready`

## Metric

Primary metric: recall across relevant frontmatter key-case variants.

Ship bar: recall 1.000, zero wrong-key matches, zero duplicate paths, and the
exact lowercase-key hit still present. Existing scalar, array, folder,
`maxResults`, no-match, and rendered-frontmatter behavior must stay unchanged.

| | before | after |
|---|---:|---:|
| case-variant recall | 0.333 | |
| matched relevant notes | 1 / 3 | |
| case-variant misses | 2 | |
| wrong-key matches | 0 | |
| duplicate paths | 0 | |

Current rows:

| result | paths |
|---|---|
| matched | `lower-status.md` |
| missed variants | `title-status.md`, `upper-status.md` |
| wrong-key matches | _none_ |

## Safety review

Data accessed: synthetic frontmatter and note names generated in a temporary
vault by `scripts/bench-frontmatter-key-quality.mjs`. No real vault content,
secrets, network calls, or persistent cache files are used.

Writes performed: temporary fixture vault creation and deletion only.

Logs emitted: normal stdio server startup logging with the temporary vault path.

Rollback path: delete the benchmark and mark this experiment stopped; no runtime
behavior changes are part of the baseline.

## Kill criterion

Stop if key-normalized lookup causes wrong-key matches, duplicate rows, unstable
ordering, stale frontmatter after writes, folder-scope regressions, or changed
rendering of returned frontmatter.

## Decision

Active. The baseline shows `search_by_frontmatter` finds the exact lowercase
`status` key but misses `Status` and `STATUS`, leaving recall at 0.333 with zero
wrong-key matches.
