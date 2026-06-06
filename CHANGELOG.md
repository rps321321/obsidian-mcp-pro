# Changelog

All notable changes to `obsidian-mcp-pro` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Active R&D experiment for frontmatter key quality, with a synthetic `search_by_frontmatter` fixture in `scripts/bench-frontmatter-key-quality.mjs` and ship/kill metric in `docs/rnd/frontmatter-key-quality.md`.
- R&D experiment for lexical search ranking quality, with a synthetic `searchInContents` fixture in `scripts/bench-search-ranking-quality.mjs` and ship/kill metric in `docs/rnd/search-ranking-quality.md`.
- R&D experiment for lexical search snippet quality, with a synthetic `searchInContents` fixture in `scripts/bench-search-snippet-quality.mjs` and ship/kill metric in `docs/rnd/search-snippet-quality.md`.
- R&D experiment for lexical search snippet length, with a synthetic `searchInContents` fixture in `scripts/bench-search-snippet-length.mjs` and ship/kill metric in `docs/rnd/search-snippet-length.md`.
- R&D experiment for similar-note quality, with a synthetic embedding-store fixture in `scripts/bench-similar-notes-quality.mjs` and ship/kill metric in `docs/rnd/similar-notes-quality.md`.
- R&D experiment for semantic ranking quality, with a synthetic embedding-store fixture in `scripts/bench-semantic-ranking-quality.mjs` and ship/kill metric in `docs/rnd/semantic-ranking-quality.md`.
- R&D experiment for chunker boundary quality, with a synthetic fixture in `scripts/bench-chunker-quality.mjs` and ship/kill metric in `docs/rnd/chunker-boundary-quality.md`.
- Active R&D experiment for `get_daily_note` warm-path performance, with a synthetic benchmark harness in `scripts/bench-daily-notes.mjs` and ship/kill metric in `docs/rnd/daily-note-warm-path.md`.
- Active R&D experiment for `get_note` section-read performance, with a synthetic benchmark harness in `scripts/bench-section-reads.mjs` and ship/kill metric in `docs/rnd/section-read-warm-path.md`.
- R&D experiment for `list_sections` warm-path performance, with a synthetic benchmark harness in `scripts/bench-sections.mjs` and ship/kill metric in `docs/rnd/section-list-warm-path.md`.
- R&D experiment for `get_note` fragment-read performance, with a synthetic benchmark harness in `scripts/bench-note-fragments.mjs` and ship/kill metric in `docs/rnd/note-fragment-warm-path.md`.
- R&D experiment for `get_outlinks` warm-path performance, with a synthetic benchmark harness in `scripts/bench-outlinks.mjs` and ship/kill metric in `docs/rnd/outlinks-warm-path.md`.
- R&D experiment for `list_notes` warm-path performance, with a synthetic benchmark harness in `scripts/bench-list-notes.mjs` and ship/kill metric in `docs/rnd/list-notes-warm-path.md`.
- R&D experiment for `get_graph_neighbors` warm-path performance, with a synthetic benchmark harness in `scripts/bench-graph-neighbors.mjs` and ship/kill metric in `docs/rnd/graph-neighbors-warm-path.md`.
- R&D experiment for `find_orphans` warm-path performance, with a synthetic benchmark harness in `scripts/bench-orphans.mjs` and ship/kill metric in `docs/rnd/orphan-discovery-warm-path.md`.
- R&D experiment for `search_by_frontmatter` warm-path performance, with a synthetic benchmark harness in `scripts/bench-frontmatter-search.mjs` and ship/kill metric in `docs/rnd/frontmatter-search-warm-path.md`.
- R&D experiment for `resolve_alias` warm-path performance, with a synthetic benchmark harness in `scripts/bench-resolve-alias.mjs` and ship/kill metric in `docs/rnd/resolve-alias-warm-path.md`.
- R&D experiment for `get_vault_stats` warm-path performance, with a synthetic benchmark harness in `scripts/bench-vault-stats.mjs` and ship/kill metric in `docs/rnd/vault-stats-warm-path.md`.
- R&D experiment for `get_recent_notes` warm-path performance, with a synthetic benchmark harness in `scripts/bench-recent-notes.mjs` and ship/kill metric in `docs/rnd/recent-notes-warm-path.md`.
- R&D experiment for attachment inventory warm-path performance, with a synthetic benchmark harness in `scripts/bench-attachments.mjs` and ship/kill metric in `docs/rnd/attachment-inventory-warm-path.md`.
- R&D experiment for `read_canvas` warm-read performance, with a synthetic benchmark harness in `scripts/bench-canvas.mjs` and ship/kill metric in `docs/rnd/canvas-read-warm-path.md`.
- R&D experiment for tag-index warm-query performance, with a synthetic benchmark harness in `scripts/bench-tags.mjs` and ship/kill metric in `docs/rnd/tag-index-warm-path.md`.
- R&D experiment for `query_base` warm-query performance, with a synthetic benchmark harness in `scripts/bench-bases.mjs` and ship/kill metric in `docs/rnd/bases-query-warm-path.md`.
- Active R&D experiment for `find_broken_links` warm-scan performance, with a synthetic benchmark harness in `scripts/bench-broken-links.mjs` and ship/kill metric in `docs/rnd/broken-link-warm-path.md`.
- Active R&D experiment for link graph warm-cache performance, with a synthetic benchmark harness in `scripts/bench-links.mjs` and ship/kill metric in `docs/rnd/link-graph-warm-path.md`.
- Active R&D experiment for `search_notes` warm-cache performance, with a baseline fixture and ship/kill metric in `docs/rnd/search-cache-warm-path.md`.

### Changed

