// Dogfood smoke test: start the built server over stdio exactly like a real MCP
// client would, against a throwaway vault, and exercise the round-trip. Unit
// tests don't catch a broken stdio handshake or a tool that fails end to end.
//
// Run after `npm run build`. Exits non-zero on any failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "build", "index.js");

if (!existsSync(entry)) {
  console.error("build/index.js missing — run `npm run build` first.");
  process.exit(1);
}

const vault = mkdtempSync(join(tmpdir(), "ompro-dogfood-"));
let exitCode = 0;
let client;

try {
  mkdirSync(join(vault, ".obsidian")); // mark as a real vault so the server doesn't auto-detect elsewhere
  writeFileSync(join(vault, "welcome.md"), "# Welcome\n\nThe quick brown fox.\n");
  writeFileSync(join(vault, "notes.md"), "# Notes\n\nThe second note mentions the fox too.\n");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: root,
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });

  client = new Client({ name: "dogfood", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  if (!tools || tools.length === 0) throw new Error("server returned no tools");
  console.log(`handshake ok — ${tools.length} tools advertised`);

  if (!tools.some((t) => t.name === "search_notes")) {
    throw new Error("expected tool search_notes not found");
  }

  const res = await client.callTool({
    name: "search_notes",
    arguments: { query: "fox", maxResults: 5 },
  });
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  if (!/welcome|notes/i.test(text)) {
    throw new Error(`search_notes returned no expected hit:\n${text}`);
  }
  console.log("search_notes round-trip ok");
  console.log("\ndogfood passed");
} catch (err) {
  console.error(`dogfood failed: ${err?.message ?? err}`);
  exitCode = 1;
} finally {
  try { await client?.close(); } catch {}
  try { rmSync(vault, { recursive: true, force: true }); } catch {}
}

process.exit(exitCode);
