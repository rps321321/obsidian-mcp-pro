**Title:** obsidian-mcp-pro -- 23-tool MCP server for full Obsidian vault access, runs 100% local

**Body:**

I built an MCP server that gives any MCP-compatible client deep, structured access to your Obsidian vault. It runs entirely on your machine via stdio transport -- no cloud, no API keys for the server itself, your vault data never leaves your computer.

**What it does (23 tools):**

- **Search & Read** -- full-text search, frontmatter queries, daily notes, list/filter by folder or pattern
- **Write & Modify** -- create, append, prepend, update frontmatter, move/rename with automatic link updates, delete
- **Tags** -- full tag index, query by single or multiple tags
- **Links & Graph** -- backlinks, outlinks, orphan detection, broken link detection, graph traversal to configurable depth
- **Canvas** -- read/write `.canvas` files, add nodes (text, file, link, group) and edges

It auto-detects your vault from Obsidian's config, so zero setup for most users. Just point your MCP client at it and go.

**Use cases:**

- RAG over your personal knowledge base with any local LLM
- Automated note management and organization
- AI-powered PKM workflows -- let your model read your graph, find connections, surface orphaned notes
- Build custom agents that interact with your second brain

**Tech details:**

- TypeScript, MIT licensed
- Uses the official `@modelcontextprotocol/sdk`
- Works with Claude Desktop, Claude Code, Cursor, Windsurf, or any MCP-compatible client
- Node >= 18, install via `npx -y obsidian-mcp-pro`

This is not tied to any specific LLM or client. MCP is an open protocol -- if your tool speaks MCP, this server works with it.

122 automated tests. Security-audited (path traversal protection, input validation on every tool).

GitHub: https://github.com/rps321321/obsidian-mcp-pro
npm: https://www.npmjs.com/package/obsidian-mcp-pro

Happy to answer questions or take feature requests.
