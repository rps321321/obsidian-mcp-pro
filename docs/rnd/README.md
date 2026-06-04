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
| [Search Cache Warm Path](search-cache-warm-path.md) | performance / retrieval quality | shipped | Warm 1,000-note search fell from 91.5ms to 23.2ms while cold stayed under the guardrail. |

Tracks to pull from: retrieval quality, agent workflows, Obsidian format coverage,
client compatibility, observability, local-first intelligence.
