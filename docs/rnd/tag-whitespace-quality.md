# Tag Whitespace Quality

_Status: shipped_
_Started: 2026-06-07 - Decided: 2026-06-07_

## Hypothesis

Obsidian tags cannot contain blank spaces, but `extractTags` accepted whitespace
inside YAML frontmatter tag values. Filtering whitespace-bearing frontmatter
tags should remove false positives from `list_tags` and `search_by_tag` without
reducing valid hyphen, underscore, nested, or inline tag recall.

Official sources:

- https://help.obsidian.md/tags
- https://help.obsidian.md/properties

## Fixture

Bench command:

```powershell
npm run build
node scripts\bench-tag-whitespace-quality.mjs --json
```

The fixture creates a temporary five-note vault and calls `list_tags` and
`search_by_tag` through a real stdio MCP client.

Relevant notes:

- `space-frontmatter.md` has frontmatter `tags: ["project alpha"]`
- `hyphen-frontmatter.md` has frontmatter `tags: [project-alpha]`
- `underscore-frontmatter.md` has frontmatter `tags: [project_alpha]`
- `nested.md` has frontmatter `tags: [project/alpha]`
- `inline-valid.md` contains inline `#meeting-notes`

## Metric

Primary metric: whitespace-bearing frontmatter tag leakage across tag listing
and tag search.

Ship bar: zero whitespace-bearing frontmatter tags listed, zero whitespace
frontmatter search matches, `validTagListRecall` at 1.000, and
`validSearchRecall` at 1.000.

| | before | after |
|---|---:|---:|
| invalid whitespace tags listed | 1 | 0 |
| invalid whitespace search matches | 1 | 0 |
| valid tag list recall | 1.000 | 1.000 |
| valid search recall | 1.000 | 1.000 |

## Safety review

Data accessed: synthetic markdown notes generated in a temporary vault by
`scripts/bench-tag-whitespace-quality.mjs`. No real vault content, secrets,
network calls, or embedding providers are used.

Writes performed: temporary fixture vault creation and deletion only.

Logs emitted: normal stdio server startup logging with the temporary vault path
redacted by the shared logger sanitizer.

Rollback path: restore the previous frontmatter tag normalization helper and
keep the benchmark as a stopped experiment.

## Kill criterion

Stop if filtering whitespace-bearing frontmatter values removes valid hyphen,
underscore, nested, inline, numeric-mixed, or leading-hash-normalized tags, or if
tag-index cache invalidation changes.

## Decision

Shipped. Frontmatter tags containing whitespace are now ignored before insertion.
The benchmark removed both invalid whitespace listing and search matches while
valid tag list and search recall stayed at 1.000.
