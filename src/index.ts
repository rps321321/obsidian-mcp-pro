#!/usr/bin/env node

import * as fs from "fs/promises";
import * as path from "path";
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

async function main(): Promise<void> {
  let vaultPath: string | undefined;

  try {
    const config = getVaultConfig();
    vaultPath = config.vaultPath;
  } catch (err) {
    console.error(`[obsidian-mcp-pro] Warning: ${err}`);
    console.error(`[obsidian-mcp-pro] Server will start but tools will return errors until a vault is configured.`);
    console.error(`[obsidian-mcp-pro] Set OBSIDIAN_VAULT_PATH environment variable to fix this.`);
  }

  const server = new McpServer({
    name: "obsidian-mcp-pro",
    version: "1.1.0",
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

  const effectiveVaultPath = vaultPath ?? "";
  registerReadTools(server, effectiveVaultPath);
  registerWriteTools(server, effectiveVaultPath);
  registerTagTools(server, effectiveVaultPath);
  registerLinkTools(server, effectiveVaultPath);
  registerCanvasTools(server, effectiveVaultPath);

  // --- Connect transport ---

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[obsidian-mcp-pro] Server started`);
  console.error(`[obsidian-mcp-pro] Vault: ${vaultPath ?? "(not configured)"}`);
}

main().catch((err) => {
  console.error(`[obsidian-mcp-pro] Fatal error: ${err}`);
  process.exit(1);
});
