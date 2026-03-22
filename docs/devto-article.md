---
title: "I Built the Most Feature-Complete MCP Server for Obsidian — Here's How"
published: false
description: "How I built obsidian-mcp-pro: a 23-tool MCP server that gives AI assistants deep access to Obsidian vaults — with wikilink resolution, graph traversal, canvas support, and security hardening."
tags: mcp, obsidian, typescript, ai
---

If you use Obsidian for knowledge management and AI assistants for development, you have probably wondered: why can't Claude just _read_ my notes? That is the question that led me to build **obsidian-mcp-pro**, a 23-tool MCP server that gives AI assistants deep, structured access to Obsidian vaults.

## What Is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) is an open standard from Anthropic that lets AI assistants call external tools and read external resources through a unified interface. Think of it as a USB-C port for AI: one protocol, any data source. An MCP server exposes tools (functions the AI can call) and resources (data the AI can read), and any MCP-compatible client — Claude Desktop, Claude Code, Cursor, Windsurf — can use them.

## The Problem

When I started, four Obsidian MCP servers already existed on npm. All of them covered the basics: read a note, search, maybe create a file. None of them handled what makes Obsidian _Obsidian_:

- **Wikilinks** with Obsidian's unique shortest-path resolution
- **Graph analysis** — backlinks, orphans, broken links, neighbor traversal
- **Canvas files** — Obsidian's visual thinking tool
- **Frontmatter-aware operations** — search by YAML fields, update properties programmatically
- **Cross-platform vault detection** — auto-find the vault on Windows, macOS, and Linux

I wanted to build something that treated Obsidian as a first-class knowledge graph, not just a folder of markdown files.

## Architecture

The stack is intentionally minimal:

- **TypeScript** with strict mode
- **@modelcontextprotocol/sdk** for the MCP server scaffold
- **Zod** for input validation on every tool
- **gray-matter** for YAML frontmatter parsing

Three production dependencies. That is it.

### File Structure

```
src/
├── index.ts          # Server bootstrap, MCP resources
├── config.ts         # Vault detection (cross-platform)
├── types.ts          # Shared type definitions
├── lib/
│   ├── vault.ts      # File I/O, search, path security
│   └── markdown.ts   # Frontmatter, wikilinks, tags, code block tracking
└── tools/
    ├── read.ts       # 5 read tools
    ├── write.ts      # 7 write tools
    ├── tags.ts       # 2 tag tools
    ├── links.ts      # 5 link/graph tools
    └── canvas.ts     # 4 canvas tools
```

### Vault Detection

The server auto-detects your vault by reading Obsidian's own config file. The detection chain checks `OBSIDIAN_VAULT_PATH` env var first, then falls back to parsing `obsidian.json` from the platform-specific config directory:

```typescript
function getObsidianConfigPath(): string {
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(process.env.APPDATA!, "obsidian", "obsidian.json");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support",
      "obsidian", "obsidian.json");
  }
  // Linux: respect XDG_CONFIG_HOME
  const configDir = process.env.XDG_CONFIG_HOME
    || path.join(os.homedir(), ".config");
  return path.join(configDir, "obsidian", "obsidian.json");
}
```

If multiple vaults exist and no name is specified via `OBSIDIAN_VAULT_NAME`, the server picks the first valid one and logs a warning.

## Key Technical Challenges

### 1. Wikilink Resolution

Obsidian uses a shortest-path matching strategy for `[[wikilinks]]`. If you write `[[Meeting Notes]]`, Obsidian does not require a full path — it finds the note by basename, preferring shorter paths when there are duplicates. Replicating this correctly was critical for backlink/outlink analysis:

```typescript
export function resolveWikilink(
  link: string,
  _currentNotePath: string,
  allNotePaths: string[],
): string | null {
  const cleanLink = link.split("#")[0].split("^")[0].trim();
  if (!cleanLink) return null;
  const normalizedLink = cleanLink.replace(/\.md$/i, "");

  // 1. Exact relative path match
  for (const notePath of allNotePaths) {
    const withoutExt = notePath.replace(/\.md$/i, "").toLowerCase();
    if (withoutExt === normalizedLink.toLowerCase()) return notePath;
  }

  // 2. Path suffix match (for links like "folder/note")
  if (normalizedLink.includes("/")) {
    for (const notePath of allNotePaths) {
      const withoutExt = notePath.replace(/\.md$/i, "").toLowerCase();
      if (withoutExt.endsWith(normalizedLink.toLowerCase())) {
        const prefix = withoutExt.slice(
          0, withoutExt.length - normalizedLink.length
        );
        if (prefix === "" || prefix.endsWith("/")) return notePath;
      }
    }
  }

  // 3. Shortest-path: basename match, prefer shortest vault path
  const linkBasename = path.basename(normalizedLink).toLowerCase();
  const candidates = allNotePaths.filter((p) =>
    path.basename(p, ".md").toLowerCase() === linkBasename
  );
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0] ?? null;
}
```

