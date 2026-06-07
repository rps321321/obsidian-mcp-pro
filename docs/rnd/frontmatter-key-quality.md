# Frontmatter Key Quality

_Status: shipped_
_Started: 2026-06-05 - Decided: 2026-06-06_

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
| case-variant recall | 0.333 | 1.000 |
| matched relevant notes | 1 / 3 | 3 / 3 |
| case-variant misses | 2 | 0 |
| wrong-key matches | 0 | 0 |
| duplicate paths | 0 | 0 |

Final rows:

| result | paths |
|---|---|
| matched | `lower-status.md`, `title-status.md`, `upper-status.md` |
| missed variants | _none_ |
| wrong-key matches | _none_ |

## Safety review

Data accessed: synthetic frontmatter and note names generated in a temporary
vault by `scripts/bench-frontmatter-key-quality.mjs`. No real vault content,
secrets, network calls, or persistent cache files are used.

Writes performed: temporary fixture vault creation and deletion only.

Logs emitted: normal stdio server startup logging with the temporary vault path
redacted by the shared logger sanitizer.

Rollback path: restore exact-key lookup in `search_by_frontmatter`, keep the
benchmark parser update, and mark this experiment stopped.

## Kill criterion

Stop if key-normalized lookup causes wrong-key matches, duplicate rows, unstable
ordering, stale frontmatter after writes, folder-scope regressions, or changed
rendering of returned frontmatter.

## Decision

Shipped. The benchmark parser was first updated to read the current
untrusted-content result-path block format; that restored the measured baseline
to recall 0.333. Case-normalized key lookup then raised recall to 1.000,
matching all three relevant notes with zero wrong-key matches and zero
duplicates in two repeated runs.
