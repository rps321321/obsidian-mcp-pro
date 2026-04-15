# Tool Authoring Guide

> Internal guide for contributors adding or editing MCP tools in this server.
> Every new tool should start A-grade (4.0+) on third-party quality scorers
> like [Glama](https://glama.ai). This document captures what we learned
> empirically across four iterations on v1.1.2.

## The baseline: what every tool must have

Every `server.registerTool(...)` call must include **all** of the following:

```ts
server.registerTool(
  "tool_name",                    // snake_case, verb_noun
  {
    title: "Human Display Name",  // Sentence case, no punctuation
    description: "<see § 1>",     // Multi-sentence, paragraph-length
    annotations: {                // § 2 — hints for MCP clients
      readOnlyHint: <boolean>,
      destructiveHint: <boolean>,
      idempotentHint: <boolean>,
      openWorldHint: false,       // always false for this server
    },
    inputSchema: {                // § 3 — Zod raw shape
      /* each param with .describe() and constraints */
    },
  },
  async (args) => { /* handler */ },
);
```

Omit any of these and expect to lose ~1.0–1.5 points off your score.

---

## § 1 — Description anatomy

**Minimum quality bar:** 2–4 sentences. A one-line description scores
C-grade even if the schema is perfect (empirically: 2.9–3.5/5).

A complete description answers **five questions**, in roughly this order:

| Question | Example from `find_broken_links` |
|---|---|
| **What does it do?** | "Scan notes for wikilinks whose target does not resolve" |
| **What's in the return value?** | "Returns a per-source report grouping each note with its broken link text and line numbers, plus a total count" |
| **When should you reach for it?** | "Use after renaming, moving, or deleting notes to catch dangling references" |
| **Any important edge cases?** | "Resolution uses the whole vault even when scanning a single folder" |
| **Cross-references to related tools?** | (implicit — mentions renaming/moving/deleting workflows) |

### Good description template

```
<What it does>. <What shape of data it returns>. <Primary use case>.
<Critical edge case or caveat>. <Related tool if applicable>.
```

### Anti-patterns

- ❌ `"Find all notes that contain a specific tag"` (one line, no return shape, no context)
- ❌ `"Delete a note"` (nothing about trash vs. permanent, nothing about link side-effects)
- ❌ Docstring-style (`@param path — the path`) — these go in `.describe()`, not the tool description

### When in doubt

Write the description as if explaining the tool to a colleague who has
never seen this codebase and has to pick between it and five similar tools.

---

## § 2 — Annotations cheatsheet

Every tool gets an `annotations` object. The flags are **hints** — MCP
clients may use them to surface confirmation UIs, cache results, or
reorder calls.

| Flag | Meaning | When `true` |
|---|---|---|
| `readOnlyHint` | Does not modify any state | Tool only reads the vault |
| `destructiveHint` | May destroy or overwrite user data | `delete_note`, `move_note`, `update_frontmatter` (overwrites keys) |
| `idempotentHint` | Calling N times ≡ calling once (same args → same final state) | All read-only tools; also `update_frontmatter` |
| `openWorldHint` | Interacts with external systems (network, shell, APIs) | Always `false` in this server (local filesystem only) |

### Decision matrix for this server's tools

| Category | readOnly | destructive | idempotent |
|---|---|---|---|
| `get_*`, `list_*`, `search_*`, `read_*`, `find_*` | `true` | (omit) | `true` |
| `create_*` | `false` | `false` | `false` (fails on second call) |
| `append_*`, `prepend_*` | `false` | `false` | `false` (content grows each call) |
| `update_frontmatter` | `false` | `true` | `true` (same payload → same state) |
| `move_note`, `delete_note` | `false` | `true` | `false` (source no longer exists) |
| `add_canvas_node`, `add_canvas_edge` | `false` | `false` | `false` (new UUID each call) |

### Subtle choices to watch for

- **`add_canvas_node` is NOT idempotent** — it generates a new UUID, so
  two identical calls produce two distinct nodes. Same for `add_canvas_edge`.
- **`update_frontmatter` IS idempotent** — our implementation does a spread
  merge, so the same payload always produces the same final frontmatter.
- **`move_note` is destructive** because the file at the old path ceases
  to exist (even though no bytes are lost).

---

## § 3 — Input schema guidelines

We use Zod raw shape (object literal of Zod fields) because the SDK is on
the v1 API. When the server migrates to MCP SDK v2, these will need to be
wrapped in `z.object({...})` — the field definitions themselves stay the same.

### Every parameter MUST have `.describe()`

```ts
// ❌ BAD
folder: z.string().optional(),

// ✅ GOOD
folder: z
  .string()
  .optional()
  .describe("Restrict search to this folder relative to the vault root (omit to search entire vault)"),
```

### Add every applicable constraint

| Constraint | Use it for |
|---|---|
| `.min(1)` | Required non-empty strings (paths, queries, ids) |
| `.int()` | Integer counts (`maxResults`, `depth`, `width`, `height`) |
| `.min(N).max(M)` | Numeric bounds with clear rationale (e.g. depth 1–5) |
| `.enum([...])` | Finite choice sets (`sortBy`, `direction`, node `type`) |
| `.regex(/pattern/, "message")` | Structured strings (e.g., `YYYY-MM-DD` dates) |
| `.optional().default(X)` | Optional with a sensible fallback |

### Parameter description template

Keep each `.describe()` to one sentence, and include:

1. **Semantics** (what the value means, not just its type)
2. **Default value** if optional (`default: 20`)
3. **Range or examples** when non-obvious (`1-500`, `'YYYY-MM-DD'`, `'folder/note.md'`)
4. **Cross-references** to other params if they interact

#### Example of a rich parameter description

```ts
depth: z
  .number()
  .int()
  .min(1)
  .max(5)
  .optional()
  .default(1)
  .describe("Maximum link-hops to traverse from the start note (1-5, default: 1). Higher values explore further but can return many notes."),
```

All four things are there: range, default, semantics, tradeoff.

---

## § 4 — Handler conventions

Keep handlers thin. The scorer doesn't see handler code, but reviewers do:

- Use the shared `errorResult(text)` helper at the top of each file.
- Catch errors, log to `console.error`, return `isError: true`.
- Text output should be human-readable (grouped, with counts/summaries) —
  not raw JSON — because LLMs will re-parse this.
- When a result is empty, still return a friendly message
  (`"No backlinks found for: ..."`), not just `content: []`.

---

## § 5 — Self-check before PR

Before opening a PR for a new or edited tool, verify:

- [ ] `title` is set and is a proper sentence-case display name
- [ ] `description` is at least two sentences and answers the five questions in § 1
- [ ] `annotations` object includes all four hint flags (or explicit omissions)
- [ ] Every input parameter has a `.describe()` with defaults/examples where useful
- [ ] Optional numeric params have `.int().min().max()` where applicable
- [ ] Handler returns a friendly message on empty results
- [ ] Handler returns `isError: true` on failure
- [ ] `npm test` passes (122+ tests)
- [ ] `npx tsc --noEmit` is clean
- [ ] CHANGELOG.md has an entry under the `[Unreleased]` section

---

## § 6 — Appendix: what the scorer rewards

Empirical findings from the v1.1.2 scoring sweep (3.14 → 4.40 average,
+40% on a 23-tool surface):

1. **Description length and specificity has the largest weight.** Going
   from `"Find all notes that link to a specific note"` to a 4-sentence
   paragraph reliably moves a tool from ~2.9 to ~4.4.
2. **`title` and `annotations` each add roughly +0.5** regardless of
   description quality. The two tools that only got these (before their
   descriptions were also rewritten) moved 3.5 → 4.0.
3. **Schema constraints matter less than description prose** but show up
   in the margin — tools with `.int().min().max()` and rich `.describe()`
   on every param cluster at 4.4–4.7, while tools that merely got a good
   description cluster at 4.2–4.4.
4. **Tools with no parameters are not penalized** if description + title +
   annotations are solid (`list_canvases` hit 4.7 with `inputSchema: {}`).
5. **`destructiveHint: true` does not appear to be penalized.** `delete_note`
   scored 4.5 despite (because of?) the destructive hint.

If these heuristics stop matching reality in a future scorer version,
update this doc — that's its job.