The three-phase strategy (exact match, suffix match, basename match) mirrors how Obsidian itself resolves links. Heading anchors (`#heading`) and block references (`^blockid`) are stripped before resolution.

### 2. Code Block-Aware Extraction

Tags and wikilinks inside code blocks should be ignored. A `#typescript` inside a fenced code block is syntax highlighting, not an Obsidian tag. The solution is a stateful tracker that handles both backtick and tilde fences of arbitrary length:

```typescript
function createCodeBlockTracker(): (line: string) => boolean {
  let insideCodeBlock = false;
  let fenceChar = "";
  let fenceLength = 0;
  return (line: string): boolean => {
    const trimmed = line.trimStart();
    if (!insideCodeBlock) {
      const backtickMatch = trimmed.match(/^(`{3,})/);
      const tildeMatch = trimmed.match(/^(~{3,})/);
      if (backtickMatch) {
        insideCodeBlock = true;
        fenceChar = "`";
        fenceLength = backtickMatch[1].length;
        return true;
      }
      if (tildeMatch) {
        insideCodeBlock = true;
        fenceChar = "~";
        fenceLength = tildeMatch[1].length;
        return true;
      }
      return false;
    } else {
      const closePattern = new RegExp(
        `^${fenceChar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}{${fenceLength},}\\s*$`
      );
      if (closePattern.test(trimmed)) {
        insideCodeBlock = false;
      }
      return true;
    }
  };
}
```

This tracker is used in both `extractTags` and `extractWikilinks`. Inline code spans (`` `like this` ``) are stripped separately before regex matching.

### 3. Path Traversal Security

When an AI assistant can read and write files, path security is non-negotiable. A naive `path.join(vaultPath, userInput)` allows `../../etc/passwd` to escape the vault. The fix:

```typescript
export function resolveVaultPath(
  vaultPath: string, relativePath: string
): string {
  if (relativePath.includes('\0')) {
    throw new Error("Invalid path: contains null byte");
  }
  const resolved = path.resolve(vaultPath, relativePath);
  const resolvedVault = path.resolve(vaultPath);
  if (!resolved.startsWith(resolvedVault + path.sep)
      && resolved !== resolvedVault) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  return resolved;
}
```

The null byte check blocks a classic bypass where `\0` terminates strings in some filesystem APIs. The `+ path.sep` suffix prevents a subtle bug where a vault at `/home/user/notes` would incorrectly allow access to `/home/user/notes-private` (since `"notes-private".startsWith("notes")` is true).

### 4. Graph Traversal with BFS

The `get_graph_neighbors` tool lets you explore the knowledge graph around any note using breadth-first search. Given a starting note and a depth (1-5 hops), it returns all connected notes with their distance and link direction:

```typescript
// BFS traversal
const visited = new Map<string, GraphNeighbor>();
const queue: { path: string; currentDepth: number }[] = [
  { path: resolvedStart, currentDepth: 0 },
];

