# Changelog

All notable changes to `obsidian-mcp-pro` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] - 2026-04-27

> Vault-wide link rewriting on `move_note` filed in
> [#3](https://github.com/rps321321/obsidian-mcp-pro/issues/3), implemented
> in [#4](https://github.com/rps321321/obsidian-mcp-pro/pull/4), and
> additional hardening contributed by
> [@brentkearney](https://github.com/brentkearney) during review.

### Changed

- **`move_note` now updates references across the vault by default**, matching
  Obsidian's "Automatically update internal links" behavior. Wikilinks
  (`[[old]]`, `![[old]]`, with aliases and `#heading` / `#^block-id`
  fragments preserved), markdown links (`[text](old.md)` and the
  extension-less form), and canvas `nodes[].file` fields all follow the
  move. The link form is preserved when possible — a bare `[[idea]]`
  stays bare when the basename remains unambiguous post-move, and falls
  back to the path form (`[[archive/idea]]`) when it doesn't.
  Pass `updateLinks: false` to skip the rewrite scan (faster on huge
  vaults, or when the caller is doing its own bookkeeping).
  Addresses the `move_note` half of
  [#3](https://github.com/rps321321/obsidian-mcp-pro/issues/3);
  `delete_note` reference handling is tracked separately.

### Added

- `MoveNoteOptions` and `MoveNoteResult` exported from `lib/vault.ts`. The
  result reports per-file counts of rewritten and failed referrers so
  callers can surface partial-failure cases. The rename itself stays
  committed if the rewrite phase encounters a per-file failure — failures
  are surfaced rather than rolled back.
- `lib/link-rewriter.ts` (`planMoveRewrites`, `applyRewrites`): pure
  planner + applier split for testability. Reuses the existing
  Obsidian-faithful `resolveWikilink` so a link is only rewritten when it
  actually pointed at the moved file pre-move (handles basename
  collisions and proximity tie-breaking correctly).
- `lib/markdown.ts`: `extractWikilinkSpans`, `extractMarkdownLinkSpans`
  (offset-preserving variants of `extractWikilinks` for in-place
  rewriting), and `formatWikilinkTarget` (form-preserving target picker).
- `lib/errors.ts`: `escapeControlChars` for sanitizing caller-controllable
  strings before they reach tool output. Also applied internally by
  `sanitizeError`, so every existing call site gets the same protection
  against control-char injection (e.g. attacker-controlled filenames
  containing `\n` smuggling text into LLM context).

### Security

- TOCTOU correctness in `move_note` reference rewriting:
  `applyEditsBackToFront` now verifies each edit's expected pre-edit
  content before splicing. A parallel `write_note` between plan and apply
  is surfaced in `failedReferrers` rather than corrupting referrer files
  silently.

### Fixed

- Inline-code detection in the link extractor handles N-backtick spans
  (not just single-backtick) and 4-space / tab indented code blocks per
  CommonMark, so wikilinks inside code samples are no longer rewritten
  when their containing notes are moved.

## [1.5.3] - 2026-04-25

### Tests

- **Handler-level integration test suite.** 72 new tests covering every
  registered MCP tool via `Client` + `McpServer` linked by an
  `InMemoryTransport` pair — the tests exercise tool handlers through
  the real MCP protocol, covering zod schema validation, JSON argument
  parsing (`create_note.frontmatter`, `update_frontmatter.properties`),
  `ensureMdExtension` normalization, `isError: true` error shaping,
  canvas file-reference validation, and the parallelized
  `search_by_frontmatter` rewrite. Lives under
  `src/__tests__/handlers/` with a shared harness that spins up a
  fixture vault per test. Total suite is now **254 tests**, up from 182.

## [1.5.2] - 2026-04-25

### Security / Fixed

- **MCP log-forward no longer leaks absolute host paths to clients.**
  `notifications/message` payloads pass through `stripPaths` so remote
  clients never see the operator's host filesystem layout (`vault`,
  `configPath`, and serialized-error stack traces are all covered).
  Stderr keeps full detail for operator debugging. Regression introduced
  by the logging capability in 1.5.1.
- **`add_canvas_node` file reference now realpath-checked.** Swapped the
  sync `resolveVaultPath` for `resolveVaultPathSafe` so a symlinked path
  that escapes the vault is rejected at the same gate as every other
  write tool.
- **Reject Windows DOS device names** (`CON`, `PRN`, `AUX`, `NUL`,
  `COM0-9`, `LPT0-9`) at the path resolver on win32. Previously
  `create_note path="NUL.md"` on Windows silently bound to the null
  device and discarded the write. No-op on POSIX.

### Tests

- +6 tests covering the three fixes (182 pass, up from 176).

## [1.5.1] - 2026-04-25

### Added

- **MCP `logging` capability.** The server now declares the `logging`
  capability and forwards every log line to connected clients via
  `notifications/message`, alongside the existing stderr output. Levels
  map to RFC 5424 syslog (internal `warn` → wire `warning`). Clients that
  honor `logging/setLevel` can filter server-side logs at runtime without
  restarting. Forwarding is best-effort: if the transport is disconnected
  or the send rejects, the error is swallowed so logging can never be the
  failure mode of a tool call.

### Changed

- **Consistent structured logging across all tool handlers.** Replaced
  ~40 `console.error` / `console.warn` sites across `src/tools/*.ts` and
  `src/config.ts` with the leveled `log` helper. `LOG_FORMAT=json` now
  emits homogeneous JSON lines with no unstructured stderr interleaved
  from tool error paths.
- **Parallelized `search_by_frontmatter`.** Note reads now fan out with
  concurrency 16 via `mapConcurrent`, matching peer scan tools. On 10k+
  note vaults this cuts tool latency by roughly an order of magnitude
  versus the prior sequential loop.

### Fixed

- **Misleading "per-session McpServer" comment** in `src/index.ts` that
  claimed the HTTP path builds one server per session. The code actually
  matches the canonical MCP SDK pattern (one `McpServer`, one transport
  per session). Comment corrected; behavior unchanged.

## [1.5.0] - 2026-04-21

### Added

- **Atomic note writes.** Every mutating operation (`create_note`, `append`,
  `prepend`, `update_frontmatter`, canvas add-node/add-edge) now stages
  content to a sibling temp file and renames onto the target. A crash or
  `SIGKILL` mid-write can no longer leave a truncated file — readers see
  either the prior version or the full new one. Windows `EPERM`/`EBUSY`/
  `EACCES` from briefly-locked targets are retried with linear backoff (up
  to ~315ms).
- **`create_note` exclusive mode uses OS-level `wx`** so an out-of-process
  writer (Obsidian itself, a sync client, a second MCP server) can no
  longer slip between the existence check and the write and get silently
  overwritten.
- **Parallel vault scans.** `search_notes` and the `obsidian://tags`
  resource now fan out reads with bounded concurrency (8-way). Large
  vaults (10K+ notes) see order-of-magnitude latency drops. `search_notes`
  tie-breaks equal-score results by relative path for deterministic output.
- **Leveled logger** (`src/lib/logger.ts`) with `debug`/`info`/`warn`/
  `error`/`silent` levels and `text`/`json` modes, configurable via
  `LOG_LEVEL` and `LOG_FORMAT` env vars. All logs go to stderr — stdio
  transport on stdout is never polluted.
- **HTTP rate limiting.** New `--rate-limit=<n>` flag caps requests per
  minute per client IP (IPv4-mapped IPv6 normalized to share a bucket).
  Returns `429 Too Many Requests` with `Retry-After: 60`. `/health` and
  `/version` are exempt.
- **CORS allowlist.** New `--allow-origin=<csv>` flag restricts browser
  origins. `Vary: Origin` is always set when an allowlist is configured so
  shared caches never pin one origin's response to another's request.
  Defaults to `*` for back-compat.
- **`GET /version` endpoint** returning `{ version }` for rollout auditing.
  `/health` now also includes the package version.
- **HTTP request timeout** of 2 minutes for POST requests. GET (long-lived
  SSE streams) and DELETE are exempt so valid idle clients aren't reaped.
- **Process-level error backstops.** `uncaughtException` logs + exits 1
  (so supervisors restart cleanly); `unhandledRejection` logs without
  killing the process. CLI-only — library embedders aren't affected.

### Fixed

- **Data-loss race on concurrent writes.** `fs.writeFile` truncates then
  writes; under a crash/OOM/kill mid-flight this left notes partially
  written or zero-byte. Atomic tmp+rename now rules this out.
- **Windows `fs.rename` EPERM** when another handle has the target open
  for read — previously surfaced to callers, now retried transparently.
- **`search_notes` leaked relative note paths** to stderr on read failure.
  Removed; per-item errors are swallowed by `mapConcurrent` without
  emitting paths.
- **`search_notes` tie-break was non-deterministic** (depended on fan-out
  completion timing under parallel scan). Stable secondary sort by path.

### Changed

- **`search_notes` no longer stops at the first N matching notes.** Old
  behavior produced non-deterministic top-N under walk order; new
  behavior scans all, ranks by score with path tiebreaker, then slices.

## [1.4.1] - 2026-04-21

### Fixed

- **Silent exit on startup under `npx`** (regression introduced in 1.3.0).
  The CLI-entry guard compared `process.argv[1]` (not symlink-dereferenced)
  against `import.meta.url` (which Node's ESM loader already dereferences).
  When launched via `npx -y obsidian-mcp-pro`, the `.bin` symlink caused
  the comparison to fail, so `main()` never ran and the process exited
  with code 0 after receiving `initialize`. Both sides now compare real
  paths via `fs.realpathSync`. Fixes #2.

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
