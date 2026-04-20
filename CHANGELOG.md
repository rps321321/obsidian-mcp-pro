# Changelog

All notable changes to `obsidian-mcp-pro` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-04-21

### Changed (behavior — user-observable)

- **Wikilink resolution** now falls back to frontmatter `aliases` when no
  filename/path/basename match is found. `[[My Project]]` resolves to a
  note whose frontmatter declares that alias. Fixes `find_orphans`
  reporting alias-linked notes as orphans. `aliases`, `Aliases`, and
  `ALIASES` keys are all recognized.
- **Wikilink basename tie-break** now prefers the candidate closest (by
  shared directory prefix) to the linking note, then falls back to
  shortest vault path on ties. Previously picked the shortest path from
  vault root unconditionally, which could resolve `[[foo]]` to an
  unrelated same-name note.
- **Daily-note filename format** supports the full moment.js token set
  Obsidian uses: `YYYY/YY`, `MMMM/MMM/MM/M/Mo`, `DDDD/DDD/DD/D/Do`,
  `dddd/ddd/dd`, `HH/H/hh/h`, `mm/m`, `ss/s`, `Q`, and `[literal]`
  bracket escapes. Previous implementation only handled `YYYY/MM/DD` and
  silently produced literal unresolved filenames for other formats.
- **Frontmatter tag/alias extraction** probes common YAML key casings
  (`tags`/`Tags`/`TAGS`, `tag`/`Tag`, `aliases`/`Aliases`/`ALIASES`).
  Hand-edited vaults no longer silently lose metadata.
- **`update_frontmatter` description** clarifies that YAML comments,
  quoting, ordering, and blank lines are normalized on update (key
  presence and values are preserved; formatting is not).

### Fixed

- **Canvas round-trip fidelity**: `updateCanvasFile` now preserves
  unknown top-level keys (`viewport`, future metadata) instead of
  narrowing to `{nodes, edges}` and dropping the rest on the first
  `add_canvas_node` / `add_canvas_edge` call.

### Tests / CI

- New `security.test.ts`, `http-server.test.ts`, `semantics.test.ts`
  (31 new tests). Coverage now includes symlink escape, case-only
  rename deadlock, bearer auth paths, oversize body, alias/proximity
  wikilink resolution, full moment-token date formatting, and canvas
  round-trip.
- CI matrix expanded to Ubuntu / macOS / Windows × Node 20 / 22, with
  `CI_SYMLINKS=1` enabling symlink regression tests on Windows runners.

## [1.3.3] - 2026-04-21

### Security

- **Central error sanitizer** (`lib/errors.ts`) — filesystem error
  messages no longer leak absolute host paths to MCP clients. Errno
  codes collapse to generic messages.
- **HTTP 500 responses** return a generic body; full detail stays in
  server logs (no SDK internals / file paths on the wire).

### Reliability

- **`moveNote` case-rename deadlock fixed** — when source/dest share
  a lock key (`Note.md` → `note.md` on macOS/Windows), a single lock
  is taken instead of nesting.
- **`writeNote({ exclusive: true })`** does an explicit case-aware
  collision probe on case-insensitive filesystems so `Note.md` cannot
  silently overwrite `note.md`.
- **`prependToNote` frontmatter scan** replaced with a bounded
  line-walker (500 lines / 64 KB cap) — no more event-loop stall on
  malformed or multi-MB notes.
- **HTTP session sweeper** — 1 h idle TTL, 5 min interval, unref'd
  timer; prevents transport/McpServer leaks from dropped clients.
- **Oversize POST body** drains cleanly and returns a proper 413 (no
  `req.destroy()` race against the response writer).

### Performance

- **Tag tools** (`get_tags`, `search_by_tag`) use a bounded-concurrency
  pool (16) via new `lib/concurrency.ts` — previously serial reads.
- **`install.ts` config write is atomic** — temp file + rename, so
  Claude Desktop or a concurrent editor never observes a half-written
  manifest.

## [1.3.2] - 2026-04-20

### Security

- **Symlink escape closed** in the `note` MCP resource (previously
  used the unchecked sync resolver). All tools already used the async
  realpath-checked variant.
- **Trash realpath check** in `deleteNote` — prevents a symlinked
  `.trash` from escaping the vault.
- **Absolute host path removed** from `NoteMetadata` struct (info
  disclosure).
- **`realVaultCache` dropped** — eliminates staleness when the library
  API is re-used with different vault paths.
- **Timing-safe Bearer compare** via `crypto.timingSafeEqual`.
- **Async daily-notes config read** (was sync `fs` inside async
  handlers).
- **Canvas `color` validation** — regex enforces `'1'-'6'` or hex.

### Fixed

- **`withFileLock` error chaining** clarified — prior rejections no
  longer masquerade as success.
- Dead double-cap removed in `searchNotes`.

## [1.3.1] - 2026-04-18

### Fixed

- **Tools now always registered**: previously, running the server without
  a configured vault skipped tool registration entirely, which made MCP
  registries (Glama, etc.) report "No tools detected" since they inspect
  servers without a vault. Tools now register unconditionally — the
  existing vault-path check inside `resolveVaultPath` returns a clean
  "Vault path is not configured" error at call time. Security posture
  unchanged: the single choke point still rejects empty vault paths.

## [1.3.0] - 2026-04-18

### Added

- **Programmatic API**: `buildMcpServer(vaultPath)` and `startHttpServer(opts)`
  are now exported from the package for library use (e.g. embedding the
  server inside an Obsidian plugin). CLI behavior is unchanged; `main()`
  only auto-runs when the file is the process entrypoint.
- `startHttpServer` now returns an `HttpServerHandle` with `{ host, port,
  url, stop() }` and accepts `installSignalHandlers` (default `true`).
  Embedders should pass `false` so stopping the server doesn't kill the
  host process via SIGINT/SIGTERM handlers or `process.exit`.

## [1.2.0] - 2026-04-18

### Added

- **HTTP (Streamable HTTP) transport**: new `--transport=http` flag spins up
  an MCP-over-HTTP server at `/mcp` on `127.0.0.1:3333` by default.
  Supports per-session state via `Mcp-Session-Id` header, CORS, optional
  bearer-token auth (`--token=...` or `MCP_HTTP_TOKEN`), a `/health`
  endpoint, and DNS rebinding protection. Unlocks remote clients (Cursor,
  ChatGPT MCP, web) that can't speak stdio.
- **One-command install**: new `obsidian-mcp-pro install` subcommand merges
  an `mcpServers` entry into Claude Desktop's `claude_desktop_config.json`
  (or Cursor's `~/.cursor/mcp.json` with `--client=cursor`). Backs up the
  existing config, detects the right path per-OS, accepts `--vault`,
  `--vault-name`, and `--name` flags.
- **CLI help + version**: `--help` / `--version` flags.

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
