import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildMcpServer } from "../index.js";
import { configureLogger } from "../lib/logger.js";
import { setPermissions } from "../lib/permissions.js";
import { parseStrictYamlFrontmatter } from "../lib/markdown.js";
import { createTestEnv } from "./handlers/harness.js";

const marker = "PRIVATE303";
const fixtures = [
  { name: "malformed flow", yaml: `secret: [${marker}\n`, expected: "Invalid YAML frontmatter at line 3, column 1." },
  { name: "unknown tag", yaml: `secret: !${marker} value\n`, expected: "Invalid YAML frontmatter at line 2, column 26." },
  { name: "oversized block", yaml: `secret: ${marker}${"x".repeat(262_144)}\n`, expected: "Frontmatter block exceeds size cap" },
];

afterEach(() => {
  vi.restoreAllMocks();
  configureLogger({ level: "info", format: "json", mcpServer: null });
  setPermissions({ readPaths: null, writePaths: null });
});

describe.each(["text", "json"] as const)("frontmatter errors with %s logs", (format) => {
  it.each(fixtures)("keeps $name source out of results and every log channel", async ({ yaml, expected }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "frontmatter-errors-"));
    const note = `---\n${yaml}---\nBody.\n`;
    await fs.mkdir(path.join(root, ".obsidian"));
    await fs.mkdir(path.join(root, "private"));
    const file = path.join(root, "private", "note.md");
    await fs.writeFile(file, note);
    const server = buildMcpServer(root);
    const client = new Client({ name: "frontmatter-boundary-test", version: "1" });
    const notifications: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      notifications.push(notification.params);
    });
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await client.setLoggingLevel("error");
      configureLogger({ level: "error", format, mcpServer: server });
      setPermissions({ readPaths: ["public"], writePaths: null });
      const denied = await client.callTool({ name: "get_note", arguments: { path: "private/note.md" } });
      expect(denied.isError).toBe(true);
      const result = await client.callTool({
        name: "update_frontmatter",
        arguments: { path: "private/note.md", properties: '{"status":"updated"}' },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(expected);
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(stderr.join("")).toContain(expected);
      expect(stderr.join("")).not.toContain(marker);
      expect(notifications.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(notifications)).toContain(expected);
      expect(JSON.stringify(notifications)).not.toContain(marker);
      await expect(fs.readFile(file, "utf8")).resolves.toBe(note);
    } finally {
      configureLogger({ mcpServer: null });
      await client.close();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

it("retains no parser source or raw reason on the returned Error", () => {
  const parsed = parseStrictYamlFrontmatter(`---\nsecret: !${marker} value\n---\n`);
  expect(parsed.error).toBeInstanceOf(Error);
  expect(parsed.error?.message).toMatch(/^Invalid YAML frontmatter at line 2, column \d+\.$/);
  expect(String(parsed.error?.stack)).not.toContain(marker);
  expect(JSON.stringify(parsed.error)).not.toContain(marker);
  expect(parsed.error).not.toHaveProperty("mark");
  expect(parsed.error).not.toHaveProperty("reason");
  expect(parsed.error).not.toHaveProperty("cause");
});

it("allows a write-only frontmatter update without returning existing note content", async () => {
  const env = await createTestEnv({
    skipFixtures: true,
    extraFiles: { "private/note.md": `---\nsecret: ${marker}\n---\nPrivate body.\n` },
  });
  try {
    setPermissions({ readPaths: ["public"], writePaths: null });
    const result = await env.client.callTool({
      name: "update_frontmatter",
      arguments: { path: "private/note.md", properties: '{"status":"updated"}' },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain(marker);
    const disk = await fs.readFile(path.join(env.vaultDir, "private/note.md"), "utf8");
    expect(disk).toContain(`secret: ${marker}`);
    expect(disk).toContain("status: updated");
    expect(disk).toContain("Private body.");
  } finally {
    await env.cleanup();
  }
});
