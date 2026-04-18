#!/usr/bin/env node

import * as fs from "fs/promises";
import { readFileSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { getVaultConfig, getDailyNoteConfig } from "./config.js";
import { resolveVaultPath, listNotes, readNote } from "./lib/vault.js";
import { extractTags } from "./lib/markdown.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerTagTools } from "./tools/tags.js";
import { registerLinkTools } from "./tools/links.js";
import { registerCanvasTools } from "./tools/canvas.js";
import { startHttpServer } from "./http-server.js";
import { runInstall, type InstallClient } from "./install.js";

interface CliOptions {
  command: "serve" | "install" | "help" | "version";
  transport: "stdio" | "http";
  host: string;
  port: number;
  bearerToken?: string;
  installClient: InstallClient;
  installVaultPath?: string;
  installVaultName?: string;
  installServerName?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: "serve",
    transport: "stdio",
    host: "127.0.0.1",
    port: 3333,
    installClient: "claude",
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (i === 0 && (a === "install" || a === "serve")) {
      opts.command = a;
    } else if (a === "--help" || a === "-h") {
      opts.command = "help";
    } else if (a === "--version" || a === "-v") {
      opts.command = "version";
    } else if (a === "--transport" && argv[i + 1]) {
      const v = argv[++i];
      if (v !== "stdio" && v !== "http") throw new Error(`--transport must be stdio or http (got "${v}")`);
      opts.transport = v;
    } else if (a.startsWith("--transport=")) {
      const v = a.slice("--transport=".length);
      if (v !== "stdio" && v !== "http") throw new Error(`--transport must be stdio or http (got "${v}")`);
      opts.transport = v;
    } else if (a === "--port" && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (a.startsWith("--port=")) {
      opts.port = Number(a.slice("--port=".length));
    } else if (a === "--host" && argv[i + 1]) {
      opts.host = argv[++i];
    } else if (a.startsWith("--host=")) {
      opts.host = a.slice("--host=".length);
    } else if (a === "--token" && argv[i + 1]) {
      opts.bearerToken = argv[++i];
    } else if (a.startsWith("--token=")) {
      opts.bearerToken = a.slice("--token=".length);
    } else if (a === "--client" && argv[i + 1]) {
      const v = argv[++i];
      if (v !== "claude" && v !== "cursor") throw new Error(`--client must be claude or cursor`);
      opts.installClient = v;
    } else if (a.startsWith("--client=")) {
      const v = a.slice("--client=".length);
      if (v !== "claude" && v !== "cursor") throw new Error(`--client must be claude or cursor`);
      opts.installClient = v;
    } else if (a === "--vault" && argv[i + 1]) {
      opts.installVaultPath = argv[++i];
    } else if (a.startsWith("--vault=")) {
      opts.installVaultPath = a.slice("--vault=".length);
    } else if (a === "--vault-name" && argv[i + 1]) {
      opts.installVaultName = argv[++i];
    } else if (a.startsWith("--vault-name=")) {
      opts.installVaultName = a.slice("--vault-name=".length);
    } else if (a === "--name" && argv[i + 1]) {
      opts.installServerName = argv[++i];
    } else if (a.startsWith("--name=")) {
      opts.installServerName = a.slice("--name=".length);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
    i++;
  }
  if (opts.bearerToken === undefined && process.env.MCP_HTTP_TOKEN) {
    opts.bearerToken = process.env.MCP_HTTP_TOKEN;
  }
  if (!Number.isFinite(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`Invalid port: ${opts.port}`);
  }
  return opts;
}

function printHelp(): void {
  console.log(`obsidian-mcp-pro — MCP server for Obsidian vaults

Usage:
  obsidian-mcp-pro [serve] [options]        Start the MCP server (default)
  obsidian-mcp-pro install [options]        Install into a MCP client config
  obsidian-mcp-pro --version                Print version
  obsidian-mcp-pro --help                   Show this help

Serve options:
  --transport=<stdio|http>                  Transport to use (default: stdio)
  --host=<addr>                             HTTP bind host (default: 127.0.0.1)
  --port=<n>                                HTTP port (default: 3333)
  --token=<secret>                          Require Bearer <secret> (or env MCP_HTTP_TOKEN)

Install options:
  --client=<claude|cursor>                  Target client (default: claude)
  --vault=<path>                            Pin OBSIDIAN_VAULT_PATH
  --vault-name=<name>                       Pin OBSIDIAN_VAULT_NAME
  --name=<server-name>                      Entry name in mcpServers (default: obsidian)

Env vars:
  OBSIDIAN_VAULT_PATH     Vault to serve (else auto-detected from Obsidian config)
  OBSIDIAN_VAULT_NAME     Select a named vault when multiple exist
  MCP_HTTP_TOKEN          Default bearer token for --transport=http
`);
}

function readPackageVersion(): string {
  try {
    // build/index.js -> package.json is one level up (project root)
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "..", "package.json");
    const pkg = JSON.parse(
      readFileSync(pkgPath, "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function buildMcpServer(vaultPath: string | undefined): McpServer {
  const server = new McpServer({
    name: "obsidian-mcp-pro",
    version: readPackageVersion(),
  });

  const noVaultError = "No Obsidian vault configured. Set OBSIDIAN_VAULT_PATH environment variable.";

  // --- MCP Resources ---

  server.resource(
    "note",
    new ResourceTemplate("obsidian://note/{+path}", { list: undefined }),
    async (uri: URL, params: Variables) => {
      if (!vaultPath) throw new Error(noVaultError);
      const rawPath = params.path;
      const notePath = Array.isArray(rawPath) ? rawPath.join("/") : (rawPath ?? "");

      if (!notePath) {
        throw new Error("Note path is required");
      }

      try {
        const fullPath = resolveVaultPath(vaultPath, notePath);
        const content = await fs.readFile(fullPath, "utf-8");
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/markdown",
              text: content,
            },
          ],
        };
      } catch (err) {
        throw new Error(`Failed to read note: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  server.resource("tags", "obsidian://tags", async (uri) => {
    if (!vaultPath) throw new Error(noVaultError);
    const tagIndex: Record<string, string[]> = {};
    const notes = await listNotes(vaultPath);

    for (const notePath of notes) {
      try {
        const content = await readNote(vaultPath, notePath);
        const tags = extractTags(content);
        for (const tag of tags) {
          const normalizedTag = `#${tag}`;
          if (!tagIndex[normalizedTag]) {
            tagIndex[normalizedTag] = [];
          }
          tagIndex[normalizedTag].push(notePath);
        }
      } catch {
        // Skip unreadable notes
      }
    }

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(tagIndex, null, 2),
        },
      ],
    };
  });

  server.resource("daily", "obsidian://daily", async (uri) => {
    if (!vaultPath) throw new Error(noVaultError);
    const dailyConfig = getDailyNoteConfig(vaultPath);
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");

    let filename = dailyConfig.format
      .replace("YYYY", String(year))
      .replace("MM", month)
      .replace("DD", day);

    if (!filename.endsWith(".md")) {
      filename += ".md";
    }

    const notePath = dailyConfig.folder
      ? `${dailyConfig.folder}/${filename}`
      : filename;

    try {
      const content = await readNote(vaultPath, notePath);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    } catch {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: `No daily note found for today (expected at ${notePath})`,
          },
        ],
      };
    }
  });

  // --- Register tool groups ---
  // Tools always register so MCP clients (and registries like Glama) can
  // enumerate capabilities without a configured vault. If the vault path is
  // missing or empty, `resolveVaultPath` throws "Vault path is not
  // configured" at call time, which becomes the tool's error response —
  // path-traversal guards stay intact because they reject empty vault paths
  // at the single choke point, not by skipping registration.
  const vaultForTools = vaultPath ?? "";
  registerReadTools(server, vaultForTools);
  registerWriteTools(server, vaultForTools);
  registerTagTools(server, vaultForTools);
  registerLinkTools(server, vaultForTools);
  registerCanvasTools(server, vaultForTools);
  if (!vaultPath) {
    console.error(`[obsidian-mcp-pro] Tools registered but vault unconfigured — calls will return errors.`);
  }

  return server;
}

