# R&D

Experiments that might expand the product. The rule: nothing new becomes permanent
surface (a tool, prompt, flag, or format) until a committed fixture and a metric show
it beats what's already there.

## How it works

1. Copy `_template.md` to `docs/rnd/<short-name>.md`.
2. Fill in the hypothesis, fixture, and the metric you'll move.
3. Build the fixture under `tests/` or point at the bench harness.
4. Run it, record before/after numbers.
5. Make the call: ship, revise, defer, or stop — and write down why.

Keep one experiment active at a time when the maintenance backlog is clear. Don't
delete stopped experiments; mark them `stopped` so the negative result stays on record.

## Status

| Experiment | Track | Status | Decision |
|---|---|---|---|
| [Search Snippet Quality](search-snippet-quality.md) | retrieval quality | shipped | Duplicate snippet rows fell from 6 to 0, unique-line coverage rose from 0.667 to 1.000, and each matching note still keeps at least one visible snippet line. |
| [Search Ranking Quality](search-ranking-quality.md) | retrieval quality | shipped | NDCG@3 rose from 0.690 to 1.000, precision@3 rose from 0.667 to 1.000, and repeated incidental mentions no longer rank ahead of focused lexical matches. |
| [Similar Notes Quality](similar-notes-quality.md) | retrieval quality | shipped | NDCG@3 rose from 0.418 to 1.000, precision@3 rose from 0.667 to 1.000, and unrelated source appendices no longer push an off-topic kitchen note into first place. |
| [Semantic Ranking Quality](semantic-ranking-quality.md) | retrieval quality | shipped | NDCG@3 rose from 0.690 to 1.000, precision@3 rose from 0.667 to 1.000, and grade-1 incidental matches no longer rank ahead of focused grade-3 notes. |
| [Chunker Boundary Quality](chunker-boundary-quality.md) | retrieval quality | shipped | Score rose from 88.0 to 100.0, fenced-code fractures fell from two to zero, chunk count stayed at 21, and mean token load fell to 1.15x. |
| [Daily Note Warm Path](daily-note-warm-path.md) | performance / agent workflows | stopped | Config and rendered-response cache prototypes missed the warm ship bar or exceeded guardrails, so no runtime change shipped. |
| [Section Read Warm Path](section-read-warm-path.md) | performance / agent workflows | stopped | Cache and streaming-parser prototypes missed the cold or warm ship bar, so no runtime change shipped. |
| [Section List Warm Path](section-list-warm-path.md) | performance / agent workflows | shipped | Warm 1,000-heading `list_sections` fell from 3.2ms to 1.2ms while cold stayed under the guardrail. |
| [Note Fragment Warm Path](note-fragment-warm-path.md) | performance / agent workflows | shipped | Warm 10,000-line `get_note` line fragments fell from 2.4ms to 1.2ms while cold line, section, and block fragments stayed under their guardrails. |
| [List Notes Warm Path](list-notes-warm-path.md) | performance / agent workflows | stopped | A safe rendered-response cache missed the 8.7ms warm-call ship bar, so no runtime change shipped. |
| [Graph Neighbors Warm Path](graph-neighbors-warm-path.md) | performance / vault navigation | stopped | Traversal-only cleanup missed the 23.5ms warm-call ship bar, and higher fingerprint stat concurrency exceeded guardrails. |
| [Outlinks Warm Path](outlinks-warm-path.md) | performance / vault navigation | shipped | Warm 1,000-note `get_outlinks` fell from 40.2ms to 29.6ms while cold and mixed-output calls stayed under their guardrails. |
| [Orphan Discovery Warm Path](orphan-discovery-warm-path.md) | performance / vault hygiene | stopped | Simple stat-concurrency and derived-category prototypes missed the 24ms warm-call ship bar, so no runtime change shipped. |
| [Frontmatter Search Warm Path](frontmatter-search-warm-path.md) | performance / metadata workflows | shipped | Warm 1,000-note `search_by_frontmatter` fell from 93.1ms to 30.8ms while cold and folder-scoped calls stayed under their guardrails. |
| [Resolve Alias Warm Path](resolve-alias-warm-path.md) | performance / agent workflows | shipped | Warm 1,000-note `resolve_alias` fell from 86.6ms to 40.5ms while cold lookups and basename fallback stayed under their guardrails. |
| [Vault Stats Warm Path](vault-stats-warm-path.md) | performance / observability | shipped | Warm 1,000-note `get_vault_stats` fell from 94.6ms to 40.4ms while cold and folder-scoped calls stayed under their guardrails. |
| [Recent Notes Warm Path](recent-notes-warm-path.md) | performance / agent workflows | shipped | Warm 1,000-note `get_recent_notes` fell from 107.1ms to 27.5ms while cold and `since` calls stayed under their guardrails. |
| [Attachment Inventory Warm Path](attachment-inventory-warm-path.md) | performance / vault hygiene | shipped | Warm 1,000 attachment/note unused scans fell from 58.9ms to 39.3ms while cold scans and warm listings stayed under their guardrails. |
| [Canvas Read Warm Path](canvas-read-warm-path.md) | performance / Obsidian format coverage | shipped | Warm 1,000-node canvas reads fell from 6.9ms to 1.7ms while cold stayed under the guardrail. |
| [Tag Index Warm Path](tag-index-warm-path.md) | performance / retrieval quality | shipped | Warm 1,000-note sparse tag searches fell from 36.8ms to 22.5ms while warm `list_tags` and cold scans stayed under their guardrails. |
| [Bases Query Warm Path](bases-query-warm-path.md) | performance / Obsidian format coverage | shipped | Warm 1,000-note Base queries fell from 99.7ms to 54.1ms while cold stayed under the guardrail. |
| [Broken Link Warm Path](broken-link-warm-path.md) | performance / graph analysis | shipped | Warm 1,000-note broken-link scans fell from 222.7ms to 29.1ms while cold stayed under the guardrail. |
| [Link Graph Warm Path](link-graph-warm-path.md) | performance / graph analysis | shipped | Warm 1,000-note backlinks fell from 80.4ms to 42.5ms while cold graph traversal stayed under the guardrail. |
| [Search Cache Warm Path](search-cache-warm-path.md) | performance / retrieval quality | shipped | Warm 1,000-note search fell from 91.5ms to 23.2ms while cold stayed under the guardrail. |

Tracks to pull from: retrieval quality, agent workflows, Obsidian format coverage,
client compatibility, observability, local-first intelligence.
