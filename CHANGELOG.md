# Changelog

All notable changes to `obsidian-mcp-pro` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.4] - 2026-04-18

### Security

- **Symlink escape from vault boundary**: `resolveVaultPath` relied on
  `path.resolve` which strips `..` syntactically but does NOT follow
  symlinks — a symlink inside the vault pointing outside could leak
  arbitrary host files through `readFile`. New async
  `resolveVaultPathSafe` calls `fs.realpath` on the deepest existing
  ancestor and re-verifies the boundary against a cached realpath of
  the vault root. Applied to every read/write/stat/rename entry point.
- **Canvas `file` node accepted arbitrary path as reference**:
  `add_canvas_node` with `type: "file"` stored the raw `content` string
  as `node.file` with no boundary check. Traversal strings like
  `../../etc/passwd` could be persisted in canvas JSON and surfaced
  back to clients. Now validated via `resolveVaultPath`.
- **`create_daily_note` template slot read non-markdown vault files**:
  `templatePath` was passed unmodified to `readNote`. Excluded dirs
  (`.obsidian`/`.trash`/`.git`) were already blocked, but `.canvas`,
  `.json`, or other in-vault files were readable through this slot.
  Now coerced to `.md` via `ensureMdExtension`.
- **Absolute host path leak in search results**: `searchNotes` returned
  the fully resolved filesystem path alongside `relativePath`,
  disclosing host directory layout to MCP clients. Now returns the
  relative path only.

### Fixed

- **Stale link-graph cache on mtime-preserving churn**: fingerprint was
  `count:maxMtime`, which missed add+delete within the same second and
  edits that restored a previous maximum mtime. Replaced with an
  FNV-1a hash over sorted `path|mtime` entries.

## [1.1.3] - 2026-04-18

### Fixed

Robustness pass targeting concurrency, TOCTOU, and error-tolerance gaps in
the vault and tool layer. All fixes are internal; no API changes.

- **Path traversal through excluded dirs**: `resolveVaultPath` now rejects
  any path whose resolved form traverses `.git`, `.obsidian`, or `.trash`
  at any depth — previously only the root level was checked.
- **Unconfigured-vault CWD leak**: when no vault is configured, tools are
  no longer registered at all. Previously, an empty vault path caused
  path-traversal guards to resolve against the process CWD.
- **Nested excluded dirs exposed by walker**: `walkVault` prunes excluded
  directory names at every depth, not just the vault root.
- **Concurrent write loss**: per-file locks (`withFileLock`) now cover
  `writeNote`, `deleteNote`, and `moveNote` in addition to
  `appendToNote`/`prependToNote`. Lock keys are normalized on
  case-insensitive filesystems (Windows, macOS). `moveNote` acquires
  source+destination locks in sorted order to prevent deadlock.
- **Non-atomic read-modify-write**: new `updateNote` and
  `updateCanvasFile` helpers lock across the full read/transform/write
  sequence. Used by `update_frontmatter`, `add_canvas_node`, and
  `add_canvas_edge` so concurrent mutations can't lose each other's
  changes.
- **TOCTOU in create paths**: `writeNote` gained an `{ exclusive }`
  option that uses the `wx` flag for atomic create. `create_note` and
  `create_daily_note` now rely on this instead of a pre-existence check.
- **Canvas writer unlocked**: `writeCanvasFile` now takes the file lock
  (was missing while `writeNote` had one).
- **Malformed YAML aborting vault-wide scans**: `parseFrontmatter`
  returns empty data on parse failure instead of throwing, so a single
  note with broken frontmatter can't break `get_tags`, `search_by_tag`,
  or `search_by_frontmatter`.
- **Graph cache LRU eviction of hot entries**: `buildLinkGraph` now
  refreshes cache recency on hit and caps the cache at 32 entries.
- **Dead `ensureNewline` param** removed from `append_to_note` schema
  (was declared but never wired through).

## [1.1.2] - 2026-04-15

### Changed

Substantial upgrade of the tool surface presented to MCP clients. No runtime
behavior changed — every improvement is metadata that helps LLMs pick the
right tool, pass the right arguments, and interpret results correctly.

- **All 23 tool descriptions rewritten** to convey return shape, use cases,
  edge cases, and cross-references to related tools. Previously many read as
  one-line summaries (e.g. `"Find all notes that link to a specific note"`);
  they now describe what's returned, when to use them, and how they interact
  with other tools.
- **Zod schemas tightened** with `.int()`, `.min()`, `.max()`, and `.regex()`
  constraints where applicable (e.g. `maxResults`, date formats, node
  dimensions). Parameter `.describe()` calls now include concrete examples
  and default values.
- **`title` field added to every tool** — human-readable display name
  separate from the machine-readable tool `name`, per MCP SDK best practices.
- **`annotations` added to every tool** with appropriate `readOnlyHint`,
  `destructiveHint`, `idempotentHint`, and `openWorldHint` flags. This lets
  well-behaved MCP clients surface confirmation prompts before destructive
  operations (`delete_note`, `move_note`, `update_frontmatter`) and safely
  cache or reorder read-only ones.

### Measured impact

On [Glama's](https://glama.ai) tool-quality scorer:

- **Average score:** 3.14 / 5 → **4.40 / 5** (+40%)
- **All 23 tools now A-grade** (4.0+), up from 2 A's, 9 B's, and 12 C's
- **Biggest individual lift:** `list_canvases` 3.1 → 4.7 (+1.6)

## [1.1.1] - Previous release

- Code review hardening and performance fixes ([`3615e82`](https://github.com/rps321321/obsidian-mcp-pro/commit/3615e82))
- See git history for details prior to this changelog.

[1.1.3]: https://github.com/rps321321/obsidian-mcp-pro/releases/tag/v1.1.3
[1.1.2]: https://github.com/rps321321/obsidian-mcp-pro/releases/tag/v1.1.2
[1.1.1]: https://github.com/rps321321/obsidian-mcp-pro/releases/tag/v1.1.1