- `search_notes` now caps very long matching lines with query-centered snippets, keeping result output focused without changing ranking inputs.
- `search_notes` now renders repeated matches on the same line as one snippet row while preserving repeated-hit ranking signals.
- `search_notes` now ranks literal matches with title/path focus and repeated-line dampening, so noisy repeated mentions are less likely to outrank focused notes.
- `find_similar_notes` now builds its source query vector from chunks aligned with the source note's opening topic, so unrelated appendices are less likely to dominate similar-note ranking.
- Semantic search now ranks note-level results with a small focus signal from each note's top chunks, so one incidental high-scoring chunk is less likely to outrank notes that are consistently about the query.
- Semantic chunking now keeps oversized fenced code blocks fence-balanced when splitting them for embeddings, preserving title and heading prefixes while leaving non-code chunking behavior unchanged.
- `list_sections` now reuses a small mtime-validated rendered heading cache, cutting the 1,000-heading warm bench below the R&D ship bar while preserving heading escaping and write freshness.
- The `get_daily_note` warm-path R&D experiment is stopped after config and rendered-response cache prototypes missed the warm ship bar or exceeded guardrails.
- The `get_note` section-read warm-path R&D experiment is stopped after cache and streaming-parser prototypes missed the cold or warm ship bar.
- `get_note` line fragments now read only through the requested line range, cutting the 10,000-line warm fragment bench below the R&D ship bar while preserving section, block, full-note, and EOF behavior.
- `get_outlinks` now renders from resolved link rows captured by the shared graph cache, cutting the 1,000-note warm outlinks bench below the R&D ship bar while preserving alias resolution and valid/broken/embed grouping.
- The `list_notes` warm-path R&D experiment is stopped after a safe rendered-response cache missed the ship bar.
- The `get_graph_neighbors` warm-path R&D experiment is stopped after traversal-only cleanup missed the ship bar and higher fingerprint stat concurrency exceeded guardrails.
- The `find_orphans` warm-path R&D experiment is stopped after simple stat-concurrency and derived-category prototypes missed the ship bar.
- `search_by_frontmatter` now reads through the shared content cache, cutting the 1,000-note warm metadata lookup bench below the R&D ship bar while preserving scalar and array frontmatter matching.
- `resolve_alias` now reads through the shared content cache, cutting the 1,000-note warm alias lookup bench below the R&D ship bar while preserving alias matching and basename fallback output.
- `get_vault_stats` now reuses stat metadata returned by the content cache, cutting the 1,000-note warm bench below the R&D ship bar while preserving mtime freshness and aggregate output.
- `get_recent_notes` now reuses the safe resolved vault root across its per-note stat pass, cutting the 1,000-note warm bench below the R&D ship bar while preserving mtime freshness and result ordering.
- `find_unused_attachments` now reuses a warm in-memory attachment inventory keyed by attachment paths and note mtimes, cutting the 1,000 attachment/note warm unused-scan bench below the R&D ship bar while preserving reference matching and byte reporting.
- `read_canvas` now reuses a warm in-memory rendered summary keyed by canvas file metadata, cutting the 1,000-node warm canvas-read bench below the R&D ship bar while preserving path validation and displayed output.
- `list_tags` and `search_by_tag` now reuse a warm in-memory tag index keyed by note mtimes, cutting the 1,000-note sparse tag-search bench below the R&D ship bar while preserving tag matching and preview behavior.
- `query_base` now reuses stat metadata gathered by the content cache, cutting the 1,000-note warm Base query bench below the R&D ship bar while preserving stat-backed file filters.
- `find_broken_links` now reuses link graph data for unresolved-link reporting and skips a duplicate cold fingerprint stat pass, cutting the 1,000-note warm broken-link bench below the R&D ship bar.
- Link graph cache validation now reuses the vault root realpath across each fingerprint batch, cutting the 1,000-note warm `get_backlinks` bench below the R&D ship bar while keeping per-note symlink checks.
- `search_notes` warm-cache scans now reuse the vault root realpath across each cached read batch and skip per-entry `lstat` calls during broad vault walks, cutting the 1,000-note warm bench below the R&D ship bar while keeping per-note symlink checks.

### Fixed

- HTTP transport now rejects oversized JSON request bodies as soon as `Content-Length` or streamed bytes cross the cap, instead of waiting for the request to finish.
- `get_attachment` now refuses hidden dotfile attachments, matching the files skipped by attachment inventory scans.
- `move_note` now creates the destination with no-replace semantics, preventing an external writer from racing the move into overwriting a newly created note.
- Semantic embedding provider errors now redact secret-bearing URLs before returning them to MCP clients.
- Section edit tools now bound replacement, insertion, block, and find/replace payloads before writing notes, preventing oversized MCP requests from being persisted through surgical edits.
- Canvas helpers now reject oversized `.canvas` files before reading, parsing, or updating them, and `read_canvas` keeps large summaries bounded while still reporting total node and edge counts.
- `read_base` and `query_base` now reject oversized `.base` files before reading them, preventing the parser cap from allocating large files or broadening queries through an empty parsed Base.
- Recoverable `delete_note` now validates each `.trash` parent directory before creating deeper folders, preventing symlinked trash ancestors from creating directories outside the vault.
- Note read/edit helpers, `get_note`, and `obsidian://note/...` resources now reject non-`.md` vault files, keeping attachments, Canvas files, and Bases on their dedicated tool paths.
- Folder-scoped permissions now re-check the canonical in-vault target after following symlinks, preventing allowed symlink aliases from reading or writing outside their configured folders.
- Persistent index and embedding cache loaders now ignore oversized snapshot files before reading or parsing them, preventing corrupted vault-local cache files from forcing unbounded memory use.
- HTTP transport now returns `400` for malformed request URL or Host data before auth and routing, preventing those requests from escaping the normal response path.
- `get_attachment` now returns HTML, XML, and CSS attachments with `text/plain` resource metadata, preventing active vault-controlled text from being advertised as renderable content.
- `query_base` now treats unsupported filters, missing requested views, and unevaluable link filters as no-match with warnings, preventing Base queries from broadening result sets beyond the visible filter intent.
- Duplicate-alias graph warnings now redact the note-derived alias text before logging, while still reporting the colliding note paths through the existing path-redaction flow.
- Windows vault paths containing alternate data stream syntax are now rejected at the shared resolver, preventing tools such as `get_attachment` from addressing hidden streams through path suffixes.
- Surgical note edit tools now require read access to the target before inspecting section, block, or replacement matches, preventing write-only notes from leaking structure or match counts.
- `move_note` now requires read access to the source note as well as write access to the source and destination, preventing write-only folders from being used to disclose notes by moving them into readable paths.
- `move_note` reference rewrites and `rename_tag` bulk writes now ask elicitation-capable clients for a typed confirmation before rewriting across the vault, while keeping existing behavior for clients without elicitation and for dry runs.
- Frontmatter parsing now accepts only Obsidian-style YAML delimiter lines, leaves oversized YAML blocks unparsed during vault-wide reads, and refuses metadata updates on oversized blocks.
- Canvas link nodes now reject dangerous URL schemes after URL normalization, catching control-character-obfuscated `javascript:`, `data:`, and `vbscript:` inputs.
- HTTP transport now refuses non-loopback binds unless bearer auth is configured, preventing accidental unauthenticated LAN exposure.
- `replace_in_note` now rejects nested-quantifier and ambiguous repeated-alternation regex shapes before matching, reducing catastrophic-backtracking risk on smaller notes.
- `get_attachment` now percent-encodes vault resource URIs for blob/SVG responses, keeping control characters out of MCP resource identifiers while preserving plain paths for ordinary attachment names.
- Persistent index-cache snapshots now use owner-only file permissions when written on POSIX systems, matching the embedding cache's private snapshot behavior.
- `search_semantic` and `find_similar_notes` now filter persisted embedding hits through the current read allowlist, preventing stale wider-scope cache entries from leaking private paths or snippets after permissions are narrowed.
- Updated the transitive Hono lockfile entry to 4.12.23, clearing the moderate audit advisories in the MCP HTTP dependency path.
- HTTP server tests now retry OS-assigned ports that Node's `fetch` rejects, avoiding a flaky `bad port` failure during the verify gate.
- `obsidian://tags` now escapes control characters in generated tag keys and note-path values before returning its JSON index.
- Empty `get_vault_stats` folder output and missing daily-resource errors now escape control characters in displayed configured paths.
- Workflow prompts now escape control characters in displayed folder, path, and tag arguments before returning prompt text to MCP clients.

