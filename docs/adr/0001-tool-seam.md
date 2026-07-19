# ADR 0001: One deep tool seam behind every MCP tool

- Status: Accepted (read group migrated as the pattern-setter, canvas group migrated next; 7 groups to follow)
- Date: 2026-07-18

## Context

The server exposes 41 tools across 9 groups. Each tool lived in its own file
and re-implemented the same recipe inline:

- a terminal `try/catch` that logged `"<tool> failed"` and returned
  `errorResult(\`Error <verb>: ${sanitizeError(err)}\`)`, and
- manual wrapping of every vault-derived string via
  `formatUntrustedVaultContent` + `untrustedVaultContentMeta`.

The consequences:

- The error boundary was copied 41 times; `errorResult` was defined 9 times,
  `display*Value` 9 times, the `untrusted*Block` helper 6 times, `textResult`
  5 times.
- Two security concerns had **no single choke point**. Error-response
  sanitization was smeared: `errorResult` takes pre-formatted text and does not
  sanitize, so any handler writing `errorResult(\`...: ${err}\`)`leaks raw
paths or secrets. Untrusted-content wrapping was smeared across ~45 call
sites and applied inconsistently; a new handler returning a plain`{ type: "text", text }` would compile and silently emit vault text as if it
  were trusted.
- One tool bypassed the choke point: `add_canvas_edge`'s inner catches returned
  `err.message` directly — locally escaped via `displayCanvasValue`, but never
  routed through `sanitizeError`, so the pattern (not those specific messages)
  was one edit away from surfacing an unsanitized host path or secret.

By contrast, the **log** channel already sanitizes inside `emit()` (a choke
point), and permissions enforce at a single point in the vault layer. The
error-response and trust-wrapping channels were the outliers.

## Decision

Introduce a **tool seam** (`src/lib/tool-seam.ts`): one deep module every tool
is registered through. `defineTool(server, vaultPath, spec, handler)` owns
registration, context assembly, the error boundary, and result rendering.
Handlers become schema plus pure logic that return a `ToolResult` or throw.

### Enforcement by construction

`ToolResult` is a branded type. A raw `{ content: [...] }` literal does not
satisfy it, so the only way to surface model-readable vault text is through the
vocabulary's constructors, which wrap it. There is no raw-text escape hatch.

### Result vocabulary (frozen shape)

Text (used by the read group):

- `text(body)` - one trusted, unwrapped text block.
- `untrustedText(label, body)` - one block that is entirely untrusted vault
  text; wraps it and attaches the trust `_meta`.
- `richText(itemTrustLabel, build)` - one block mixing `b.trusted(line)` framing
  with `b.untrusted(label, body, indent?)` sections; the block-level `_meta` is
  attached only if at least one untrusted section was appended.
- `error(message)` - a verbatim, server-authored error block.
- `asError(result)` - flag a built result as an error (e.g. an error message
  that carries an untrusted path).

Non-text blocks (to be added when the attachments/canvas groups migrate;
`get_attachment` is the only multi-type tool): `image`, `audio`, `blobResource`,
`untrustedResource`. The block taxonomy is closed - no tool uses
`structuredContent`/`outputSchema`, and every result `_meta` is trust metadata.

### Context

`defineTool` passes `ctx = { vaultPath, server, extra }`. Read handlers use only
`vaultPath`; elicitation tools use `server`; progress tools use the raw `extra`
(progress-reporter construction stays a handler concern).

### Error model

- Thrown (unexpected): the seam logs `"<name> failed"` and returns
  `Error: ${sanitizeError(err)}` - a single **generic** prefix. Sanitization is
  now always applied.
- Domain (expected/validation): handler-authored messages via `error` /
  `asError`, passed through verbatim (already control-char-escaped by the
  handler); the seam does not re-sanitize them.

## Consequences

- Trust-wrapping and error sanitization become choke points. With the canvas
  group migrated, `add_canvas_edge`'s **unexpected**-error path now routes
  through the seam's single `sanitizeError` boundary (it was returned
  unsanitized before). Its **expected** validation messages (missing/duplicate
  node, self-loop) stay handler-authored and verbatim per the error model —
  control-char escaped via `displayCanvasValue`, not re-sanitized. So the
  closure is structural: no tool-layer terminal catch emits an unsanitized
  message anymore. Pinned by a `handlers/canvas.test.ts` case that drives an
  unexpected failure and asserts the generic sanitized result.
- Output is **byte-preserving**. The seam reuses the existing `tool-output.ts`
  primitives, so every `regression-tools-*` and `handlers/*` interface test
  stays green unchanged. One intentional exception is recorded: the generic
  thrown-error prefix replaces per-tool verbs (thrown path only; no test pins
  the wording).
- `docs/TOOL_AUTHORING.md §4` is superseded: handlers no longer write the recipe.
  The per-tool `title`/`description`/`annotations`/`inputSchema` surface is
  unchanged.
- Trade-off: a shared seam is one more module to trace than a fully
  self-contained handler file. Accepted because error and trust behaviour is now
  learned in one place, and that is where correctness lives.

## Verification gates (proven on the read group before fan-out)

1. **Zod arg inference survives.** `defineTool` is generic over the input schema
   (`InputArgs extends ZodRawShapeCompat`) and types handler `args` as the SDK's
   own `ShapeOutput<InputArgs>`, so per-tool argument types are preserved and do
   not degrade to `any`.
2. **The builder reproduces the hairiest layouts.** Verified against the
   independent-label case (`search_notes`), conditional `_meta`
   (`get_vault_stats`, `list_notes`), dynamic item label (`resolve_alias`), and
   an untrusted-carrying error (`get_daily_note`). The `index_vault`
   failed-paths block (indented, wrapped, item `_meta`) is expressible via
   `richText` + `b.untrusted(..., indent)` and will be exercised when the
   semantic group migrates.

## Note for migrating the semantic/progress group

`defineTool` casts its callback (`cb as unknown as ToolCallback<InputArgs>`)
because `ToolCallback` is an unreduced conditional over the generic shape. That
cast disables type-checking at the `extra` boundary. The read group never reads
`ctx.extra`, so it is inert here — but when the semantic group migrates and
actually uses `extra.sendNotification` / `extra._meta.progressToken`, the
compiler will not catch mis-threaded `extra`. Verify that plumbing at runtime
(a progress-notification test) when converting that group.

## Migration

Read group first (pattern-setter), canvas group next. The canvas group is all
text, so it migrated using only the existing `text`/`richText`/`error`
constructors and needed no seam changes; its conversion routes
`add_canvas_edge`'s unexpected-error path through the seam's sanitize boundary
(see Consequences). Remaining 7 groups are file-disjoint and convert
independently, deleting each group's duplicated recipe helpers as it goes and
extending the seam with the non-text block constructors when the attachments
group migrates. Collapsing the 9 `display*Value` aliases to a single
`escapeControlChars` import is a follow-up sweep. `TOOL_AUTHORING.md §4` is
rewritten last, once the pattern is proven across all groups.
