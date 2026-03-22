# I built the most feature-complete MCP server for Obsidian — 23 tools, open source

I wanted Claude to actually *understand* my Obsidian vault, not just read files from it. So I built **obsidian-mcp-pro** — 23 tools + 3 resources that give Claude deep, structured access to your entire knowledge base.

## What can it do?

- **Read/write/search** — full-text search, frontmatter queries, create/edit/move/delete notes
- **Graph traversal** — BFS-based neighbor traversal to configurable depth. Claude can actually walk your knowledge graph
- **Orphan detection** — find notes with zero inbound or outbound links
- **Broken link finder** — detect `[[wikilinks]]` pointing to notes that don't exist
- **Tag index** — build and query a complete tag index across your vault
- **Canvas support** — read `.canvas` files, add nodes (text, file, link, group), add edges
- **Daily notes** — automatic daily note retrieval via MCP resource

## Why this over other Obsidian MCP servers?

Most Obsidian MCP servers give you 5-8 tools — basically read, write, search. This one ships 23 tools and 3 resources. The graph analysis stuff (BFS traversal, orphan detection, broken links) is what actually makes it useful for knowledge work with Claude.

## Security

Path traversal protection on every file operation. Proper `isError` compliance on all tool responses. Your vault stays sandboxed.

## Setup

**Claude Desktop** — add to `claude_desktop_config.json`:

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

**Claude Code:**

```bash
claude mcp add obsidian-mcp-pro -- npx -y obsidian-mcp-pro
```

Auto-detects your vault. Set `OBSIDIAN_VAULT_PATH` env var if you have multiple.

## Details

- MIT licensed, fully open source
- TypeScript, built on `@modelcontextprotocol/sdk`
- **GitHub:** [github.com/rps321321/obsidian-mcp-pro](https://github.com/rps321321/obsidian-mcp-pro)
- **npm:** [npmjs.com/package/obsidian-mcp-pro](https://www.npmjs.com/package/obsidian-mcp-pro)

Would love to hear what tools you'd want added. Vault-level semantic search? Dataview query support? Template expansion? Let me know.