## [3.0.0] - 2026-06-04

### Fixed

- MCP-forwarded log payloads now redact vault-relative path-like fields such as `note`, `relPath`, and nested `path`, preventing read-scan failures from exposing private note names to connected clients.
- MCP log redaction now recognizes compound path field names such as `sourcePath` and `target_path`, and duplicate-alias logs group note paths under a redacted `notes` field.
- Note moves and trash deletes now reuse the Windows rename retry path, reducing transient `EPERM`/`EBUSY` failures when another process briefly has the file open.
- Index and embedding cache snapshot writes now share the same Windows rename retry path, avoiding avoidable cold-cache rebuilds after brief file-handle conflicts.
- Failure summaries for tag renames and semantic indexing now escape control characters in vault-relative paths before returning them to MCP clients.
- Canvas responses now escape control characters in displayed node ids, edge labels, previews, and rejected input before returning them to MCP clients.
- MCP resources now register through the current SDK `registerResource` API, with regression coverage for resource listing and reads.
- `search_by_tag` now escapes control characters in displayed tag labels, note paths, and content previews before returning them to MCP clients.
- `search_notes` now escapes control characters in displayed query labels, result paths, and matched line snippets before returning them to MCP clients.
- `search_by_frontmatter` now escapes control characters in displayed property labels, value labels, result paths, and frontmatter rows before returning them to MCP clients.
- `get_recent_notes` now escapes control characters in displayed `since` labels and note paths before returning them to MCP clients.
- `get_note` now escapes control characters in missing section and block error labels before returning them to MCP clients.
- `resolve_alias` now escapes control characters in displayed alias labels and result paths before returning them to MCP clients.
- `get_daily_note` now escapes control characters in displayed configured daily-note paths before returning them to MCP clients.
- `get_outlinks` now escapes control characters in displayed note paths and wikilink targets before returning them to MCP clients.
- `get_backlinks`, `find_orphans`, `find_broken_links`, and `get_graph_neighbors` now escape control characters in displayed note paths, wikilink targets, and context lines before returning them to MCP clients.
- Attachment tools now escape control characters in displayed extension filters, attachment paths, filenames, and blocked/rejected paths before returning them to MCP clients.
- Base tools now escape control characters in displayed Base paths, property labels, view labels, warnings, result paths, and frontmatter keys before returning them to MCP clients.
- Section tools now escape control characters in displayed note paths, headings, block ids, and invalid regex flags before returning them to MCP clients.
- Semantic tools now escape control characters in displayed queries, provider labels, note paths, heading paths, and snippets before returning them to MCP clients.
- Write tools now escape control characters in displayed note paths before returning create, update, move, delete, and daily-note messages to MCP clients.
- `list_tags` and `rename_tag` now escape control characters in displayed tag labels before returning them to MCP clients.
- Read tools now escape control characters in generated frontmatter/tag headers, note-list rows, and vault-stat path labels before returning them to MCP clients.

### Breaking Changes

- Dropped support for Node.js 18, 20, and 22. The server now requires Node.js 24 or newer (`engines.node >=24.0.0`).

### Changed

- Updated the TypeScript build target to Node 24-era settings (`ES2024`, `NodeNext`) and refreshed the toolchain to current compatible packages: MCP SDK 1.29, Zod 4, TypeScript 6, ESLint 10, and Node 24 type definitions.
- Preserved caught error causes in newly wrapped errors required by ESLint 10 while keeping client-facing error messages sanitized.
- Removed the GitHub Actions CI and publish workflows and rely on the local `npm run verify` gate (lint, type-check, tests, build, audit, package dry-run) before merge and publish.

## [2.1.0] - 2026-06-03

### Added

- **`file.size`, `file.ctime`, `file.mtime`** filters now work in `query_base` for Obsidian `.base` files. Stats are collected concurrently for good performance on large vaults.
- New `toComparableString` helper in the Bases DSL for consistent, safe string coercion during comparisons and chained methods (`.contains`, `.startsWith`, `.equals`, etc.). Improves reliability when filtering on numeric, boolean, or complex property values.

### Fixed

- CLI token handling: `--token` and `MCP_HTTP_TOKEN` values are now trimmed. Empty tokens are rejected with a clear error instead of causing confusing auth failures later.
- Process lifecycle: SIGINT/SIGTERM shutdown handlers were refactored to properly sequence log flushing and avoid leaving unhandled promise rejections.
- ESLint: enabled full `recommendedTypeChecked` ruleset (catches more promise and type issues at lint time). Switched the typed parser to use a dedicated `tsconfig.eslint.json` (narrower `include`, better for the linter). Additional `no-unsafe-*` rules are relaxed only inside test files.

### Changed

- **vitest** devDependency bumped from ^3 to ^4.1.8 (lockfile updated; all tests continue to pass).
- `.gitignore` now excludes common AI coding assistant local directories (`.claude/`, `.codex/`, `.greptile/`, `.cursor/`, `.windsurf/`, etc.) and `generated-images/` scratch space. The previous rule for `.claude/settings.local.json` is superseded by a broader, future-proof pattern. Shared project config can still be committed via `.claude/settings.json` using `git add -f` if desired.

### Tests

- Added `src/__tests__/handlers/bases.test.ts` exercising the new file stat filters in `query_base`.
- Many existing regression and handler tests updated for the Bases improvements and vitest v4.

## [2.0.0] - 2026-05-18

Full-codebase security and correctness audit: 75+ fixes across 42 files, verified against current library documentation. Major version bump due to breaking changes in tool naming, parameter requirements, and default behavior.

### Breaking Changes

- **`get_tags` renamed to `list_tags`** for consistency with `list_notes`, `list_attachments`, `list_canvases`, etc. Clients calling `get_tags` must update.
- **`delete_note` requires `confirm: true`** for permanent deletes. Calls with `permanent: true` but without `confirm: true` now return an error instead of deleting.
- **CORS default changed** from `["*"]` to localhost-only (`http://localhost:*`, `http://127.0.0.1:*`, `http://[::1]:*`). Clients connecting from non-localhost origins must configure `allowedOrigins` explicitly.
- **`cosineSimilarity` throws on dimension mismatch** instead of silently returning 0.
- **`listNotes` throws for non-existent folders** instead of returning an empty array.

### Added

- **Blocked extensions list** in attachment handling: `.exe`, `.bat`, `.cmd`, `.com`, `.msi`, `.scr`, `.pif`, `.vbs`, `.vbe`, `.js`, `.jse`, `.wsf`, `.wsh`, `.ps1` are rejected.
- **Magic-bytes verification** for images (PNG, JPEG, GIF, WebP, BMP) with mismatch warnings.
- **`maxResults` parameter** on `search_by_frontmatter` (default 50), `get_graph_neighbors` (default 200).
- **Descending sort support** in Bases DSL (`-key`, `key:desc`, `key:descending`).
- **Security headers** on all HTTP responses: `X-Content-Type-Options`, `X-Frame-Options`, `Cache-Control`, `Strict-Transport-Security`.
- **Auth failure logging** with method, path, and client IP.
- **No-auth warning** logged at startup when HTTP server has no bearer token configured.
- **UUID format validation** for session IDs.
- **Input validation bounds** (`.max()`) on all Zod string and number schemas across every tool file.
- `MAX_CONCURRENT_OPS` named constant replacing magic number `16`.
- Warning cap (100 max) in Bases DSL evaluation.