while (queue.length > 0) {
  const { path: currentPath, currentDepth } = queue.shift()!;
  if (currentDepth >= depth) continue;

  const neighbors: { path: string; dir: "inbound" | "outbound" }[] = [];
  if (direction === "outbound" || direction === "both") {
    for (const target of graph.outlinks.get(currentPath) ?? []) {
      neighbors.push({ path: target, dir: "outbound" });
    }
  }
  if (direction === "inbound" || direction === "both") {
    for (const source of graph.backlinks.get(currentPath) ?? []) {
      neighbors.push({ path: source, dir: "inbound" });
    }
  }
  for (const neighbor of neighbors) {
    if (!visited.has(neighbor.path)) {
      visited.set(neighbor.path, {
        path: neighbor.path,
        depth: currentDepth + 1,
        direction: neighbor.dir,
      });
      queue.push({ path: neighbor.path, currentDepth: currentDepth + 1 });
    }
  }
}
```

This gives the AI a way to reason about context: "Show me everything within 2 hops of my architecture decision records."

## The 23 Tools

| Category | Tool | Description |
|----------|------|-------------|
| **Read** | `search_notes` | Full-text search across all vault notes |
| | `get_note` | Read a single note with frontmatter parsing |
| | `list_notes` | List notes by folder, date, or pattern |
| | `get_daily_note` | Retrieve today's daily note |
| | `search_by_frontmatter` | Query notes by YAML field values |
| **Write** | `create_note` | Create a note with frontmatter and content |
| | `append_to_note` | Append content to an existing note |
| | `prepend_to_note` | Prepend content (frontmatter-aware) |
| | `update_frontmatter` | Update YAML properties programmatically |
| | `create_daily_note` | Create today's daily note from template |
| | `move_note` | Move/rename with path validation |
| | `delete_note` | Delete to Obsidian trash (safe by default) |
| **Tags** | `get_tags` | Full tag index with usage counts |
| | `search_by_tag` | Find notes by one or more tags |
| **Links** | `get_backlinks` | What links _to_ a note |
| | `get_outlinks` | What a note links _to_ |
| | `find_orphans` | Notes with no connections |
| | `find_broken_links` | Wikilinks pointing to non-existent notes |
| | `get_graph_neighbors` | BFS traversal to configurable depth |
| **Canvas** | `list_canvases` | List all `.canvas` files |
| | `read_canvas` | Read canvas with full node/edge data |
| | `add_canvas_node` | Add text, file, link, or group nodes |
| | `add_canvas_edge` | Connect canvas nodes with edges |

Plus 3 MCP resources: `obsidian://note/{path}`, `obsidian://tags`, and `obsidian://daily`.

## Security Deep Dive

During a security audit before publishing, I found and fixed several issues:

- **Path traversal via prefix bypass**: The initial `startsWith(resolvedVault)` check without `+ path.sep` would allow access to sibling directories sharing a name prefix. A vault at `/vault` would mistakenly grant access to `/vault-backup`. Fixed by requiring the separator.
- **Null byte injection**: Passing `\0` in a path can truncate strings in certain filesystem operations. Added an explicit null byte check before any path resolution.
- **YAML injection via frontmatter**: The `update_frontmatter` tool uses `gray-matter` for parsing and serialization, which handles YAML safely. But untrusted input in frontmatter values could still produce malformed YAML if concatenated as raw strings — the `matter.stringify` approach avoids this.
- **Trash path validation**: The delete-to-trash operation gets its own separate path traversal check to prevent writing to arbitrary locations via crafted relative paths.

## Results

- Published on [npm](https://www.npmjs.com/package/obsidian-mcp-pro) as `obsidian-mcp-pro`
- Listed on [Glama](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro) MCP server directory
- PR submitted to [awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
- Works with Claude Desktop, Claude Code, Cursor, and any MCP-compatible client
- Zero-config for single-vault setups: `npx -y obsidian-mcp-pro` just works

## What I Learned

**Building for npm is its own discipline.** Getting the `bin` field, `files` array, `prepublishOnly` script, and shebang line all working correctly took more iterations than I expected. Testing with `npm pack` before every publish became a habit.

**MCP protocol compliance matters.** The SDK handles most of the protocol details, but tool responses have a specific shape (`{ content: [{ type: "text", text }] }`), error reporting has conventions (`isError: true`), and resource URIs need to follow the template spec. Getting these right meant reading the spec, not just the examples.

**Security-first thinking pays off early.** The path traversal fix was a two-line change, but catching it before publishing avoided a vulnerability that would have let any AI assistant read arbitrary files on the host machine. When your tool gives an AI filesystem access, every input is an attack surface.

## Try It

```bash
npx -y obsidian-mcp-pro
```

- **GitHub**: [github.com/rps321321/obsidian-mcp-pro](https://github.com/rps321321/obsidian-mcp-pro)
- **npm**: [npmjs.com/package/obsidian-mcp-pro](https://www.npmjs.com/package/obsidian-mcp-pro)
- **Glama**: [glama.ai/mcp/servers/rps321321/obsidian-mcp-pro](https://glama.ai/mcp/servers/rps321321/obsidian-mcp-pro)

If you use Obsidian and AI assistants, give it a try. Feedback and contributions welcome.