function resolveVaultPathOrWarn(): string | undefined {
  try {
    return getVaultConfig().vaultPath;
  } catch (err) {
    console.error(`[obsidian-mcp-pro] Warning: ${err}`);
    console.error(`[obsidian-mcp-pro] Server will start but tools will return errors until a vault is configured.`);
    console.error(`[obsidian-mcp-pro] Set OBSIDIAN_VAULT_PATH environment variable to fix this.`);
    return undefined;
  }
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[obsidian-mcp-pro] ${err instanceof Error ? err.message : err}`);
    console.error(`Run with --help for usage.`);
    process.exit(2);
  }

  if (opts.command === "help") {
    printHelp();
    return;
  }
  if (opts.command === "version") {
    console.log(readPackageVersion());
    return;
  }

  if (opts.command === "install") {
    runInstall({
      client: opts.installClient,
      vaultPath: opts.installVaultPath,
      vaultName: opts.installVaultName,
      serverName: opts.installServerName,
    });
    return;
  }

  const vaultPath = resolveVaultPathOrWarn();

  if (opts.transport === "http") {
    // Per-session McpServer so tool state (if added later) doesn't bleed
    // across clients. Vault resolution happens once at startup.
    await startHttpServer({
      host: opts.host,
      port: opts.port,
      bearerToken: opts.bearerToken,
      buildMcpServer: () => buildMcpServer(vaultPath),
    });
    console.error(`[obsidian-mcp-pro] Vault: ${vaultPath ?? "(not configured)"}`);
    return;
  }

  const server = buildMcpServer(vaultPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[obsidian-mcp-pro] Server started (stdio)`);
  console.error(`[obsidian-mcp-pro] Vault: ${vaultPath ?? "(not configured)"}`);
}

export { startHttpServer, type HttpServerHandle, type HttpServerOptions } from "./http-server.js";

// Only auto-run as CLI when this file is the entrypoint. Library consumers
// (e.g. the Obsidian plugin wrapper) import named exports and drive the
// server themselves without triggering CLI arg parsing.
function isCliEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const thisUrl = new URL(import.meta.url);
    const argvUrl = new URL(`file://${path.resolve(argv1).replace(/\\/g, "/")}`);
    return thisUrl.pathname.toLowerCase() === argvUrl.pathname.toLowerCase();
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  main().catch((err) => {
    console.error(`[obsidian-mcp-pro] Fatal error: ${err}`);
    process.exit(1);
  });
}
