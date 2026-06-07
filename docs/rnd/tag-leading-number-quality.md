# Tag Leading Number Quality

_Status: shipped_
_Started: 2026-06-07 - Decided: 2026-06-07_

## Hypothesis

Obsidian tags can include numbers and only require at least one non-numerical
character, but inline extraction and `rename_tag` validation rejected tag names
that started with a digit. Allowing numeric-leading tags such as `#1a` and
`#2026-goals` should improve inline tag recall and rename coverage without
letting numeric-only tags such as `#1984` into tag results.

Official sources:

- https://obsidian.md/help/tags
- https://obsidian.md/help/properties

## Fixture

Bench command:

```powershell
npm run build
node scripts\bench-tag-leading-number-quality.mjs --json
```

The fixture creates a temporary five-note vault and calls `list_tags` and
`search_by_tag` through a real stdio MCP client.

Relevant notes:

- `one-a.md` contains inline `#1a`
- `year-goals.md` contains inline `#2026-goals`
- `numeric-only.md` contains inline `#1984`
- `numeric-nested-only.md` contains inline `#1984/2020`
- `ordinary.md` contains inline `#a1`

## Metric

Primary metric: recall for valid numeric-leading inline tags.

Ship bar: `numericLeadingTagListRecall` at 1.000,
`numericLeadingSearchRecall` at 1.000, zero numeric-only listing/search leakage,
and ordinary inline tag search recall still 1.000.

| | before | after |
|---|---:|---:|
| numeric-leading tag list recall | 0.000 | 1.000 |
| numeric-leading search recall | 0.000 | 1.000 |
| invalid numeric-only tags listed | 0 | 0 |
| invalid numeric-only search matches | 0 | 0 |
| ordinary search recall | 1.000 | 1.000 |

## Safety review

Data accessed: synthetic markdown notes generated in a temporary vault by
`scripts/bench-tag-leading-number-quality.mjs`. No real vault content, secrets,
network calls, or embedding providers are used.

Writes performed: temporary fixture vault creation and deletion only.

Logs emitted: normal stdio server startup logging with the temporary vault path
redacted by the shared logger sanitizer.

Rollback path: restore the old inline tag head character class and old
`rename_tag` validation, then keep the benchmark as a stopped experiment.

## Kill criterion

Stop if allowing numeric-leading tags admits numeric-only tags, changes ATX
heading handling, changes inline-code/fenced-code exclusions, breaks nested
matching, or weakens `rename_tag` validation for leading hash, leading slash, or
whitespace-bearing names.

## Decision

Shipped. Inline tag parsing and `rename_tag` validation now accept
numeric-leading tags when the name contains at least one non-numerical character.
The benchmark raised numeric-leading list/search recall from 0.000 to 1.000
while numeric-only leakage stayed at zero.
