# Tag Validity Quality

_Status: shipped_
_Started: 2026-06-07 - Decided: 2026-06-07_

## Hypothesis

Obsidian rejects numeric-only tags such as `#1984`, but `extractTags` accepted
numeric-only values from YAML frontmatter. Filtering numeric-only frontmatter
tags should remove false positives from `list_tags` and `search_by_tag` without
reducing valid mixed, nested, or inline tag recall.

Official sources:

- https://help.obsidian.md/tags
- https://help.obsidian.md/properties

## Fixture

Bench command:

```powershell
npm run build
node scripts\bench-tag-validity-quality.mjs --json
```

The fixture creates a temporary five-note vault and calls `list_tags` and
`search_by_tag` through a real stdio MCP client.

Relevant notes:

- `numeric-frontmatter.md` has frontmatter `tags: [1984]`
- `mixed-year.md` has frontmatter `tags: [y1984]`
- `nested.md` has frontmatter `tags: [project/alpha]`
- `inline-invalid.md` contains inline `#1984`
- `inline-valid.md` contains inline `#meeting`

## Metric

Primary metric: invalid numeric-only tag leakage across tag listing and tag
search.

Ship bar: zero numeric-only frontmatter tags listed, zero numeric-only
frontmatter search matches, `validTagListRecall` at 1.000, and
`validSearchRecall` at 1.000.

| | before | after |
|---|---:|---:|
| invalid numeric tags listed | 1 | 0 |
| invalid numeric search matches | 1 | 0 |
| valid tag list recall | 1.000 | 1.000 |
| valid search recall | 1.000 | 1.000 |

## Safety review

Data accessed: synthetic markdown notes generated in a temporary vault by
`scripts/bench-tag-validity-quality.mjs`. No real vault content, secrets,
network calls, or embedding providers are used.

Writes performed: temporary fixture vault creation and deletion only.

Logs emitted: normal stdio server startup logging with the temporary vault path
redacted by the shared logger sanitizer.

Rollback path: restore the old frontmatter tag insertion path and keep the
benchmark as a stopped experiment.

## Kill criterion

Stop if filtering numeric-only frontmatter values removes valid mixed tags,
nested tags, inline tags, control-character escaping behavior, nested-parent
matching, or tag-index cache invalidation.

## Decision

Shipped. Frontmatter tags are now normalized by trimming and dropping leading
hashes before insertion, then numeric-only values are ignored. The benchmark
removed both invalid numeric-only listing and search matches while valid tag
list and search recall stayed at 1.000.
