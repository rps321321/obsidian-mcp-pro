# obsidian-mcp-pro

**The most feature-complete MCP server for Obsidian vaults.**

⭐ **Please [star us on GitHub](https://github.com/rps321321/obsidian-mcp-pro) — it helps us reach more users!**

[![Ko-fi](https://img.shields.io/badge/Support_on-Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/rps321)

💙 **Support this project** — obsidian-mcp-pro is free and open-source. If it saves you time, consider [buying me a coffee on Ko-fi](https://ko-fi.com/rps321).

[![obsidian-mcp-pro MCP server](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro/badges/card.svg)](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro)

[![npm version](https://img.shields.io/npm/v/obsidian-mcp-pro.svg)](https://www.npmjs.com/package/obsidian-mcp-pro)
[![npm downloads](https://img.shields.io/npm/dm/obsidian-mcp-pro.svg)](https://www.npmjs.com/package/obsidian-mcp-pro)
[![GitHub stars](https://img.shields.io/github/stars/rps321321/obsidian-mcp-pro?style=flat&logo=github)](https://github.com/rps321321/obsidian-mcp-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-449_passing-brightgreen.svg)](https://github.com/rps321321/obsidian-mcp-pro)
[![Tool Quality](https://img.shields.io/badge/Glama-23_tools_A--grade-success)](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro)

Give AI assistants deep, structured access to your Obsidian knowledge base. Read, write, search, tag, analyze links, traverse graphs, manipulate canvases, query Bases, edit by heading or block reference, run semantic search, and pull binary attachments. All through the [Model Context Protocol](https://modelcontextprotocol.io/).

**41 tools, 5 prompts, 3 resources.** Every tool ships with rich descriptions, typed schemas, human-readable titles, and safety annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so your agent picks the right tool, passes the right arguments, and handles results correctly. The original 23 tools earned an average 4.40/5 score and all-A grades on [Glama's quality index](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro); the 18 newer ones follow the same authoring conventions documented in [docs/TOOL_AUTHORING.md](./docs/TOOL_AUTHORING.md).

---

## Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Security](#security)
- [Wikilink Resolution](#wikilink-resolution)
- [Tool Reference](#tool-reference)
- [MCP Resources](#mcp-resources)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Testing](#testing)
- [What's New](#whats-new)
- [Contributing](#contributing)
- [License](#license)

---

## Features

### Read & Search
- Full-text search across all vault notes (cached: re-runs only re-read changed files)
- Read individual notes whole, or as a fragment by heading path, block id, or line range
- List and filter notes by folder, date, or pattern
- Search by frontmatter fields and values
- Retrieve daily notes automatically using the vault's configured filename format
- `get_recent_notes` orders by mtime; `get_vault_stats` reports counts, words, tag coverage; `resolve_alias` translates a display name to a real note path

### Write & Modify
- Create new notes with frontmatter and content
- Append or prepend content to existing notes
- Update frontmatter properties programmatically (merge: unlisted keys are preserved)
- Move and rename notes (rewrites every wikilink, markdown link, and canvas reference across the vault by default)
- Delete notes safely; moved to the vault's `.trash` folder by default, with an optional permanent flag and elicitation-based confirmation
- Surgical edits by heading: `update_section`, `insert_at_section`, `list_sections`, plus single-note `replace_in_note` (regex with match-count guard) and `edit_block` for paragraphs tagged with `^id`

### Tags
- Build and query a complete tag index (incremental: cached across runs)
- Search notes by single or multiple tags
- `rename_tag` rewrites both inline `#tag` occurrences and frontmatter `tags:` arrays vault-wide; hierarchical mode also rebases nested sub-tags (`project/alpha` follows `project`)

### Links & Graph
- Get backlinks (what links *to* a note)
- Get outlinks (what a note links *to*)
- Find orphan notes with no inbound or outbound links
- Detect broken links pointing to non-existent notes
- Traverse graph neighbors to a configurable depth

### Canvas
- Read `.canvas` files with full node and edge data
- Add new nodes (text, file, link, group) to canvases
- Add edges between canvas nodes
- List all canvases in the vault

### Bases (Obsidian 1.10+)
- `list_bases` enumerates `.base` files
- `read_base` returns the parsed YAML (filters, properties, views)
- `query_base` runs the filter DSL against the vault and returns matching notes; supports `taggedWith()`, `file.hasTag()`, `file.inFolder()`, comparison operators, and `and`/`or`/`not` combinators

### Attachments
- `list_attachments` enumerates every non-md/canvas/base file with a per-extension count summary
- `find_unused_attachments` flags assets no note references via embeds or markdown links; optional reclaimable-bytes report
- `get_attachment` returns image / audio / blob bytes inline as MCP content blocks (5 MB default cap, 50 MB hard cap)

### Semantic Search (optional, Ollama or OpenAI)
- `index_vault` chunks each note (heading-aware), embeds via the configured provider, persists vectors to `<vault>/.obsidian/cache/`, and incrementally re-embeds only changed notes
- `search_semantic` ranks notes by cosine similarity against an embedded query
- `find_similar_notes` reuses an existing note's embeddings to surface neighbors without a live API call

### MCP Resources
- `obsidian://note/{path}` reads any note by its vault-relative path
- `obsidian://tags` retrieves the full tag index as JSON
- `obsidian://daily` gets today's daily note content

### MCP Prompts
The server exposes five starter prompts that clients (Claude Desktop, Cursor) surface in their slash-command palette:

- `daily-review` walks today's daily note, surfaces unchecked tasks, and proposes follow-ups
- `weekly-rollup` aggregates the last seven daily notes into themes / decisions / open tasks
- `find-stale-notes` locates untouched notes and clusters them as orphaned vs. broken-linked vs. still-linked
- `extract-action-items` pulls all `- [ ] …` lines from a note (or every note matching a tag) into a checklist
- `build-moc` generates a Map of Content (MOC) for a tag or folder

### Operational features
- **Folder-scoped permissions**: `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS` allowlists gate every tool at the path-resolution choke point
- **Persistent mtime cache** at `<vault>/.obsidian/cache/mcp-pro-index-cache.json` survives restarts; subsequent vault scans serve from cache after one stat-pass
- **Progress notifications** (`notifications/progress`) on `rename_tag`, `find_unused_attachments`, and `index_vault` when the client subscribes via `_meta.progressToken`
- **Elicitation** prompts the user to retype the note path on `delete_note(permanent: true)` when the client supports it

---

## Quick Start

> **Using Obsidian?** There's also an [Obsidian plugin](https://github.com/rps321321/obsidian-mcp-pro-plugin) that runs this server inside the app with a ribbon toggle and settings UI — no config-file editing. Recommended for most users.

### One-Command Install (Claude Desktop / Cursor)

```bash
npx -y obsidian-mcp-pro install
```

This merges an entry into your `claude_desktop_config.json` (or `~/.cursor/mcp.json` with `--client=cursor`), backs up the previous file, and prints next steps. Works on macOS, Windows, and Linux.

Pin a specific vault:

```bash
npx -y obsidian-mcp-pro install --vault /path/to/your/vault
```

### Manual Claude Desktop Config

Add this to your Claude Desktop configuration file (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp-pro"]
    }
  }
}
```

If you have multiple vaults, specify which one:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp-pro"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add obsidian-mcp-pro -- npx -y obsidian-mcp-pro
```

### HTTP Transport (Remote Clients, Cursor, ChatGPT, Web)

```bash
npx -y obsidian-mcp-pro --transport=http --port=3333
```

Endpoint: `http://127.0.0.1:3333/mcp` (Streamable HTTP). Protect with a bearer token:

```bash
npx -y obsidian-mcp-pro --transport=http --token=your-secret
# or: MCP_HTTP_TOKEN=your-secret npx -y obsidian-mcp-pro --transport=http
```

The HTTP server binds to `127.0.0.1` by default with DNS rebinding protection enabled.

> [!WARNING]
> **Never bind `--host=0.0.0.0` directly to the public internet.** Doing so exposes your entire Obsidian vault to anyone who can reach the port. If you need remote access:
> - Put the server behind a reverse proxy (nginx, Caddy, Cloudflare Tunnel) that terminates TLS, **and**
> - Require `--token=<secret>` (or `MCP_HTTP_TOKEN`), **and**
> - Restrict `--allow-origin` to the specific origins you trust, **and**
> - Set `--rate-limit` to cap request volume per IP.
>
> For local-only setups (same machine / VPN / SSH tunnel), keep the default `127.0.0.1` bind.

Additional hardening flags:

| Flag | Purpose |
|------|---------|
| `--allow-origin=<csv>` | Restrict CORS to an allowlist (e.g. `https://claude.ai,https://chat.openai.com`). Default is `*`. |
| `--rate-limit=<n>` | Cap requests per minute per client IP. `/health` and `/version` are exempt. Default is unlimited. |

Operational endpoints (no auth required):

| Endpoint | Returns |
|----------|---------|
| `GET /health` | `{ status: "ok", sessions: <n>, version: <string> }` — liveness + session count. |
| `GET /version` | `{ version: <string> }` — package version, for rollout auditing. |

Structured logging is controlled by `LOG_LEVEL` (`debug`/`info`/`warn`/`error`/`silent`, default `info`) and `LOG_FORMAT` (`text`/`json`, default `text`). All logs go to stderr so the stdio transport on stdout is never polluted.

---

## Usage

Once installed, the server exposes 23 tools and 3 resources to whichever MCP client you configured. Below is a transcript of a Claude Desktop conversation showing what day-to-day use looks like.

> **You:** Find notes tagged `#project` I touched this week, then summarize the status of each and append today's date under a "Last reviewed" heading in each one.

Claude picks the right tools in order, with no guidance beyond the prompt:

```text
🔧 search_by_tag(tag="project", includeContent=false)
  → 7 notes: "Atlas/overview.md", "Atlas/milestones.md", "Beacon/spec.md", ...

🔧 list_notes(folder="Atlas", limit=100)
  → filters to recent modifications via get_note stats

🔧 get_note(path="Atlas/overview.md")
  → reads content + frontmatter + tags

🔧 get_note(path="Atlas/milestones.md")
  → ...

🔧 append_to_note(
    path="Atlas/overview.md",
    content="\n## Last reviewed\n2026-04-21 — on track; waiting on design review."
  )
  → ok

🔧 append_to_note(
    path="Atlas/milestones.md",
    content="\n## Last reviewed\n2026-04-21 — Q2 milestone at risk, see spec.md."
  )
  → ok
```

> **Claude:** I reviewed 7 project notes tagged `#project`. Atlas is on track pending design review; the Q2 milestone is at risk — details in `milestones.md`. Beacon's spec is complete but has 3 open questions in the frontmatter. I appended a "Last reviewed" section to each.

Other things the tool set lets agents do without hand-holding:

- **Research a topic across the vault.** `search_notes` → `get_outlinks` → `get_graph_neighbors` walks the graph to `depth=2` and surfaces related notes the user may have forgotten.
- **Clean up dangling references after a rename.** `move_note` → `find_broken_links` returns every wikilink that now points nowhere, with source note and line number.
- **Maintain a daily log.** `get_daily_note` reads today's note (using the vault's configured date format) and `append_to_note` adds the new entry — daily-note plugin config is honored, no manual date formatting.
- **Canvas editing.** `read_canvas` → agent reasons about the node graph → `add_canvas_node` + `add_canvas_edge` lays out new ideas on an existing board.

Tool descriptions + typed schemas + safety hints (`readOnlyHint`, `destructiveHint`) are what make this work reliably — the agent knows `delete_note` is destructive and asks first, knows `search_notes` is free to call speculatively, and knows the expected shape of every argument.

---

## Configuration

The server locates your vault using the following priority:

| Priority | Method | Description |
|----------|--------|-------------|
| 1 | `OBSIDIAN_VAULT_PATH` | Environment variable with the absolute path to your vault |
| 2 | `OBSIDIAN_VAULT_NAME` | Environment variable to select a vault by folder name when multiple vaults exist |
| 3 | Auto-detection | Reads Obsidian's global config (`obsidian.json`) and uses the first valid vault found |

Auto-detection works on **macOS**, **Windows**, and **Linux** by reading the platform-specific Obsidian configuration directory.

### Daily-Note Filename Format

`get_daily_note`, `create_daily_note`, and the `obsidian://daily` resource render the note path using your vault's `.obsidian/daily-notes.json` `format` string. Moment.js-style tokens are supported:

| Token | Example | | Token | Example |
|-------|---------|-|-------|---------|
| `YYYY` | `2026` | | `dddd` | `Thursday` |
| `YY` | `26` | | `ddd` | `Thu` |
| `MMMM` | `April` | | `dd` | `Th` |
| `MMM` | `Apr` | | `HH` / `H` | `05` / `5` |
| `MM` / `M` | `04` / `4` | | `hh` / `h` | `05` / `5` |
| `DD` / `D` | `09` / `9` | | `mm` / `m` | `07` / `7` |
| `Do` | `9th` | | `ss` / `s` | `03` / `3` |
| `DDDD` / `DDD` | `099` / `99` | | `Q` | `2` |
| `[literal]` | renders the bracket contents verbatim, e.g. `YYYY-[Q]Q` → `2026-Q2` |

Unrecognized tokens pass through unchanged. Local time is used (matching Obsidian's rendering).

### Folder-Scoped Permissions

Restrict the tools' read/write surface to specific folders without exposing the rest of the vault:

| Env var | Purpose |
|---------|---------|
| `OBSIDIAN_READ_PATHS` | Comma- or colon-separated list of folders that read tools may access. Unset means unrestricted. Use `.` to mean the vault root. |
| `OBSIDIAN_WRITE_PATHS` | Same shape, but for mutations (create / append / update / delete / move / surgical edits). |

Read and write are independent, so an audit account can be read-only on most of the vault but write-only to a `Drafts/` folder. The startup log line and `--help` advertise the active scope. The allowlist is enforced at a single path-resolution choke point so every tool inherits it.

### Persistent Caches

Two caches live under `<vault>/.obsidian/cache/`:

| File | Purpose |
|------|---------|
| `mcp-pro-index-cache.json` | mtime-keyed snapshot of recently read notes. The next process start hydrates from this and stat-passes against the live filesystem; only changed notes are re-read. |
| `mcp-pro-embeddings.json` | Persisted embeddings for semantic search (only present once `index_vault` has run). Vault-relocation safe via an embedded `vaultRoot` check; switching providers / models invalidates entries automatically. |

Both are vault-local, are excluded from vault scans (`.obsidian/` is pruned), and can be deleted at any time. Persistence can be turned off entirely with `OBSIDIAN_CACHE_DISABLED=1`.

### Semantic Search Provider

The semantic-search tools (`index_vault`, `search_semantic`, `find_similar_notes`) need an embedding provider. Configure via env:

| Env var | Default | Notes |
|---------|---------|-------|
| `OBSIDIAN_EMBEDDING_PROVIDER` | `ollama` | `ollama`, `openai`, or `none` to disable. |
| `OBSIDIAN_EMBEDDING_MODEL` | `nomic-embed-text` (Ollama), `text-embedding-3-small` (OpenAI) | Provider-specific model identifier. |
| `OBSIDIAN_EMBEDDING_URL` | `http://localhost:11434` (Ollama), `https://api.openai.com/v1` (OpenAI) | Base URL. |
| `OBSIDIAN_EMBEDDING_API_KEY` | `OPENAI_API_KEY` falls back if unset | Required for hosted providers. |

For local Ollama: install [Ollama](https://ollama.com/), then `ollama pull nomic-embed-text`. The semantic tools register even when no provider is configured, so they're discoverable; calls return a configuration hint until set up.

### Observability

Logs stream to stderr as either plain text (default) or single-line JSON, controlled by `LOG_LEVEL` (`debug`/`info`/`warn`/`error`/`silent`) and `LOG_FORMAT` (`text`/`json`).

The server also declares the MCP [`logging` capability](https://modelcontextprotocol.io/specification), so every log line is forwarded to the connected client as a `notifications/message` frame alongside tool responses. Clients that honor `logging/setLevel` can filter server-side logs at runtime without restarting. Claude Desktop surfaces these in its MCP DevTools pane; most other clients currently ignore them, so this is useful primarily for self-hosters and tooling authors.

---

## Security

- **Vault boundary** — every tool and resource routes through a single path resolver that rejects `..` traversal, null-byte injection, and symlinks pointing outside the vault (ancestor-realpath check).
- **Excluded directories** — `.obsidian`, `.git`, and `.trash` are pruned at traversal time and at resolution time, so nested occurrences never leak back to clients.
- **HTTP transport** — binds to `127.0.0.1` by default with DNS rebinding protection (host-header allowlist). Optional `--token=<secret>` requires `Authorization: Bearer <secret>` on every `/mcp` request; compared in constant time.
- **Error sanitization** — filesystem error messages are stripped of absolute host paths before being returned to MCP clients. Uncaught HTTP errors respond with a generic `Internal server error` body; full detail stays in the server log.
- **Atomic writes** — every note write (`create_note`, `append`, `prepend`, `update_frontmatter`, canvas mutations) stages content to a sibling temp file then renames onto the target, so a crash or kill mid-write never leaves a truncated file. Combined with per-path locks for the full read-modify-write cycle, concurrent callers can't lose each other's updates. The `install` subcommand uses the same pattern and keeps a backup of the previous config.
- **Rate limiting + CORS allowlist** — optional `--rate-limit` caps per-IP request volume; `--allow-origin` restricts browser-facing CORS. `/health` and `/version` stay reachable under load for monitoring.
- **Request timeout** — HTTP POST requests are capped at 2 minutes of wall-clock time. Long-lived SSE GET streams are exempt so idle clients aren't reaped.
- **Process supervision** — `uncaughtException` exits cleanly so systemd/Docker/npx supervisors can restart; `unhandledRejection` logs but doesn't kill the process.

---

## Wikilink Resolution

`[[Target]]` resolves in the same order Obsidian does:

1. Exact relative-path match (case-insensitive).
2. Path-suffix match (e.g. `[[projects/foo]]` picks `work/projects/foo.md`).
3. Basename match. When multiple notes share a basename, the one that shares the deepest directory prefix with the linking note wins; ties break on shortest overall path.
4. Frontmatter `aliases` — `[[Display Name]]` resolves to a note whose frontmatter declares that alias. `aliases`, `Aliases`, and `ALIASES` are all recognized.

Tag extraction is similarly case-tolerant: `tags`, `Tags`, `TAGS`, `tag`, and `Tag` frontmatter keys are all read.

---

## Tool Reference

### Read

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `search_notes` | Full-text search across all notes (cached) | `query`, `caseSensitive`, `maxResults`, `folder` |
| `get_note` | Read a note whole, or by `section` / `block` / `lines` | `path`, `section`, `block`, `lines` |
| `list_notes` | List notes in the vault or a folder | `folder`, `limit` |
| `get_daily_note` | Get today's (or a specific date's) daily note | `date` |
| `search_by_frontmatter` | Find notes by frontmatter property values | `property`, `value`, `folder` |
| `get_recent_notes` | Notes sorted by mtime; optional ISO-or-relative `since` filter | `limit`, `since`, `folder` |
| `get_vault_stats` | Vault counts, bytes, words, tag coverage, most-recent note | `folder` |
| `resolve_alias` | Translate frontmatter alias (or basename) to note path | `name`, `includeBasename` |

### Write

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `create_note` | Create a new note with content and frontmatter | `path`, `content`, `frontmatter` |
| `append_to_note` | Append content to an existing note | `path`, `content`, `ensureNewline` |
| `prepend_to_note` | Prepend content after frontmatter | `path`, `content` |
| `update_frontmatter` | Update frontmatter properties on a note | `path`, `properties` |
| `create_daily_note` | Create today's daily note from template | `date`, `content`, `templatePath` |
| `move_note` | Move or rename a note; rewrites references across the vault | `oldPath`, `newPath`, `updateLinks` |
| `delete_note` | Delete a note (trash by default); optional elicitation on permanent | `path`, `permanent`, `removeReferences` |

### Section-level edits

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `update_section` | Replace the body under a heading path (heading kept) | `path`, `section`, `newBody` |
| `insert_at_section` | Insert at `before` / `after-heading` / `append` of a section | `path`, `section`, `content`, `position` |
| `list_sections` | Return the heading outline of a note as an indented tree | `path` |
| `replace_in_note` | Find/replace within one note (literal or regex, with match-count guard) | `path`, `find`, `replace`, `regex`, `flags`, `expectedCount` |
| `edit_block` | Replace content of a paragraph tagged `^id` (anchor preserved) | `path`, `block`, `newContent` |

### Tags

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_tags` | Get all tags and their usage counts | `sortBy` |
| `search_by_tag` | Find all notes with a specific tag | `tag`, `includeContent` |
| `rename_tag` | Rewrite inline + frontmatter occurrences vault-wide; hierarchical | `oldName`, `newName`, `hierarchical`, `dryRun` |

### Links & graph

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `get_backlinks` | Get all notes that link to a given note | `path` |
| `get_outlinks` | Get all links from a given note | `path` |
| `find_orphans` | Find notes with no links in or out | `includeOutlinksCheck` |
| `find_broken_links` | Detect links pointing to non-existent notes | `folder` |
| `get_graph_neighbors` | Get notes connected within N link hops | `path`, `depth`, `direction` |

### Canvas

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_canvases` | List all `.canvas` files in the vault | (none) |
| `read_canvas` | Read a `.canvas` file's nodes and edges | `path` |
| `add_canvas_node` | Add a node to a canvas | `canvasPath`, `type`, `content`, `x`, `y` |
| `add_canvas_edge` | Add an edge between two canvas nodes | `canvasPath`, `fromNode`, `toNode` |

### Bases

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_bases` | Enumerate `.base` files in the vault | (none) |
| `read_base` | Parse a Base file (filters, properties, views) | `path` |
| `query_base` | Run a Base's filter DSL against the vault | `path`, `view`, `limit`, `includeFrontmatter` |

### Attachments

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list_attachments` | Enumerate every non-md/canvas/base file | `extension`, `limit` |
| `find_unused_attachments` | Attachments not referenced via embeds or markdown links | `limit`, `includeBytes` |
| `get_attachment` | Return image / audio / blob content (5 MB default cap) | `path`, `maxBytes` |

### Semantic search

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `index_vault` | Build / refresh the embedding index (incremental, progress events) | `force`, `folder` |
| `search_semantic` | Cosine search the embedding index for a natural-language query | `query`, `limit`, `folder`, `includeSnippet` |
| `find_similar_notes` | Surface notes most similar to a source note (no live API call) | `path`, `limit` |

---

## MCP Resources

Resources provide a URI-based way to access vault data:

| Resource URI | Description |
|-------------|-------------|
| `obsidian://note/{path}` | Read any note by its vault-relative path |
| `obsidian://tags` | Full tag index with file lists (JSON) |
| `obsidian://daily` | Today's daily note content |

---

## Troubleshooting

### Tools Don't Show Up in Claude Desktop

MCP clients only re-read their config on startup. After editing `claude_desktop_config.json` (or running `npx obsidian-mcp-pro install`), fully quit Claude Desktop (⌘Q on macOS, tray → Quit on Windows) and relaunch. Hot-reloading the window is not enough.

### "No Obsidian vault configured" on Startup

The server couldn't locate a vault. Resolution order is:

1. `OBSIDIAN_VAULT_PATH` env var (absolute path) — always wins if set.
2. `OBSIDIAN_VAULT_NAME` env var — picks a named vault from Obsidian's global config.
3. Auto-detection — reads `obsidian.json` (platform-specific) and uses the first valid vault found.

Fastest fix: set `OBSIDIAN_VAULT_PATH` in the `env` block of your MCP client's config. Auto-detection fails when Obsidian has never been launched, `obsidian.json` is missing/corrupt, or all registered vaults resolve to paths that no longer exist.

### "Path traversal detected" Error on Tool Calls

All tool paths must be **vault-relative** (e.g. `notes/hello.md`), never absolute (`/Users/me/vault/notes/hello.md`) or containing `..`. The agent normally gets this right — if you see this error, check whether a custom instruction is asking it to use absolute paths.

### HTTP Transport Returns `401 Unauthorized`

The server was started with `--token=<secret>` (or `MCP_HTTP_TOKEN` is set in the environment) but the client isn't sending a matching `Authorization: Bearer <secret>` header. Verify the token value and that the header is present — comparison is case-sensitive and constant-time.

### HTTP Transport Returns `429 Too Many Requests`

`--rate-limit=<n>` is set and the client exceeded N requests in the last 60 seconds from that IP. Either raise the limit, drop it, or wait 60 seconds. `/health` and `/version` are exempt if you need to check liveness under load.

### Daily-Note Path Is Wrong or Unresolved

The server reads `.obsidian/daily-notes.json` from the vault for the filename format and folder. If that file doesn't exist (the Daily Notes core plugin has never been configured), the server falls back to `YYYY-MM-DD.md` in the vault root. Configure the plugin once inside Obsidian and the server picks it up automatically.

### `npx obsidian-mcp-pro` Silently Exits With Code 0

This was a bug in versions < 1.4.1 where the `npx`-symlinked CLI entry failed to detect itself as the entrypoint. Upgrade: `npx -y obsidian-mcp-pro@latest install`.

### Windows: "EPERM: operation not permitted" During Writes

The server retries these transparently (Windows holds stricter file-sharing locks than POSIX) — if you still see the error, it usually means antivirus or a sync client (OneDrive, Dropbox) is holding the file. Exclude the vault folder from real-time antivirus scanning, or pause the sync client during heavy agent sessions.

---

## Development

```bash
# Clone the repository
git clone https://github.com/rps321321/obsidian-mcp-pro.git
cd obsidian-mcp-pro

# Install dependencies
npm install

# Build
npm run build

# Run in development (watch mode)
npm run dev

# Start the server locally
OBSIDIAN_VAULT_PATH=/path/to/vault npm start
```

### Project Structure

```
src/
  index.ts                # Server entry, CLI parser, resource + prompt registration
  config.ts               # Vault detection, daily-notes config loader
  http-server.ts          # Streamable HTTP transport, Bearer auth, session TTL
  install.ts              # `install` subcommand (Claude Desktop / Cursor)
  types.ts                # Shared TypeScript interfaces
  lib/
    vault.ts              # Core vault ops (read, search, list, per-file locks,
                          # symlink boundary, canvas + base + attachment round-trip)
    permissions.ts        # OBSIDIAN_READ_PATHS / OBSIDIAN_WRITE_PATHS allowlist
    markdown.ts           # Frontmatter, wikilinks, tags, alias-aware resolver
    sections.ts           # Heading parser, block-id parser, section bounds
    tag-rewriter.ts       # Vault-wide tag rewriting (inline + frontmatter)
    link-rewriter.ts      # Plan/apply edit pipeline used by move + delete
    bases.ts              # Bases YAML parser + filter DSL evaluator
    chunker.ts            # Heading-aware chunking for embeddings
    embedding-providers.ts# Ollama + OpenAI providers
    embedding-store.ts    # Persistent vector index, cosine search
    index-cache.ts        # mtime-keyed content cache (in-memory + on-disk)
    progress.ts           # MCP progress-notification helper
    mime.ts               # extension -> MIME map for attachments
    dates.ts              # Moment-style date format for daily-note filenames
    errors.ts             # sanitizeError: strips absolute paths from fs errors
    concurrency.ts        # Bounded-concurrency fan-out helper
    logger.ts             # Leveled stderr logger (text + JSON modes)
  tools/
    read.ts               # search, get, list, daily, frontmatter, recent, stats, alias
    write.ts              # create, append, prepend, update_frontmatter, move, delete
    sections.ts           # update_section, insert_at_section, list_sections,
                          # replace_in_note, edit_block
    tags.ts               # get_tags, search_by_tag, rename_tag
    links.ts              # backlinks, outlinks, orphans, broken, graph_neighbors
    canvas.ts             # list, read, add_node, add_edge
    bases.ts              # list_bases, read_base, query_base
    attachments.ts        # list_attachments, find_unused_attachments, get_attachment
    semantic.ts           # index_vault, search_semantic, find_similar_notes
    prompts.ts            # daily-review, weekly-rollup, find-stale-notes,
                          # extract-action-items, build-moc
  __tests__/
    vault.test.ts            markdown.test.ts            tools.test.ts
    security.test.ts         http-server.test.ts         semantics.test.ts
    logger.test.ts           sections.test.ts            tag-rewriter.test.ts
    bases.test.ts            permissions.test.ts         index-cache.test.ts
    chunker.test.ts          embedding-store.test.ts     errors.test.ts
    link-rewriter.test.ts
    handlers/
      read.test.ts          write.test.ts          tags.test.ts
      links.test.ts         canvas.test.ts         attachments.test.ts
      semantic.test.ts      harness.ts
```

---

## Testing

```bash
npm test
```

449 tests covering vault operations, atomic writes + concurrent-mutation races, markdown parsing (frontmatter, wikilinks, tags, fenced + indented code blocks, multi-backtick inline code), section / block-id parsing, tag rewriting (inline + frontmatter, hierarchical sub-tags), Bases filter DSL, attachment classification, semantic chunking + cosine ranking + persistent embedding store, moment-token date formatting, canvas round-trip fidelity, HTTP transport (Bearer auth, oversize-body, CORS allowlist with `Vary: Origin`, per-IP rate limiting, `/version`), leveled logger (text + JSON output), folder-permission allowlist, mtime-cache rehydration across simulated restarts, vault-wide link rewriting on `move_note` and `delete_note` (TOCTOU correctness, control-char injection escape), and security regression guards (symlink escape, case-only rename, path-leak sanitization, cross-process exclusive-create). Handler tests exercise every tool through a real MCP client/server pair via `InMemoryTransport`.

```bash
npm run lint       # eslint v9 + typescript-eslint v8 (flat config)
npm run lint:fix   # auto-fix
```

---

## What's New

**v1.8.2** rolls in a deeper-dive audit pass on top of 1.8.1:

- **`rename_tag` and other vault-wide bulk writers now hold the same
  rewrite lock as `move_note` / `delete_note`.** Closes a cross-tool
  TOCTOU where running tag-rename concurrently with a move could
  surface "content changed during move" failures and leave stale
  links.
- **`applyRewrites` retries failed edits via content search.** When
  bytes shift between plan and apply (Obsidian sync, text editor,
  concurrent tool), the apply step now finds the unique `expected`
  substring at its new position and splices there. If ambiguous or
  missing, the failure is still surfaced rather than corrupting the
  file.
- **`planMoveRewrites` and `planDeleteRewrites` now read each note
  exactly once.** The previous two-pass implementation doubled I/O
  on rename / delete operations across large vaults.
- **CommonMark fenced-code indentation now matches the spec.** Lines
  with more than 3 leading spaces no longer falsely close a fenced
  block (and don't expose subsequent content to wikilink rewriting).
- **`/health` no longer leaks the live session count when a Bearer
  token is configured.** Status + version stay public for monitoring;
  `sessions` is dropped in authenticated deployments. Local-only
  setups still see it.
- **`constantTimeEqual` is now fully length-safe** (pads both inputs
  to a fixed width before comparing), and the regex / parser hardening
  list also closed: `resolveWikilink` proximity tie-break for
  path-suffix matches, escaped `]` in markdown link labels, control-
  character validation on `runInstall.vaultName`, backup-path hint on
  install write failure, and `mapConcurrent` return-value usage in the
  canvas planner.
- **`npm audit` clean.** Resolved 4 moderate-severity advisories in
  transitive devDependencies. Production deps were already clean.

**v1.8.1** was a security and correctness patch on top of 1.8.0:

- **CRITICAL: permission allowlist bypass via `..` segments closed.**
  v1.8.0 evaluated `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS`
  against the raw user-supplied path before `path.resolve` collapsed
  `..`. An input like `Allowed/../OtherFolder/note.md` slipped past
  the prefix check. `assertAllowed` now collapses `..` via
  `path.posix.normalize` and rejects any path that climbs above its
  starting point. Six regression tests cover the bypass classes.
- **HIGH: HTTP timeout on every embedding-provider fetch
  (`AbortSignal.timeout(30s)`)**, TOCTOU race in `rename_tag`
  closed by moving the rewrite inside `updateNote`'s transform, and
  `search_semantic` / `find_similar_notes` now invalidate stale
  vectors when the active provider/model differs from what produced
  the index.
- **MEDIUM: depth guard on Bases filter recursion**, `updateNote`
  skips the disk write when the transform returns unchanged content
  (no more spurious mtime bumps on no-op tools), and
  embedding-provider error bodies are truncated to 200 chars before
  being interpolated into thrown errors.
- **LOW: empty `accept` elicitation responses are now cancellations,
  not errors**, and the in-memory mtime cache snapshot orders by
  content length so small entries fill the budget first.

**v1.8.0** was the largest feature drop since v1.0:

- **Surgical edits by heading and block id.** `update_section`, `insert_at_section`, `list_sections`, `replace_in_note`, `edit_block`, plus fragment retrieval modes on `get_note` (`section`, `block`, `lines`).
- **Bases support.** `list_bases`, `read_base`, `query_base` for Obsidian's database-view files. First filesystem-only MCP server to ship native Bases.
- **Semantic search.** `index_vault`, `search_semantic`, `find_similar_notes` backed by Ollama (default) or OpenAI. Persistent vector index with content-hash incremental updates.
- **Attachments.** `list_attachments`, `find_unused_attachments`, `get_attachment` (returns image / audio / blob bytes inline).
- **Tag renames vault-wide.** `rename_tag` rewrites both inline `#tag` and frontmatter `tags:` (hierarchical mode rebases nested sub-tags).
- **Folder-scoped permissions.** `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS` allowlists.
- **Persistent mtime cache.** Vault-wide scans (`get_tags`, `search_notes`, `search_by_tag`) hydrate from `<vault>/.obsidian/cache/mcp-pro-index-cache.json` after a restart and stat-pass against current state, only re-reading changed notes.
- **Quick wins.** `get_recent_notes`, `get_vault_stats`, `resolve_alias`.
- **MCP prompts.** `daily-review`, `weekly-rollup`, `find-stale-notes`, `extract-action-items`, `build-moc`.
- **Progress notifications** on `rename_tag`, `find_unused_attachments`, `index_vault`.
- **Elicitation** on `delete_note(permanent: true)` for clients that support it.
- **eslint** wired up with typescript-eslint flat config; `npm run lint` and `lint:fix`.

**v1.7.0** — `delete_note` reference handling:

- **`delete_note` can strip references vault-wide** when `permanent: true` is paired with `removeReferences: true`. Wikilinks fall back to alias-or-basename, markdown links fall back to visible text, embeds drop entirely, fragments are discarded. Trash-mode (default) leaves references intact since trashed files stay recoverable.
- **Concurrent-safe rewrites** — `move_note` (with `updateLinks: true`) and `delete_note` (with `removeReferences: true`) serialize per vault, removing the partial-failure mode for parallel rewrite-bearing operations.

**v1.6.0** — Obsidian-parity link maintenance:

- **`move_note` rewrites references across the vault by default**, matching Obsidian's "Automatically update internal links" behavior. Wikilinks (with aliases / fragments preserved), markdown links, and canvas `nodes[].file` fields all follow the moved file. Output form is preserved when possible.
- **TOCTOU correctness** — every edit's pre-edit content is verified before splicing, so a parallel `write_note` between plan and apply is surfaced in `failedReferrers` rather than corrupting referrers silently.
- **Control-char injection defense** — `sanitizeError` and the new `escapeControlChars` strip newlines/control bytes from any caller-controlled string before it reaches LLM context. Closes a prompt-injection vector via attacker-named filenames.

Full version history in [CHANGELOG.md](./CHANGELOG.md).

---

## License

MIT

---

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change. Pull requests without a corresponding issue may be closed.

If you're adding or editing a tool, read [docs/TOOL_AUTHORING.md](./docs/TOOL_AUTHORING.md) first — it documents the description, schema, and annotation conventions that keep every tool at A-grade quality.

---

## Acknowledgments

- Vault-wide link rewriting on `move_note` ([#3](https://github.com/rps321321/obsidian-mcp-pro/issues/3), [#4](https://github.com/rps321321/obsidian-mcp-pro/pull/4)) and the `sanitizeError` defense-in-depth hardening contributed by [@brentkearney](https://github.com/brentkearney).

For the full list of everyone who's contributed, see the [contributors page](https://github.com/rps321321/obsidian-mcp-pro/graphs/contributors).
