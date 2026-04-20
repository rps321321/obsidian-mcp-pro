# obsidian-mcp-pro

**The most feature-complete MCP server for Obsidian vaults.**

⭐ **Please [star us on GitHub](https://github.com/rps321321/obsidian-mcp-pro) — it helps us reach more users!**

💙 **Support this project** — obsidian-mcp-pro is free and open-source. If it saves you time, consider supporting continued development via the Sponsor button above.

[![obsidian-mcp-pro MCP server](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro/badges/card.svg)](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro)

[![npm version](https://img.shields.io/npm/v/obsidian-mcp-pro.svg)](https://www.npmjs.com/package/obsidian-mcp-pro)
[![npm downloads](https://img.shields.io/npm/dm/obsidian-mcp-pro.svg)](https://www.npmjs.com/package/obsidian-mcp-pro)
[![GitHub stars](https://img.shields.io/github/stars/rps321321/obsidian-mcp-pro?style=flat&logo=github)](https://github.com/rps321321/obsidian-mcp-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-153_passing-brightgreen.svg)](https://github.com/rps321321/obsidian-mcp-pro)
[![Tool Quality](https://img.shields.io/badge/Glama-all_23_tools_A--grade-success)](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro)

Give AI assistants deep, structured access to your Obsidian knowledge base. Read, write, search, tag, analyze links, traverse graphs, and manipulate canvases — all through the [Model Context Protocol](https://modelcontextprotocol.io/).

Every one of the 23 tools ships with rich descriptions, typed schemas, human-readable titles, and safety annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so your agent picks the right tool, passes the right arguments, and handles results correctly — with an average **4.40/5** score and all 23 tools rated A on [Glama's quality index](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro).

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

### One-command install (Claude Desktop / Cursor)

```bash
npx -y obsidian-mcp-pro install
```

This merges an entry into your `claude_desktop_config.json` (or `~/.cursor/mcp.json` with `--client=cursor`), backs up the previous file, and prints next steps. Works on macOS, Windows, and Linux.

Pin a specific vault:

```bash
npx -y obsidian-mcp-pro install --vault /path/to/your/vault
```

### Manual Claude Desktop config

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

### HTTP transport (remote clients, Cursor, ChatGPT, web)

```bash
npx -y obsidian-mcp-pro --transport=http --port=3333
```

Endpoint: `http://127.0.0.1:3333/mcp` (Streamable HTTP). Protect with a bearer token:

```bash
npx -y obsidian-mcp-pro --transport=http --token=your-secret
# or: MCP_HTTP_TOKEN=your-secret npx -y obsidian-mcp-pro --transport=http
```

The HTTP server binds to `127.0.0.1` by default with DNS rebinding protection enabled. Override with `--host=0.0.0.0` only when you know what you're doing.

---

## Configuration

The server locates your vault using the following priority:

| Priority | Method | Description |
|----------|--------|-------------|
| 1 | `OBSIDIAN_VAULT_PATH` | Environment variable with the absolute path to your vault |
| 2 | `OBSIDIAN_VAULT_NAME` | Environment variable to select a vault by folder name when multiple vaults exist |
| 3 | Auto-detection | Reads Obsidian's global config (`obsidian.json`) and uses the first valid vault found |

Auto-detection works on **macOS**, **Windows**, and **Linux** by reading the platform-specific Obsidian configuration directory.

### Daily-note filename format

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

---

## Security

- **Vault boundary** — every tool and resource routes through a single path resolver that rejects `..` traversal, null-byte injection, and symlinks pointing outside the vault (ancestor-realpath check).
- **Excluded directories** — `.obsidian`, `.git`, and `.trash` are pruned at traversal time and at resolution time, so nested occurrences never leak back to clients.
- **HTTP transport** — binds to `127.0.0.1` by default with DNS rebinding protection (host-header allowlist). Optional `--token=<secret>` requires `Authorization: Bearer <secret>` on every `/mcp` request; compared in constant time.
- **Error sanitization** — filesystem error messages are stripped of absolute host paths before being returned to MCP clients. Uncaught HTTP errors respond with a generic `Internal server error` body; full detail stays in the server log.
- **Atomic writes** — `install` subcommand writes the config via temp-file + rename, preserving a backup of the previous file. Note writes use per-path serialization to avoid lost-update races on concurrent MCP calls.

---

## Wikilink resolution

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
  tools/
    read.ts          # search_notes, get_note, list_notes, daily, frontmatter
    write.ts         # create, append, prepend, update_frontmatter, move, delete
    tags.ts          # get_tags, search_by_tag
    links.ts         # backlinks, outlinks, orphans, broken, graph_neighbors
    canvas.ts        # list, read, add_node, add_edge
  __tests__/
    vault.test.ts       markdown.test.ts       tools.test.ts
    security.test.ts    http-server.test.ts    semantics.test.ts
```

---

## Testing

```bash
npm test
```

153 tests covering vault operations, markdown parsing (frontmatter, wikilinks, tags, code-block detection), moment-token date formatting, canvas round-trip fidelity, HTTP transport (Bearer auth, oversize-body, CORS), and security regression guards (symlink escape, case-only rename, path-leak sanitization). Runs against Node 20 + 22 on Ubuntu, macOS, and Windows in CI.

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history and release notes.

## License

MIT

---

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change. Pull requests without a corresponding issue may be closed.

If you're adding or editing a tool, read [docs/TOOL_AUTHORING.md](./docs/TOOL_AUTHORING.md) first — it documents the description, schema, and annotation conventions that keep every tool at A-grade quality.
