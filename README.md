# obsidian-mcp-pro

**The most feature-complete MCP server for Obsidian vaults.**

[![obsidian-mcp-pro MCP server](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro/badges/card.svg)](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro)

[![npm version](https://img.shields.io/npm/v/obsidian-mcp-pro.svg)](https://www.npmjs.com/package/obsidian-mcp-pro)
[![npm downloads](https://img.shields.io/npm/dm/obsidian-mcp-pro.svg)](https://www.npmjs.com/package/obsidian-mcp-pro)
[![GitHub stars](https://img.shields.io/github/stars/rps321321/obsidian-mcp-pro?style=flat&logo=github)](https://github.com/rps321321/obsidian-mcp-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-122_passing-brightgreen.svg)](https://github.com/rps321321/obsidian-mcp-pro)
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

### Claude Desktop

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

---

## Configuration

The server locates your vault using the following priority:

| Priority | Method | Description |
|----------|--------|-------------|
| 1 | `OBSIDIAN_VAULT_PATH` | Environment variable with the absolute path to your vault |
| 2 | `OBSIDIAN_VAULT_NAME` | Environment variable to select a vault by folder name when multiple vaults exist |
| 3 | Auto-detection | Reads Obsidian's global config (`obsidian.json`) and uses the first valid vault found |

Auto-detection works on **macOS**, **Windows**, and **Linux** by reading the platform-specific Obsidian configuration directory.

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
  index.ts          # Server entry point and resource registration
  config.ts         # Vault detection and configuration
  types.ts          # Shared TypeScript interfaces
  lib/
    vault.ts        # Core vault operations (read, search, list)
    markdown.ts     # Frontmatter parsing and tag extraction
  tools/
    read.ts         # Search, get, list, daily note tools
    write.ts        # Create, append, prepend, update, move, delete tools
    tags.ts         # Tag index and tag search tools
    links.ts        # Backlinks, outlinks, orphans, broken links, graph tools
    canvas.ts       # Canvas read, node, edge, and list tools
```

---

## Testing

```bash
npm test
```

122 tests covering vault operations, markdown parsing (frontmatter, wikilinks, tags, code block detection), and integration tests with a mock vault.

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history and release notes.

## License

MIT

---

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change. Pull requests without a corresponding issue may be closed.

If you're adding or editing a tool, read [docs/TOOL_AUTHORING.md](./docs/TOOL_AUTHORING.md) first — it documents the description, schema, and annotation conventions that keep every tool at A-grade quality.