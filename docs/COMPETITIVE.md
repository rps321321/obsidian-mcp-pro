# Competitive Landscape

Where obsidian-mcp-pro stands against other ways to give an AI assistant access to
an Obsidian vault. Refresh this on each discovery pass; don't let it rot. Verify
competitor claims against their current repo/docs before writing them down — no
guessing.

_Last reviewed: 2026-06-03_

## Who we compare against

- **Local REST API plugin + MCP bridges** — assistants talk to a running Obsidian
  instance over its REST plugin. Requires Obsidian open; we don't.
- **Filesystem / generic markdown MCP servers** — read/write files with no Obsidian
  awareness (no links, tags, Canvas, Bases, Properties).
- **Other Obsidian-specific MCP servers** — narrower tool sets, usually read + search.
- **Built-in client file access** — some clients can open local folders directly, with
  no vault semantics or safety boundary.

## Scorecard

Fill the competitor columns from their current sources. `?` means not yet verified.

| Dimension | obsidian-mcp-pro | REST-bridge | generic FS MCP | other Obsidian MCP |
|---|---|---|---|---|
| Tools | 41 | ? | ? | ? |
| Works with Obsidian closed | yes (local files) | no | yes | ? |
| Path-boundary + permission safety | yes | ? | usually no | ? |
| Links / tags / graph | yes | ? | no | ? |
| Canvas / Bases / Properties | yes | ? | no | ? |
| Semantic search | yes (Ollama/OpenAI) | ? | ? | ? |
| Attachments | yes | ? | ? | ? |
| HTTP transport | yes (hardened) | ? | ? | ? |
| Local-first / offline | yes | depends | yes | ? |

## Our differentiators (today)

- Breadth: section edits, tags, link analysis, graph traversal, Canvas, Bases,
  attachments, semantic search, and prompts in one server.
- Safety as the core design, not an add-on: path boundaries, folder-scoped
  permissions, atomic writes, redacted logs.
- Works against files directly — no requirement that Obsidian be running.

## Gaps to watch

- _Fill from real user requests and competitor moves — not speculation._

## Metrics we track over time

- Tool count and quality score relative to peers.
- Search latency / recall on the bench fixtures (`npm run bench`).
- Open-issue age and time-to-fix.
- npm weekly downloads (trend, not vanity).
