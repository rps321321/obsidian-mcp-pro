# Title: I built an MCP server that lets Claude (and other AI) read, search, and manage your Obsidian vault

Hey r/ObsidianMD,

I've been using Obsidian as my main knowledge base for a couple of years, and I kept wanting my AI tools to actually *understand* what's in my vault — not just dump a file into the chat window. So I built **obsidian-mcp-pro**.

**Quick context if you haven't heard of MCP:** Model Context Protocol is an open standard (by Anthropic) that lets AI assistants connect to external tools and data sources. Think of it like giving Claude or other LLMs a structured API to interact with your stuff, instead of just copy-pasting text back and forth.

**What this does:** It runs a local MCP server that gives AI assistants deep access to your vault. Full-text search, frontmatter queries, link analysis, graph traversal, canvas support — the works.

## 23 tools across 5 categories:

**Read & Search** — `search_notes`, `get_note`, `list_notes`, `get_daily_note`, `search_by_frontmatter`

**Write & Modify** — `create_note`, `append_to_note`, `prepend_to_note`, `update_frontmatter`, `create_daily_note`, `move_note`, `delete_note`

**Tags** — `get_tags`, `search_by_tag`

**Links & Graph** — `get_backlinks`, `get_outlinks`, `find_orphans`, `find_broken_links`, `get_graph_neighbors`

**Canvas** — `list_canvases`, `read_canvas`, `add_canvas_node`, `add_canvas_edge`

## Setup is one line

For Claude Desktop, add this to your config:

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

It auto-detects your vault location on macOS, Windows, and Linux. You can also point it at a specific vault with the `OBSIDIAN_VAULT_PATH` env var.

## Some things I actually use it for

- "Find all notes tagged #project that mention the client name" — search + tag filtering in one shot
- "What notes link to my MOC but aren't linked back?" — backlink analysis
- "Create a daily note summarizing my open tasks across these 3 project folders" — read + write
- "Find orphan notes I should probably clean up or connect" — graph hygiene

It's **free, open source, MIT licensed**. No telemetry, no cloud, everything stays local.

**GitHub:** [github.com/rps321321/obsidian-mcp-pro](https://github.com/rps321321/obsidian-mcp-pro)
**npm:** [npmjs.com/package/obsidian-mcp-pro](https://www.npmjs.com/package/obsidian-mcp-pro)

Would love feedback — especially on what tools you'd want added. If you run into issues, please open a GitHub issue and I'll get to it.
