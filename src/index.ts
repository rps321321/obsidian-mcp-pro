#!/usr/bin/env node

import * as fs from "fs/promises";
import { readFileSync, realpathSync } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { getVaultConfig, getDailyNoteConfig } from "./config.js";
import { resolveVaultPathSafe, listNotes, readNote } from "./lib/vault.js";
import { describePermissions } from "./lib/permissions.js";
import { flushAllCachesAsync } from "./lib/index-cache.js";
import { mapConcurrent } from "./lib/concurrency.js";
import { extractTags } from "./lib/markdown.js";
import { log, configureLogger } from "./lib/logger.js";
import { sanitizeError } from "./lib/errors.js";
import { formatMomentDate } from "./lib/dates.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerTagTools } from "./tools/tags.js";
import { registerLinkTools } from "./tools/links.js";
import { registerCanvasTools } from "./tools/canvas.js";
import { registerSectionTools } from "./tools/sections.js";
import { registerBaseTools } from "./tools/bases.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerSemanticTools } from "./tools/semantic.js";
import { registerPrompts } from "./tools/prompts.js";
import { startHttpServer } from "./http-server.js";
import { runInstall, type InstallClient } from "./install.js";

interface CliOptions {
  command: "serve" | "install" | "help" | "version";
  transport: "stdio" | "http";
  host: string;
  port: number;
  bearerToken?: string;
  allowedOrigins?: string[];
  rateLimitPerMinute?: number;
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
    } else if (a === "--allow-origin" && argv[i + 1]) {
      opts.allowedOrigins = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a.startsWith("--allow-origin=")) {
      opts.allowedOrigins = a.slice("--allow-origin=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--rate-limit" && argv[i + 1]) {
      opts.rateLimitPerMinute = Number(argv[++i]);
    } else if (a.startsWith("--rate-limit=")) {
      opts.rateLimitPerMinute = Number(a.slice("--rate-limit=".length));
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
  if (
    opts.rateLimitPerMinute !== undefined &&
    (!Number.isFinite(opts.rateLimitPerMinute) || opts.rateLimitPerMinute < 0)
  ) {
    throw new Error(`Invalid --rate-limit: ${opts.rateLimitPerMinute}`);
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
  --allow-origin=<origins>                  Comma-separated CORS allowlist (default: *)
  --rate-limit=<n>                          Max requests per minute per IP (default: unlimited)

Install options:
  --client=<claude|cursor>                  Target client (default: claude)
  --vault=<path>                            Pin OBSIDIAN_VAULT_PATH
  --vault-name=<name>                       Pin OBSIDIAN_VAULT_NAME
  --name=<server-name>                      Entry name in mcpServers (default: obsidian)

Env vars:
  OBSIDIAN_VAULT_PATH     Vault to serve (else auto-detected from Obsidian config)
  OBSIDIAN_VAULT_NAME     Select a named vault when multiple exist
  OBSIDIAN_READ_PATHS     Comma/colon list of folders read tools may access
  OBSIDIAN_WRITE_PATHS    Comma/colon list of folders write tools may modify
  MCP_HTTP_TOKEN          Default bearer token for --transport=http
  LOG_LEVEL               debug|info|warn|error|silent (default: info)
  LOG_FORMAT              text|json (default: text)
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
  const server = new McpServer(
    {
      name: "obsidian-mcp-pro",
      version: readPackageVersion(),
    },
    {
      // Declaring the `logging` capability lets clients call `logging/setLevel`
      // to filter server-side logs at runtime, and lets the server push
      // structured `notifications/message` events alongside tool responses.
      // Logger forwarding is wired up by callers via `configureLogger` once
      // the server instance is available. `prompts` advertises that the
      // server hosts callable starter templates (registered via
      // `registerPrompts`).
      capabilities: { logging: {}, prompts: { listChanged: false } },
    },
  );

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
        const fullPath = await resolveVaultPathSafe(vaultPath, notePath);
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
        throw new Error(`Failed to read note: ${sanitizeError(err)}`);
      }
    }
  );

  server.resource("tags", "obsidian://tags", async (uri) => {
    if (!vaultPath) throw new Error(noVaultError);
    const tagIndex: Record<string, string[]> = {};
    const notes = await listNotes(vaultPath);

    // Parallel fan-out — sequential reads would spend most of the time
    // blocked on fs I/O (one `realpath` syscall per note via
    // `resolveVaultPathSafe` inside `readNote`). Errors per note are
    // swallowed by `mapConcurrent` so one corrupt file can't poison the
    // entire index.
    const perNote = await mapConcurrent(notes, 8, async (notePath) => {
      const content = await readNote(vaultPath, notePath);
      return { notePath, tags: extractTags(content) };
    });
    for (const entry of perNote) {
      if (!entry) continue;
      for (const tag of entry.tags) {
        const normalizedTag = `#${tag}`;
        (tagIndex[normalizedTag] ??= []).push(entry.notePath);
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
    const dailyConfig = await getDailyNoteConfig(vaultPath);
    let filename = formatMomentDate(new Date(), dailyConfig.format);
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
  registerSectionTools(server, vaultForTools);
  registerBaseTools(server, vaultForTools);
  registerAttachmentTools(server, vaultForTools);
  registerSemanticTools(server, vaultForTools);
  registerPrompts(server);
  if (!vaultPath) {
    log.warn(`Tools registered but vault unconfigured — calls will return errors`);
  }

  return server;
}

function resolveVaultPathOrWarn(): string | undefined {
  try {
    return getVaultConfig().vaultPath;
  } catch (err) {
    log.warn(`Vault not configured — tools will return errors`, {
      err: err as Error,
      hint: "Set OBSIDIAN_VAULT_PATH environment variable to fix this.",
    });
    return undefined;
  }
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err), {
      hint: "Run with --help for usage.",
    });
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
    // Single McpServer instance shared across sessions — the canonical SDK
    // pattern (one server, one transport per session, transports share the
    // server's tool/resource registry). Tools here are stateless, so nothing
    // bleeds between clients. Vault resolution happens once at startup.
    await startHttpServer({
      host: opts.host,
      port: opts.port,
      bearerToken: opts.bearerToken,
      allowedOrigins: opts.allowedOrigins,
      rateLimitPerMinute: opts.rateLimitPerMinute,
      buildMcpServer: () => buildMcpServer(vaultPath),
      version: readPackageVersion(),
    });
    const perms = describePermissions();
    log.info(`Vault configured`, {
      vault: vaultPath ?? "(not configured)",
      readPaths: perms.read,
      writePaths: perms.write,
    });
    return;
  }

  const server = buildMcpServer(vaultPath);
  // Route subsequent log lines through the MCP `notifications/message`
  // channel as well as stderr. Wire it up BEFORE `connect` so any startup
  // log that fires during/after connect reaches a client that's already
  // subscribed (the SDK drops sends until a transport attaches anyway).
  configureLogger({ mcpServer: server });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const perms = describePermissions();
  log.info(`Server started (stdio)`, {
    vault: vaultPath ?? "(not configured)",
    readPaths: perms.read,
    writePaths: perms.write,
  });
}

