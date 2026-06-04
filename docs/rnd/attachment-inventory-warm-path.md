# Attachment Inventory Warm Path

_Status: shipped_
_Started: 2026-06-04 - Decided: 2026-06-04_

## Hypothesis

`find_unused_attachments` already reads markdown notes through the shared content
cache, but it rebuilds attachment sets, basename indexes, and reference sets on
repeat calls. A small metadata-keyed attachment inventory cache may cut the
1,000 attachment/note warm unused scan by at least 20% without changing
extension filtering, reference resolution, unused counts, byte reporting,
progress updates, or displayed output.

## Fixture

Bench command:

```powershell
npm run build
node scripts\bench-attachments.mjs 100,1000 --json
```

The harness creates temporary vaults with 100 or 1,000 attachments and the same
number of markdown notes. Attachments are spread across nested asset folders and
mixed `.png`, `.jpg`, `.webp`, and `.pdf` extensions. Notes reference a subset
with both wikilink embeds and markdown image links, leaving a realistic unused
set. It calls `list_attachments` twice, then calls `find_unused_attachments`
twice through a real stdio MCP client.

Baseline captured on 2026-06-04:

| attachments + notes | cold list_attachments | warm list_attachments | cold find_unused_attachments | warm find_unused_attachments |
|---:|---:|---:|---:|---:|
| 100 | 9.6ms | 5.9ms | 23.8ms | 12.0ms |
| 1,000 | 17.3ms | 9.4ms | 83.6ms | 58.9ms |

## Metric

Primary metric: 1,000 attachment/note warm `find_unused_attachments` wall time.

Ship bar: warm `find_unused_attachments` at or below 47ms (20% faster than the
58.9ms baseline), with 1,000 attachment/note cold `find_unused_attachments` no
worse than 92ms and warm `list_attachments` no worse than 11ms. Attachment
ordering, extension summaries, unused counts, reference matching, optional byte
totals, progress labels, and displayed paths must stay unchanged.

| | before | after |
|---|---:|---:|
| 1,000 attachment/note warm find_unused_attachments | 58.9ms | 39.3ms / 31.6ms |
| 1,000 attachment/note cold find_unused_attachments guardrail | 92ms | 72.3ms / 60.4ms |
| 1,000 attachment/note warm list_attachments guardrail | 11ms | 7.7ms / 7.1ms |

## Safety review

Data accessed: synthetic temporary markdown notes and attachment files generated
by `scripts/bench-attachments.mjs`. No real vault content, secrets, network
calls, or embedding providers are involved.

Writes performed: temporary fixture vault creation and deletion only. The
prototype adds in-memory attachment inventory metadata; it preserves
vault-boundary checks, permission filtering, excluded-folder handling, mtime
invalidation, MIME/security checks in `get_attachment`, and raw attachment bytes.

Logs emitted: normal stdio server startup logs with temporary vault paths. No
note body or attachment bytes are logged.

Rollback path: drop the prototype and keep direct attachment listing and note
reference scanning per call.

## Kill criterion

Stop if the warm unused scan improves by less than 20%, if cold unused scans or
warm attachment listings exceed their guardrails, if unused counts change, or if
referenced attachments are marked stale after note or attachment edits.

## Decision

Ship. `find_unused_attachments` now keeps a small in-memory attachment inventory
cache keyed by the current attachment list and note mtimes. Repeat scans reuse
the derived basename/reference sets after a stat-only note fingerprint check, so
the warm path skips note content reads while still invalidating on note or
attachment changes. Exact attachment matching also uses a lowercase path index
instead of scanning every attachment for every reference. Repeated 1,000
attachment/note warm unused scans landed at 39.3ms and 31.6ms against the 47ms
ship bar, cold scans stayed at 72.3ms and 60.4ms against the 92ms guardrail, and
warm `list_attachments` stayed at 7.7ms and 7.1ms against the 11ms guardrail.
