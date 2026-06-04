# Chunker Boundary Quality

_Status: shipped_
_Started: 2026-06-04 - Decided: 2026-06-04_

## Hypothesis

Semantic indexing chunks are more useful when they keep title and heading context
and do not slice syntax boundaries such as fenced code blocks. The current chunker
keeps heading context well, but long fenced blocks can still be split by the
character-window fallback.

## Fixture

The fixture is `scripts/bench-chunker-quality.mjs`.

It builds three synthetic notes:

- `project-playbook`: frontmatter title and aliases plus H1/H2/H3 sections.
- `code-reference`: a long fenced TypeScript block under a heading.
- `dense-meeting-log`: dense meeting notes with tasks and follow-up headings.

Run:

```powershell
npm run build
node scripts/bench-chunker-quality.mjs --json
```

## Metric

Primary metric: weighted boundary score from the fixture. A perfect score is 100.
The score penalizes chunks that split fenced code blocks, exceed the target size,
or lose title/heading prefixes.

Ship bar: reach at least 95 with zero fenced-code fractures, mean token-load ratio
at or below 1.30x, and no more than 24 chunks on the fixture.

| metric | before | after |
|---|---:|---:|
| Boundary score | 88.0 | 100.0 |
| Fenced-code fractures | 2 | 0 |
| Oversize chunks | 0 | 0 |
| Heading prefix coverage | 100% | 100% |
| Title prefix coverage | 100% | 100% |
| Mean token-load ratio | 1.18x | 1.15x |
| Chunk count | 21 | 21 |

Baseline command samples:

- `node scripts/bench-chunker-quality.mjs --json`: score 88.0, two fence
  fractures, 21 chunks, 1.18x mean token load.
- `node scripts/bench-chunker-quality.mjs --json`: score 88.0, two fence
  fractures, 21 chunks, 1.18x mean token load.

## Safety review

The fixture generates note bodies in memory and calls the compiled chunker
directly. It performs no vault reads, no vault writes, no embedding-provider calls,
and no network calls. Output contains only synthetic fixture text and aggregate
metrics. Rollback is removing the script and this R&D document.

## Kill criterion

Stop if fenced-code fractures cannot reach zero without pushing token load above
1.30x, producing more than 24 chunks, or changing the public semantic tool surface.

## Decision

Ship. Oversized fenced code blocks now split by lines into chunks that carry the
original opening and closing fence. Non-code paragraphs keep the existing
paragraph and character-window behavior. Code-block splits skip copied line
overlap because the wrapper fences already preserve boundary context and the
experiment's token/chunk-load bars are tighter without duplicate code lines.

A regression test forces a large fenced block through the chunker and verifies
every emitted code chunk has a balanced opening and closing fence.

Measured after the prototype with:

```powershell
npm run build
node scripts/bench-chunker-quality.mjs --json
node scripts/bench-chunker-quality.mjs --json
```

Both runs scored 100.0 with zero fenced-code fractures, zero oversize chunks,
21 chunks, and 1.15x mean token load.
