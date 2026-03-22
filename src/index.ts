#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { getVaultConfig, getDailyNoteConfig } from "./config.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import { registerTagTools } from "./tools/tags.js";
import { registerLinkTools } from "./tools/links.js";
import { registerCanvasTools } from "./tools/canvas.js";

async function main(): Promise<void> {
  let vaultPath: string;

  try {
    const config = getVaultConfig();
    vaultPath = config.vaultPath;
  } catch (err) {
    console.error(`[obsidian-mcp-pro] Failed to detect vault: ${err}`);
    process.exit(1);
  }

  const server = new McpServer({
    name: "obsidian-mcp-pro",
    version: "1.0.1",
  });

  // --- MCP Resources ---

  server.resource(
    "note",
    new ResourceTemplate("obsidian://note/{path}", { list: undefined }),
    async (uri: URL, params: Variables) => {
      const rawPath = params.path;
      const notePath = Array.isArray(rawPath) ? rawPath[0] : (rawPath ?? "");
      const fullPath = path.join(vaultPath, notePath);

      if (!fs.existsSync(fullPath)) {
        throw new Error(`Note not found: ${notePath}`);
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    }
  );

  server.resource("tags", "obsidian://tags", async (uri) => {
    const tagIndex: Record<string, string[]> = {};
    const walkDir = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath);
        } else if (entry.name.endsWith(".md")) {
          const content = fs.readFileSync(fullPath, "utf-8");
          const relativePath = path.relative(vaultPath, fullPath);
          const tags = content.match(/#[a-zA-Z][\w/-]*/g) ?? [];
          for (const tag of tags) {
            if (!tagIndex[tag]) {
              tagIndex[tag] = [];
            }
            tagIndex[tag].push(relativePath);
          }
        }
      }
    };

    walkDir(vaultPath);

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
    const dailyConfig = getDailyNoteConfig(vaultPath);
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");

    // Build the filename from the configured format
    let filename = dailyConfig.format
      .replace("YYYY", String(year))
      .replace("MM", month)
      .replace("DD", day);

    if (!filename.endsWith(".md")) {
      filename += ".md";
    }

    const dailyNotePath = dailyConfig.folder
      ? path.join(vaultPath, dailyConfig.folder, filename)
      : path.join(vaultPath, filename);

    if (!fs.existsSync(dailyNotePath)) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: `No daily note found for today (expected at ${path.relative(vaultPath, dailyNotePath)})`,
          },
        ],
      };
    }

    const content = fs.readFileSync(dailyNotePath, "utf-8");
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: content,
        },
      ],
    };
  });

  // --- Register tool groups ---

  registerReadTools(server, vaultPath);
  registerWriteTools(server, vaultPath);
  registerTagTools(server, vaultPath);
  registerLinkTools(server, vaultPath);
  registerCanvasTools(server, vaultPath);

  // --- Connect transport ---

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[obsidian-mcp-pro] Server started`);
  console.error(`[obsidian-mcp-pro] Vault: ${vaultPath}`);
}

main().catch((err) => {
  console.error(`[obsidian-mcp-pro] Fatal error: ${err}`);
  process.exit(1);
});
