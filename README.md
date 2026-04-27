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
[![Tests](https://img.shields.io/badge/tests-173_passing-brightgreen.svg)](https://github.com/rps321321/obsidian-mcp-pro)
[![Tool Quality](https://img.shields.io/badge/Glama-all_23_tools_A--grade-success)](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro)

Give AI assistants deep, structured access to your Obsidian knowledge base. Read, write, search, tag, analyze links, traverse graphs, and manipulate canvases — all through the [Model Context Protocol](https://modelcontextprotocol.io/).

Every one of the 23 tools ships with rich descriptions, typed schemas, human-readable titles, and safety annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so your agent picks the right tool, passes the right arguments, and handles results correctly — with an average **4.40/5** score and all 23 tools rated A on [Glama's quality index](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro).

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
- Full-text search across all vault notes
- Read individual notes with frontmatter parsing
- List and filter notes by folder, date, or pattern
- Search by frontmatter fields and values
- Retrieve daily notes automatically

### Write & Modify
- Create new notes with frontmatter and content
- Append or prepend content to existing notes
- Update frontmatter properties programmatically (merges — unlisted keys are preserved)
- Move and rename notes (pair with `find_broken_links` to surface any references that need updating)
- Delete notes safely — moved to the vault's `.trash` folder by default, with an optional permanent flag

### Tags
- Build and query a complete tag index
- Search notes by single or multiple tags

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

### MCP Resources
- `obsidian://note/{path}` — read any note by its vault-relative path
- `obsidian://tags` — retrieve the full tag index as JSON
- `obsidian://daily` — get today's daily note content

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

### Observability

Logs stream to stderr as either plain text (default) or single-line JSON — set via `LOG_LEVEL` (`debug`/`info`/`warn`/`error`/`silent`) and `LOG_FORMAT` (`text`/`json`).

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

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `search_notes` | Full-text search across all notes | `query`, `caseSensitive`, `maxResults`, `folder` |
| `get_note` | Read a note's content and metadata | `path` |
| `list_notes` | List notes in the vault or a folder | `folder`, `limit` |
| `get_daily_note` | Get today's (or a specific date's) daily note | `date` |
| `search_by_frontmatter` | Find notes by frontmatter property values | `property`, `value`, `folder` |
| `create_note` | Create a new note with content and frontmatter | `path`, `content`, `frontmatter` |
| `append_to_note` | Append content to an existing note | `path`, `content`, `ensureNewline` |
| `prepend_to_note` | Prepend content after frontmatter | `path`, `content` |
| `update_frontmatter` | Update frontmatter properties on a note | `path`, `properties` |
| `create_daily_note` | Create today's daily note from template | `date`, `content`, `templatePath` |
| `move_note` | Move or rename a note | `oldPath`, `newPath` |
| `delete_note` | Delete a note from the vault | `path`, `permanent` |
| `get_tags` | Get all tags and their usage counts | `sortBy` |
| `search_by_tag` | Find all notes with a specific tag | `tag`, `includeContent` |
| `get_backlinks` | Get all notes that link to a given note | `path` |
| `get_outlinks` | Get all links from a given note | `path` |
| `find_orphans` | Find notes with no links in or out | `includeOutlinksCheck` |
| `find_broken_links` | Detect links pointing to non-existent notes | `folder` |
| `get_graph_neighbors` | Get notes connected within N link hops | `path`, `depth`, `direction` |
| `list_canvases` | List all `.canvas` files in the vault | — |
| `read_canvas` | Read a `.canvas` file's nodes and edges | `path` |
| `add_canvas_node` | Add a node to a canvas | `canvasPath`, `type`, `content`, `x`, `y` |
| `add_canvas_edge` | Add an edge between two canvas nodes | `canvasPath`, `fromNode`, `toNode` |

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
  index.ts           # Server entry, CLI parser, resource registration
  config.ts          # Vault detection, daily-notes config loader
  http-server.ts     # Streamable HTTP transport, Bearer auth, session TTL
  install.ts         # `install` subcommand (Claude Desktop / Cursor)
  types.ts           # Shared TypeScript interfaces
  lib/
    vault.ts         # Core vault ops (read, search, list, per-file locks,
                     # symlink boundary, canvas round-trip)
    markdown.ts      # Frontmatter, wikilinks, tags, alias-aware resolver
    dates.ts         # Moment-style date format for daily-note filenames
    errors.ts        # sanitizeError: strips absolute paths from fs errors
    concurrency.ts   # Bounded-concurrency fan-out helper (tag/link scans)
    logger.ts        # Leveled stderr logger (text + JSON modes)
  tools/
    read.ts          # search_notes, get_note, list_notes, daily, frontmatter
    write.ts         # create, append, prepend, update_frontmatter, move, delete
    tags.ts          # get_tags, search_by_tag
    links.ts         # backlinks, outlinks, orphans, broken, graph_neighbors
    canvas.ts        # list, read, add_node, add_edge
  __tests__/
    vault.test.ts       markdown.test.ts       tools.test.ts
    security.test.ts    http-server.test.ts    semantics.test.ts
    logger.test.ts
```

---

## Testing

```bash
npm test
```

173 tests covering vault operations, atomic writes + concurrent-mutation races, markdown parsing (frontmatter, wikilinks, tags, code-block detection), moment-token date formatting, canvas round-trip fidelity, HTTP transport (Bearer auth, oversize-body, CORS allowlist with `Vary: Origin`, per-IP rate limiting, `/version`), leveled logger (text + JSON output), and security regression guards (symlink escape, case-only rename, path-leak sanitization, cross-process exclusive-create). Runs against Node 20 + 22 on Ubuntu, macOS, and Windows in CI.

---

## What's New

**v1.5.0** — production hardening pass:

- **Atomic writes** on every mutating tool (temp file + rename). Crashes, kills, or OOMs mid-write can no longer leave a truncated note.
- **`create_note` exclusive mode uses OS-level `wx`** so an out-of-process writer (Obsidian itself, a sync client) can't slip between the check and the write.
- **Parallel vault scans** — `search_notes` and the `obsidian://tags` resource fan out 8-way. Order-of-magnitude latency drop on 10K+ note vaults.
- **HTTP hardening** — per-IP `--rate-limit`, `--allow-origin` CORS allowlist (with `Vary: Origin`), POST request timeout, `GET /version` endpoint.
- **Structured logger** with `LOG_LEVEL` / `LOG_FORMAT` env vars (text or JSON, stderr-only).
- **Process supervision** — `uncaughtException` exits cleanly for systemd/Docker; `unhandledRejection` logs without killing the process.

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