export { startHttpServer, type HttpServerHandle, type HttpServerOptions } from "./http-server.js";

// Only auto-run as CLI when this file is the entrypoint. Library consumers
// (e.g. the Obsidian plugin wrapper) import named exports and drive the
// server themselves without triggering CLI arg parsing.
function isCliEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    // Node's ESM loader follows symlinks for import.meta.url, but process.argv[1]
    // can still be a symlink (e.g. node_modules/.bin/obsidian-mcp-pro → build/index.js
    // under `npx`). path.resolve does NOT dereference symlinks, so compare real paths.
    const thisPath = realpathSync(fileURLToPath(import.meta.url));
    const argvPath = realpathSync(path.resolve(argv1));
    return thisPath.toLowerCase() === argvPath.toLowerCase();
  } catch {
    return false;
  }
}

// Backstop for stray errors that would otherwise crash the whole process and
// drop every connected MCP client. A tool handler rejection, a late timer
// callback throwing, or an SDK internal slip should be logged — not fatal.
// Library embedders (Obsidian plugin) install their own handlers, so we only
// attach these when running as the CLI.
function installProcessErrorHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    log.error("Unhandled promise rejection", {
      err: reason instanceof Error ? reason : new Error(String(reason)),
    });
  });
  process.on("uncaughtException", (err) => {
    // Uncaught exceptions leave the process in an undefined state per Node's
    // docs. Log loudly and exit so a supervisor (systemd, Docker, npx shell)
    // can restart cleanly rather than limp along with corrupted invariants.
    log.error("Uncaught exception", { err });
    process.exit(1);
  });

  // Flush the index cache to disk on graceful shutdown so the next run can
  // skip re-reading every note. `beforeExit` is the right hook for clean
  // exits; SIGINT/SIGTERM handlers re-raise after the flush so the process
  // still terminates with the expected exit code. We do NOT flush from
  // `uncaughtException` — the process is in undefined state and writing
  // could corrupt the snapshot.
  let flushed = false;
  const flush = async (): Promise<void> => {
    if (flushed) return;
    flushed = true;
    try { await flushAllCachesAsync(); } catch { /* best-effort */ }
  };
  process.on("beforeExit", () => { void flush(); });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await flush();
      // Restore default behavior so the second signal terminates promptly.
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    });
  }
}

if (isCliEntry()) {
  installProcessErrorHandlers();
  main().catch((err) => {
    log.error("Fatal error", { err: err as Error });
    process.exit(1);
  });
}
