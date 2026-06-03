import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isError, textContent } from "./handlers/harness.js";

interface AttachmentMocks {
  attachments: string[];
  notes?: string[];
  resolvedPath?: string;
  stats?: Map<string, number>;
}

const tempDirs: string[] = [];

async function createAttachmentClient(mocks: AttachmentMocks): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  vi.resetModules();
  vi.doMock("../lib/vault.js", () => ({
    listAttachments: vi.fn(async () => mocks.attachments),
    listNotes: vi.fn(async () => mocks.notes ?? []),
    getAttachmentStats: vi.fn(async (_vaultPath: string, relPath: string) => ({
      size: mocks.stats?.get(relPath) ?? 0,
    })),
    resolveVaultPathSafe: vi.fn(async () => {
      if (!mocks.resolvedPath) {
        throw new Error("resolveVaultPathSafe mock missing resolvedPath");
      }
      return mocks.resolvedPath;
    }),
  }));
  vi.doMock("../lib/index-cache.js", () => ({
    readAllCached: vi.fn(async () => ({ contents: new Map<string, string>() })),
  }));

  const { registerAttachmentTools } = await import("../tools/attachments.js");
  const server = new McpServer({ name: "attachment-display-test", version: "0.0.0" });
  registerAttachmentTools(server, "mock-vault");

  const client = new Client({ name: "attachment-display-client", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  return {
    client,
    cleanup: async () => {
      try {
        await client.close();
      } catch {
        // ignore
      }
    },
  };
}

afterEach(async () => {
  vi.doUnmock("../lib/vault.js");
  vi.doUnmock("../lib/index-cache.js");
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("attachment display escaping", () => {
  it("escapes control characters in populated attachment listings", async () => {
    const env = await createAttachmentClient({
      attachments: ["assets/bad\nname.png", "assets/tab\tname.jpg"],
    });
    try {
      const result = await env.client.callTool({
        name: "list_attachments",
        arguments: {},
      });
      expect(isError(result)).toBe(false);
      const text = textContent(result);
      expect(text).toContain("- assets/bad\\nname.png");
      expect(text).toContain("- assets/tab\\tname.jpg");
      expect(text).not.toContain("assets/bad\nname.png");
      expect(text).not.toContain("assets/tab\tname.jpg");
    } finally {
      await env.cleanup();
    }
  });

  it("escapes control characters in unused attachment rows", async () => {
    const dirtyPath = "assets/orphan\nfile.png";
    const env = await createAttachmentClient({
      attachments: [dirtyPath],
      stats: new Map([[dirtyPath, 7]]),
    });
    try {
      const result = await env.client.callTool({
        name: "find_unused_attachments",
        arguments: { includeBytes: true },
      });
      expect(isError(result)).toBe(false);
      const text = textContent(result);
      expect(text).toContain("- assets/orphan\\nfile.png  (7 bytes)");
      expect(text).not.toContain("assets/orphan\nfile.png");
    } finally {
      await env.cleanup();
    }
  });

  it("escapes control characters in maxBytes errors", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-display-"));
    tempDirs.push(dir);
    const fullPath = path.join(dir, "big.png");
    await fs.writeFile(fullPath, "data", "utf-8");

    const relPath = "assets/big\nfile.png";
    const env = await createAttachmentClient({
      attachments: [],
      resolvedPath: fullPath,
    });
    try {
      const result = await env.client.callTool({
        name: "get_attachment",
        arguments: { path: relPath, maxBytes: 1 },
      });
      expect(isError(result)).toBe(true);
      const text = textContent(result);
      expect(text).toContain('Attachment "assets/big\\nfile.png" is 4 bytes');
      expect(text).not.toContain("assets/big\nfile.png");
    } finally {
      await env.cleanup();
    }
  });
});