### Fixed

#### Security
- **SSRF via `OBSIDIAN_EMBEDDING_URL`**: URL scheme and host now validated; only HTTPS and localhost HTTP allowed.
- **Symlink escape in `walkVault`**: entries are now checked with `lstat`; symlinks pointing outside vault are skipped.
- **Null-byte injection** in directory entry filenames: entries with null bytes are skipped.
- **Model name injection**: embedding model names validated against pattern and length.
- **SVG XSS**: SVG attachments served as `text/plain` with a security warning instead of image embeds.
- **`javascript:`/`data:`/`vbscript:` URIs** blocked in canvas link nodes.
- **CommonMark fence detection** in tag-rewriter fixed to `^ {0,3}` anchor (was `trimStart()`).
- **Log injection**: control characters in log field values are now escaped.
- **File permissions**: embedding store and install config written with mode `0o600` on non-Windows.

#### Correctness
- **Bases `not:` filter logic**: fixed from `!every` to `!some` (De Morgan's law).
- **`looseEqual(null, 0)`** no longer returns `true`.
- **`loadStore` race condition**: concurrent callers now share the same loading promise instead of seeing stale `loaded=true`.
- **`saveStore` concurrent writes**: coalesced via dirty flag to prevent file corruption.
- **`BLOCK_ID_RE`** now matches block IDs at line start (not just after whitespace).
- **`buildRow` populates `row.links`** from wikilinks, fixing `file.linksTo()` filters that always matched.
- **Empty frontmatter preserved**: `---\n---` delimiters kept after tag removal empties all keys.
- **Wikilinks quoted in frontmatter** after tag rewriting for Obsidian compatibility.
- **`destructiveHint: true`** set on `update_section` and `edit_block`.
- **`update_section` description** corrected to match implementation behavior.
- **Canvas self-loops and duplicate edges** rejected.
- **`readCanvasFile`** validates JSON.parse result at runtime before casting.
- **`getRealVaultRoot`** only catches ENOENT, re-throws permission and other errors.
- **`findLineWithLink`** exact match prevents `[[note]]` matching `[[notebook]]`.
- **Config `JSON.parse`** validated at runtime with type guard.
- **Vault path validation** in install: checks existence, directory type, null bytes, absolute path.
- Dead `formatDate` passthrough removed; dead `isExcluded` function and redundant post-filters removed.

#### Performance
- **`find_similar_notes`** reduced from O(ownChunks * totalChunks) to O(totalChunks) via centroid vector.
- **Cache prune** only evicts entries for deleted files, not out-of-scope paths.
- **Bases tool** uses `readAllCached` instead of per-file reads.
- **`get_vault_stats`** and **`resolve_alias`** optimized to avoid loading entire vault into memory.
- **`get_graph_neighbors`** depth capped at 3 with early termination at `maxResults`.
- **Fence close regex** compiled once per block instead of per line.
- **Per-chunk SHA-256** removed (was computed but never consumed).
- **`obsidian://tags` resource** now uses mtime cache.
- **Weekly-rollup prompt** reduced from 7 sequential calls to 1.
- Index-cache temp files use PID+timestamp+UUID for uniqueness.

#### Type safety
- `noUncheckedIndexedAccess` and `noImplicitReturns` enabled in tsconfig.
- ~94 indexed-access safety issues fixed across the entire codebase.
- ESLint typed linting enabled with `no-floating-promises` and `no-misused-promises`.
- `engines.node` bumped to `>=18.18.0` (minimum for ESLint v9).
- `package-lock.json` version synced to match `package.json`.

### Changed

- Tag search previews strip raw frontmatter before slicing.
- `isFinal` in progress reporter returns `true` immediately when `total === 0`.
- `ProgressMeta.progressToken` accepts `undefined` for SDK compatibility.

## [1.9.0] - 2026-05-11

Large audit-fix wave: 44 real bugs fixed across 22 source files, 22 new regression test suites added (638 tests passing, 0 failures). Minor bump because the Bases parser learns the chained-method DSL Obsidian 1.9.2+ introduced (backward-compatible new feature, not a breaking change).

### Added

- **Bases chained-method DSL** (Obsidian 2026 spec): `file.name.contains("x")`, `file.hasTag("x")`, `file.hasProperty("k")`, `file.inFolder("p")`, `file.linksTo("y")`, plus generic `.contains` / `.startsWith` / `.endsWith` / `.equals` / `.isEmpty` / `.isNotEmpty` on any property chain. Legacy function-form (`taggedWith(file, "x")`) and infix comparisons still work.
- **All 13 documented Bases `file.*` properties** wired through `readProperty`: `file.name`, `file.basename`, `file.path`, `file.folder`, `file.ext`, `file.tags`, `file.size`, `file.ctime`, `file.mtime`, `file.properties`, `file.links`, `file.embeds`, `file.backlinks`.
- **Daily-note moment tokens** added to `formatMomentDate`: `A`/`a` (AM/PM), `W`/`WW`/`ww` (ISO week), `gggg`/`gg` (ISO week-year), `E` (ISO weekday), `e` (local weekday), `X`/`x` (unix timestamps).
- **`create_daily_note` template substitution** for `{{date}}`, `{{date:FMT}}`, `{{title}}`, `{{time}}`, `{{time:FMT}}` (was: `{{date}}` only).
- **`add_canvas_node` auto-stagger**: nodes added without explicit x/y land at `(50*n, 50*n)` instead of all stacking at origin.
- **Permissions JSDoc** now documents all three accepted delimiters (`,`, `:`, `;`) and their cross-platform caveats.
- 22 new regression test suites under `src/__tests__/regression-*.test.ts`, one per fix domain.

### Fixed

#### Security
- **HTTP DNS-rebinding protection was a no-op.** `allowedHosts` was reassigned after the transport had already captured the original empty array; now mutated in place so the bound-host list actually reaches the transport.
- **ReDoS in `replace_in_note`.** A pathological LLM-supplied regex froze the per-file write lock indefinitely. Flag allowlist (`gimsuy` only), 4096-char `find` cap, 1 MB input cap, and `RegExp` construction wrapped in try/catch.
- **ReDoS in `.base` filter parser.** Unbounded greedy/lazy spans in `FUNC_RE` and `COMPARISON_RE` were quadratic-backtrackable from a malicious `.base` file. Replaced with bounded character classes.
- **YAML alias-bomb DoS in `parseBaseFile`.** `yaml.load` now uses `JSON_SCHEMA` (most restrictive) and rejects `.base` files over 1 MB with a warning.
- **Bearer token leaked via `process.argv`.** `--token=VALUE` and `--token VALUE` now redacted to `***` in `process.argv` immediately after parsing so the secret never surfaces in `ps` / `/proc/<pid>/cmdline`.
- **`install` `serverName` not sanitized.** Control characters and ANSI escape sequences in `serverName` are now rejected, matching the existing `vaultName` guard.
- **Windows drive-relative and UNC paths.** `resolveVaultPath` now explicitly rejects inputs starting with a drive letter (`C:foo`), `/`, `\`, or `\\` so they cannot ride the prefix check via `path.resolve` semantics.
- **`assertRealPathWithinVault` EACCES rethrow.** Permission errors on protected ancestors no longer leak the raw absolute path in the message; EACCES is treated as climb-up and falls through to a generic traversal error.
- **`delete_note` elicitation gate.** The capability check was `caps?.elicitation?.form` which is a TypeScript-SDK extension; spec-compliant clients declaring only `elicitation: {}` silently bypassed the permanent-delete confirmation. Widened to `caps?.elicitation !== undefined`.
- **HTTP POST Content-Type validation.** Non-`application/json` POSTs return 415 instead of a 500 from a JSON parse error.
- **HTTP `/version` no longer leaks under bearer auth.** Non-GET to `/version` requires the bearer when configured; GET stays public for monitoring.
- **Signal-handler accumulation.** `startHttpServer` removes prior SIGINT/SIGTERM listeners before re-registering, so repeat starts no longer trip `MaxListenersExceededWarning`.

#### Data integrity / correctness
- **Cache flush race.** `flushVaultCache` could drop writes that arrived during an in-flight rename; now re-checks `dirty` after awaiting the prior flush and only clears `dirty` after rename success.
- **`find_unused_attachments` wrong reclaim total.** The size accumulator only iterated the truncated subset; the label "Total reclaimable" was therefore an under-count when results exceeded `limit`. Now stats every unused file for the total.
- **`query_base` silently dropped notes.** `mapConcurrent` was called without an error callback, so a single unreadable note vanished from results with no warning. Now logs and continues.
- **Tag-rename blank-line drift.** `rewriteAllTags` re-parsed and re-stringified via gray-matter twice, accumulating one blank line between frontmatter and body on every run. Single round-trip now.
- **`dayOfYear` mixed UTC and local time.** Near midnight in non-UTC zones (e.g. UTC+5:30 at 00:30 local on Jan 1), `DDDD` reported last year's day-of-year while `YYYY-MM-DD` reported the new year. DST-immune local-time table lookup now.
- **Frontmatter wikilinks lost double-quoting.** Obsidian's Properties editor only renders `link: "[[X]]"` when the value is double-quoted; gray-matter's default emitter produced single-quoted or bare output. `updateFrontmatter` post-processes the YAML block to enforce double-quotes.
- **CommonMark closing-fence indentation.** `sections.ts` accepted arbitrarily-indented closing fences (it trimmed leading whitespace first), which misidentified section boundaries when a note contained an indented backtick run. Now matches CommonMark's 0-3-space rule.
- **`find_broken_links` was fully sequential.** Replaced with `readAllCached` plus `mapConcurrent`, matching the rest of the vault-wide tools.
- **`get_backlinks` and `get_outlinks` dropped alias resolution in the display pass.** Wikilinks resolved via alias appeared with empty line/context. Both routes now share the graph's `aliasMap`.
- **Canvas tools accepted non-`.canvas` paths.** `add_canvas_node` against a JSON config file silently merged a node into its `nodes` array. All canvas tool path schemas now enforce `.canvas` extension.
- **HTTP shutdown hang.** `httpServer.close()` doesn't destroy idle keep-alive sockets; `stop()` could hang forever with an open SSE stream. Now calls `closeAllConnections()` first.
- **`get_vault_stats` double-scanned.** Folded the second `getNoteStats` pass into the single `mapConcurrent` walk that already reads content via the cache.
- **`index_vault` over-counted `chunksEmbedded`.** Per-batch increment was bumped by the full batch length even when chunks failed embedding; per-chunk now.
- **`create_note` and `update_frontmatter` accepted non-object JSON roots.** Scalar (`"hello"`) or array (`[1,2]`) frontmatter would reach `matter.stringify` and emit invalid YAML. Now rejected.
- **`listNotes(folder)` returned malformed paths.** Trailing slashes or backslashes in the user-supplied `folder` produced paths like `projects/active//note.md`. Folder string is normalized first.
- **Trash path bypassed the canonical resolver.** `deleteNote` non-permanent path now routes the trash destination through the same pipeline as every other write target.
- **`embedding-store.saveStore` tmp leak on failure.** Now mirrors `atomicWriteFile`: tmp suffix randomized, cleanup in catch.
- **Embedding store snapshot dimension mismatch.** Vectors whose length didn't match `snapshot.dimension` were loaded anyway and silently scored 0 against everything; now skipped at load time.
- **Ollama provider probe wasted requests and corrupted batches.** The cold-start probe re-embedded chunk 0 in the followup full batch. The probe result is now stitched into the batch over `texts.slice(1)`.
- **Embedding-store had no persisted-snapshot size cap.** Large vaults could produce 1+ GB JSON files. 256 MB cap with warn-skip.
- **`index_vault` had no top-level lock.** Two concurrent indexes could interleave `setNoteChunks` / `pruneMissingNotes` and corrupt the store. Wrapped in a vault-level lock via `vaultRewriteLockKey`.
- **`obsidian://daily` resource returned synthetic content on missing notes.** Clients couldn't distinguish "no daily note" from a note whose first line happened to say that. Now throws so the SDK emits a proper error response.
- **`replace_in_note` and `insert_at_section` reported UTF-16 code-unit counts as bytes.** Now uses `Buffer.byteLength` for the reported byte count.
- **`edit_block` rejected `^id` form.** Now strips a leading `^` from the block-id input via Zod transform.
- **`find-stale-notes` prompt instructed the model to call `get_note` per candidate.** Rewritten to route through `get_recent_notes`. `daily-review`, `extract-action-items`, and `build-moc` similarly capped against fan-out.

#### Other
- **`INLINE_TAG_RE` module-level state** removed; the stateful `g`-flag regex is now local to `rewriteInlineTags`.
- **Closing-fence regex** in `tag-rewriter.ts` and `markdown.ts` is now compiled once per fence (was recompiled on every interior fenced-code line).
- **`rewriteFrontmatterTags`** array branch uses a per-key `changed` flag, matching the existing per-key pattern in the string branch.
- **`loadFromDisk`** retries on transient errors instead of latching `loaded=true` on EACCES for the rest of the session.
- **Ollama batch-probe** degrades to per-item only on 404; transient errors leave `batchSupported=null` so future calls re-probe.

### Notes

- The audit's claim that `rename_tag`'s Zod regex blocked hierarchical names (`project/alpha`) was verified to be a false positive; the regex correctly accepts them. Schema invariants are pinned in `regression-tools-tags.test.ts`.
- The audit's rate-limiter `delete-instead-of-set` claim was verified unreachable given the constructor's `limit > 0` invariant; existing `sweep()` already handles empty entries.

## [1.8.6] - 2026-05-09

### Changed

- **README header replaced with a full-width project banner** (2500x1000 PNG: logo + title + tagline + chips on a navy/indigo gradient). Renders identically on GitHub and npmjs.com via the raw GitHub URL. Replaces the small 180px-centered logo introduced in 1.8.5.

### Added

- `assets/banner.png` (2500x1000) sized to Patreon's official cover-photo recommendation.
- `assets/github-social.png` (1280x640) sized to GitHub's official social-preview recommendation, for repo Settings > Social preview.

## [1.8.5] - 2026-05-09

### Added

- **Project logo** (`assets/logo.png`, 1024x1024) and source SVG (`assets/logo.svg`) committed to the repo. README now displays the logo above the title via the raw GitHub URL so npmjs.com renders it the same as GitHub.

## [1.8.4] - 2026-05-09

### Added

- **Ko-fi badge restored** alongside Patreon in the README. The pair (recurring + one-off) is the standard creator-support setup.

## [1.8.3] - 2026-05-09

### Changed

- **Sponsorship link in README switched from Ko-fi to Patreon.** Patreon offers tiered support and a clean recurring-revenue path that Stripe Connect blocks for the maintainer's payout region (Serbia). New URL: <https://patreon.com/obsidianmcppro>.

### Removed

- Ko-fi badge and prose mention removed (later restored in 1.8.4 alongside Patreon).

## [1.8.2] - 2026-05-06

### Fixed (concurrency, correctness, info-leak hardening from a deeper-dive audit)

- **`rename_tag` (and any future vault-wide bulk writer) now hold the
  same vault-level rewrite lock as `move_note` / `delete_note`.** The
  v1.8.1 fix closed the in-tool TOCTOU but left a cross-tool race:
  running `rename_tag` and `move_note` concurrently could shift bytes
  in a referrer mid-plan, then `applyRewrites` would surface
  "content changed during move; references not updated" with stale
  links left behind. `vaultRewriteLockKey` is now exported and
  acquired by `rename_tag`'s write phase. A regression test runs both
  tools in parallel and asserts no failed referrers.
- **CommonMark fenced-code indentation now matches the spec (max 3
  spaces).** The previous regex used `line.trimStart()`, accepting
  arbitrary leading whitespace before a closing fence. A note with
  4-space-indented backticks inside a code block could prematurely
  close the fence and expose subsequent content (containing
  wikilinks) to rewriting. Both opening and closing fences are now
  checked with `^ {0,3}` per CommonMark §4.5.
- **`planMoveRewrites` and `planDeleteRewrites` now read each note
  exactly once.** Previous implementation made two passes over the
  vault (alias-map build + reference scan). On a 10k-note vault that
  was 2x the I/O during a rename. The single-pass version reads
  everything into a `Map`, then runs both passes in-memory.
- **`applyRewrites` now retries failed edits via content search.**
  When `applyEditsBackToFront` rejects an edit because bytes drifted
  (an Obsidian sync, text editor, or concurrent rename_tag inserted
  text elsewhere in the file), the apply step searches the current
  content for the planned `expected` substring. If it appears
  exactly once, the edit splices at the new position. If it's
  missing or ambiguous, the failure is surfaced as before — no risk
  of picking a wrong occurrence.
- **`/health` no longer leaks the live session count to
  unauthenticated callers when a Bearer token is configured.** The
  endpoint stays unauthenticated for monitoring (status + version
  always present), but the `sessions` field is dropped in
  authenticated deployments so anonymous probes can't enumerate
  usage patterns. Local-only setups (no token) still see
  `sessions`. Regression test asserts both modes.
- **`constantTimeEqual` no longer leaks the expected token length.**
  Both supplied and expected tokens are now padded to a fixed
  comparison width before `timingSafeEqual`, so the call duration
  is the same whether or not the lengths match. The length check
  is recorded separately and combined with the byte compare without
  an early exit, so an attacker can't binary-search the expected
  length via timing.
- **`resolveWikilink` path-suffix match now applies the same
  proximity tie-break as basename match.** When two notes shared a
  path-suffix (case-only collision on case-insensitive FS, or a
  symlinked subtree), the previous implementation returned whichever
  appeared first in `listNotes` order. The fix collects all
  candidates and picks the one whose folder shares the deepest
  prefix with the linking note, then breaks ties on shortest path.
- **`extractMarkdownLinkSpans` now matches CommonMark-escaped `]`
  inside link labels.** A hand-edited link like `[foo\]bar](x.md)`
  was previously skipped during a move rewrite, leaving the link
  stale. Regex extended to allow `\\.` escape sequences in the
  label.
- **`runInstall` rejects `vaultName` values containing control
  characters.** The CLI path is safe, but the public API used to
  accept null bytes / newlines that could corrupt the downstream
  Claude Desktop / Cursor JSON config or env-spawn handling.
- **`runInstall` now surfaces the backup path when `writeConfig`
  fails.** Previously the user got a generic error and had to find
  their `.bak.<timestamp>` themselves.
- **`canvasesToRewrite` is built from `mapConcurrent`'s return value
  instead of a shared mutable array.** Currently safe (Node is
  single-threaded), but a latent footgun if the helper ever moves to
  worker_threads.

### Tooling

- **`npm audit fix` clean.** Resolved 4 moderate-severity advisories
  in transitive devDependencies (`hono`, `postcss`, `ip-address`,
  `express-rate-limit`, all reached through vitest). Production
  dependencies were already clean. The `files` field publishes only
  `build/`, `README.md`, `LICENSE`, so devDeps never shipped to npm
  consumers.

### Tests

- **449 tests passing (was 444).** New regression coverage for
  rename_tag concurrency lock (HIGH #1), `/health` bearer-mode
  session-count omission, and the bytes-shifted retry path in
  `applyRewrites`.

## [1.8.1] - 2026-05-06

### Security

- **Permission allowlist bypass via `..` segments (CRITICAL).** v1.8.0
  evaluated `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS` against the
  raw user-supplied path before `path.resolve` collapsed `..` segments.
  An input like `Allowed/../OtherFolder/note.md` passed the prefix
  check (string starts with `Allowed/`) and `path.resolve` then sent
  the read or write to a folder outside the allowlist. The vault-
  traversal check still passed because the resolved path stayed inside
  the vault root. Fixed by collapsing `..` segments via
  `path.posix.normalize` inside `assertAllowed` and rejecting any path
  whose normalized form climbs above its starting point. Six new
  regression tests cover the bypass classes (escape into a different
  folder, climb above vault root, leading `..`, backslash-encoded
  variant, write-side variant, and an allowed `..`-traversal that
  lands back inside the same folder).

### Fixed

- **No HTTP timeout on embedding-provider fetches (HIGH).** A hung
  Ollama or OpenAI endpoint would hang the tool call forever and
  hold the MCP session open. Every `fetch` in
  `lib/embedding-providers.ts` now uses
  `signal: AbortSignal.timeout(30_000)`.
- **TOCTOU race in `rename_tag` (HIGH).** The previous implementation
  read the note outside any lock and then fed a precomputed
  `result.content` into `updateNote` via `() => result.content`,
  silently overwriting any concurrent write that landed between the
  read and the lock-acquired write. The rewrite now runs inside the
  `updateNote` transform so `existing` is always the current
  on-disk content. Dry-run path stays lockless (no writes).
- **`search_semantic` and `find_similar_notes` ignored model
  mismatches (HIGH).** Only `index_vault` invalidated stale cached
  vectors when the active provider/model changed. Switching models
  and querying before re-indexing produced meaningless cosine scores
  with no warning. Both tools now call `invalidateIfIncompatible`
  after `loadStore`, and `search_semantic` reports a clearer message
  when the index ends up empty for the active model.
- **DoS via deeply nested filter recursion in `bases.ts` (MEDIUM).**
  `evaluateFilter` recursed through `and`/`or`/`not` with no depth
  guard. A pathological `.base` file could blow the V8 stack. A
  depth counter now caps recursion at 64 levels and surfaces a
  warning past the limit.
- **`updateNote` rewrote files even when transforms returned
  unchanged content (MEDIUM).** No-op tools (`replace_in_note` with
  zero matches, `rename_tag` on notes without occurrences) bumped
  mtime on every call, invalidating the index-cache and
  embedding-store entries for files that were not actually
  modified. `updateNote` now compares `next === existing` and skips
  the atomic write when nothing changed. Benefits every caller, not
  just `replace_in_note`.
- **Provider error response bodies leaked verbatim into thrown
  Error messages (MEDIUM).** Truncated to 200 chars before
  interpolation in all three Ollama/OpenAI error paths.
- **Empty `accept` form-elicit responses surfaced as errors (LOW).**
  `delete_note` treated an `action: "accept"` with missing or empty
  `confirmPath` as a confirmation failure. Now it is a cancel,
  matching the user's apparent intent (dismissed the form).
- **Cache snapshot eviction was non-deterministic (LOW).** When the
  in-memory cache exceeded the 64 MB on-disk cap, entries were
  iterated in insertion order, so a single multi-MB note inserted
  early starved smaller entries from the snapshot. Entries are now
  sorted by content length ascending before serialization, so small
  entries fill the budget first.
- **`update_section` reported byte count using `string.length`
  (TRIVIAL).** Off by 2x for multi-byte characters. Switched to
  `Buffer.byteLength(newBody, "utf-8")`.

### Tests

- 444 tests passing (was 438). Six new regression tests for the
  permission allowlist bypass classes.

## [1.8.0] - 2026-05-06

### Added

- **Section / heading / block surgical edits.** New `lib/sections.ts` parser
  drives a family of fragment-aware tools so an LLM can edit a single
  paragraph without rewriting the file:
  - `update_section` replaces the body under a heading path
    (`'Tasks'` or `'Project A/Status'`); the heading line itself is
    preserved.
  - `insert_at_section` adds content `before` the heading, `after-heading`
    (under the heading), or `append` (at the end of the section body).
  - `list_sections` returns the heading outline of a note.
  - `replace_in_note` does string or regex find-replace within one note,
    with an optional `expectedCount` guard that aborts if the LLM's pattern
    over- or under-matches.
  - `edit_block` rewrites a paragraph tagged with `^id` while preserving
    the anchor so existing `![[note#^id]]` transclusions still resolve.
  - `get_note` grew three fragment-retrieval modes — `section`, `block`,
    and `lines` — that return raw text without the frontmatter/tag
    header so token usage stays tight on long notes.
- **Bases support.** First filesystem-only Obsidian MCP server with native
  `.base` support. New `list_bases`, `read_base`, and `query_base` tools
  parse the YAML, evaluate a useful subset of the filter DSL
  (`taggedWith()`, `file.hasTag()`, `file.inFolder()`,
  `==`/`!=`/`>`/`>=`/`<`/`<=`/`contains`/`startsWith`/`endsWith`,
  `and:`/`or:`/`not:`), apply view-level filters and ordering, and surface
  unrecognized clauses as warnings rather than silently dropping rows.
- **`rename_tag` tool.** Rebuilds inline `#tag` occurrences and frontmatter
  `tags:` arrays (and comma-strings) across the entire vault. Defaults to
  hierarchical mode so renaming `project` → `client` also rewrites
  `project/alpha` → `client/alpha`. `dryRun: true` reports counts without
  touching disk.
- **`OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS` allowlists.** Folder-
  scoped permissions enforced at the single `resolveVaultPath` choke point.
  Read and write are independent so an audit user can be read-only on most
  of the vault but write-only to `Drafts/`. The startup log line and
  `--help` advertise the active scope.
- **MCP prompts.** New `daily-review`, `weekly-rollup`, `find-stale-notes`,
  `extract-action-items`, and `build-moc` starter templates surfaced via
  the prompts capability so clients (Claude Desktop, Cursor) can offer
  them in their slash-command palettes.
- **mtime-keyed content cache, persistent across restarts**
  (`lib/index-cache.ts`). Vault-wide scans (`get_tags`, `search_notes`,
  `search_by_tag`, anything that reads every note) now stat each file and
  only re-read entries whose mtime has moved since the last query. The
  snapshot is written to `<vault>/.obsidian/cache/mcp-pro-index-cache.json`
  (debounced + flushed on shutdown via SIGINT/SIGTERM/beforeExit), so the
  next process start hydrates from disk and serves a 4k-note vault from
  cache after one stat-pass. Vault relocations invalidate the snapshot via
  the embedded `vaultRoot` check; persistence can be turned off with
  `OBSIDIAN_CACHE_DISABLED=1`.
- **`searchNotes` split into a pure scanner + I/O wrapper.** The
  `search_notes` tool now feeds the cache's content map into
  `searchInContents`, so repeat searches with hot files skip re-reads and
  hit only the in-memory matching loop. The library API `searchNotes`
  retains its prior signature for non-tool callers.
- **eslint** wired up via `eslint.config.js` (flat config, eslint v9 +
  typescript-eslint v8). New scripts: `npm run lint`, `npm run lint:fix`.
  First pass surfaced and fixed: 4 unused imports
  (`http-server.test.ts`, `link-rewriter.ts`, `permissions.ts`), an
  ambiguous multi-space indented-code regex in `markdown.ts`, and a
  `let`-should-be-`const` in `sections.ts`. Lint passes clean now.
- **`get_recent_notes`** tool. Lists notes sorted by mtime (most recent
  first), with optional `since` filter accepting ISO dates
  (`2026-04-01`, `2026-04-01T12:00:00Z`) or relative spans
  (`24h`, `7d`, `2w`). Use to power "what changed this week" digests.
- **`get_vault_stats`** tool. One-shot health snapshot: note count,
  total bytes, total words, average bytes/words per note, unique tag
  count, untagged-note count and %, plus the path of the most recently
  modified note. Optionally folder-scoped. Reads through the mtime cache
  so repeat calls cost stat-only.
- **`resolve_alias`** tool. Translate a human-friendly title like
  `"My Project"` into the actual note path by matching frontmatter
  `aliases:` (case-insensitive). With `includeBasename: true` (default),
  also matches notes whose filename equals the requested name —
  Obsidian's resolution fallback when no alias matches.
- **`list_attachments`** tool. Enumerates every non-md/canvas/base file
  in the vault (images, PDFs, audio/video, anything pasted in). Returns
  a sorted list plus a per-extension count summary. Optionally filtered
  to a single extension.
- **`find_unused_attachments`** tool. Locates attachments no note
  references via `![[file]]` embeds or `[text](file)` markdown links —
  flag for the vault hygiene pass. With `includeBytes: true`, also
  reports total reclaimable bytes per file. Resolution mirrors
  Obsidian's: exact relative path first, then basename match.
- **Progress notifications** on long-running scans. When a client
  passes `_meta.progressToken` on the tool call, `rename_tag` and
  `find_unused_attachments` now emit throttled `notifications/progress`
  events as they walk the vault, so clients can render a spinner / bar
  instead of a frozen tool call. New `lib/progress.ts` helper. No-op
  for clients that don't subscribe.
- **`get_attachment` tool.** Reads an attachment file and returns its
  bytes to the client. Images come back as `image` content blocks
  (rendered inline by Claude / Cursor), audio as `audio` blocks, all
  other types as base64 `resource` blocks with a `vault://` URI.
  Default cap of 5 MB, hard cap 50 MB; markdown / canvas / base files
  are explicitly rejected so callers don't pull text-format files
  through the binary path. Includes a small `lib/mime.ts` extension
  → MIME map covering the formats Obsidian users actually paste in.
- **Semantic search.** First filesystem-only Obsidian MCP server with
  full embedding-based retrieval that doesn't require the Smart
  Connections plugin. Three new tools:
  - `index_vault` chunks each note (heading-aware, with paragraph and
    sliding-window fallbacks for oversized sections), embeds every
    chunk via the configured provider, and persists to
    `<vault>/.obsidian/cache/mcp-pro-embeddings.json`. Incremental:
    notes whose content hash matches the prior pass are skipped;
    pass `force: true` to re-embed everything (e.g. after switching
    models). Emits progress notifications.
  - `search_semantic` embeds the query, scores every chunk by cosine
    similarity, deduplicates to one hit per note, and returns the
    top-K with snippets.
  - `find_similar_notes` walks an existing note's chunks against the
    rest of the index — no live embedding call needed.

  Pluggable providers via env (`OBSIDIAN_EMBEDDING_PROVIDER`,
  `OBSIDIAN_EMBEDDING_MODEL`, `OBSIDIAN_EMBEDDING_URL`,
  `OBSIDIAN_EMBEDDING_API_KEY`): Ollama (default, local,
  `nomic-embed-text` model out of the box) or OpenAI. Switching
  providers / models invalidates the cached vectors automatically via
  the snapshot envelope. Tools register even when no provider is
  configured so they're discoverable; calls return a configuration
  hint until set up.
- **Elicitation flow on permanent delete.** When the connected client
  advertises `elicitation: { form: {} }`, `delete_note(permanent: true)`
  asks the user to retype the note path before the unlink commits. Falls
  through silently for clients that don't support elicitation; the
  existing `destructiveHint: true` annotation still gives the host a
  chance to confirm.

## [1.7.2] - 2026-05-01

### Fixed

- **HTTP transport now supports reconnects and concurrent clients.**
  Previously, `--transport=http` shared one `McpServer` across the entire
  process and re-`connect()`d it on every `initialize`. The MCP SDK's
  underlying `Protocol` rejects a second `connect()` while a transport is
  still attached, so every reconnect (client restart, IDE reload) and every
  second concurrent client returned HTTP 500 with
  `"Already connected to a transport. Call close() before connecting to a
  new transport, or use a separate Protocol instance per connection."`
  Each `initialize` now builds a fresh `McpServer`; GC reclaims it once the
  transport closes. Stdio transport is unaffected (one session per process).
  Reported by @j-menzies in
  [#8](https://github.com/rps321321/obsidian-mcp-pro/issues/8).
- HTTP-mode log forwarding via `notifications/message` is removed as part
  of this fix; the singleton it relied on is gone. Stderr remains the
  source of truth for HTTP operators (which is where the MCP host already
  surfaces server logs to humans). Stdio mode keeps log forwarding.
- **DNS rebinding `allowedHosts` now uses the actually-bound port** rather
  than the requested port. When callers passed `port: 0` (tests, embedders
  that don't care about a specific port) the previous list contained
  `:0` literally, so every real request was rejected with
  `"Invalid Host header"`. The list is now populated after `listen()`
  returns the OS-assigned port.

### Tests

- New regression tests in `src/__tests__/http-server.test.ts`: a sequential
  reconnect (close session A, then connect session B) and two concurrent
  sessions on the same server, both driven through the SDK's
  `StreamableHTTPClientTransport`.

## [1.7.1] - 2026-04-28

### Documentation

- README refreshed: test count, "What's New" section, and tool reference
  updated for v1.6.0 + v1.7.0 features (move_note / delete_note reference
  handling, TOCTOU correctness, control-char injection defense). No code
  change — patch bump exists solely to refresh the README on the npm
  registry, which is locked at publish time.

## [1.7.0] - 2026-04-28

### Added

- **`delete_note` can now strip references vault-wide** when `permanent: true`
  is paired with `removeReferences: true`. Wikilinks fall back to their alias
  (or the deleted file's basename); markdown links fall back to their visible
  text; embeds (`![[...]]`, `![text](...)`) are removed entirely since they
  have no textual fallback. Fragments (`#heading`, `#^block`) are dropped
  because the target is gone. References are never rewritten when the file
  moves to `.trash` (default), since trashed files are recoverable and
  silently editing references would destroy information the user could
  otherwise restore. Closes [#7](https://github.com/rps321321/obsidian-mcp-pro/issues/7).
- `lib/link-rewriter.ts`: `planDeleteRewrites` (mirrors `planMoveRewrites`,
  reuses `applyRewrites`). Canvas references are not auto-cleaned on delete
  — separate decision tracked elsewhere.
- `lib/vault.ts`: `DeleteNoteOptions`, `DeleteNoteResult` exports.

### Changed

- **`move_note` (with `updateLinks: true`) and `delete_note` (with
  `removeReferences: true`) now serialize per vault.** A new vault-level
  lock wraps the entire plan + rename/delete + apply sequence so concurrent
  rewrite-bearing operations can't see each other's mid-flight state. The
  per-edit `expected: string` content check from v1.6.0 already turned
  cross-operation races into reported failures rather than corruption;
  this lock removes the partial-failure mode entirely. `updateLinks: false`
  and `removeReferences: false` paths bypass the vault lock so simple
  renames and trash-deletes stay concurrent. Closes
  [#5](https://github.com/rps321321/obsidian-mcp-pro/issues/5).
- **Internal API:** `deleteNote(vaultPath, path, useTrash)` is now
  `deleteNote(vaultPath, path, options)`. The previous boolean form is
  removed. The MCP `delete_note` tool surface is unaffected — its input
  schema gained a new optional `removeReferences` field, existing calls
  continue to work unchanged.

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
