import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildMcpServer,
  createMcpServerServices,
} from "../index.js";
import {
  resetProviderForTests,
  setProviderForTests,
  type EmbeddingProvider,
} from "../lib/embedding-providers.js";

const INDEX_CONFIRM = "send-vault-text-to-embedding-provider";

class TopicProvider implements EmbeddingProvider {
  readonly id = "shared-handle-test";
  readonly model = "topic";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) =>
      text.toLowerCase().includes("cat") ? [1, 0] : [0, 1]
    );
  }
}

let vaultDir: string;
const clients: Client[] = [];

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "embedding-services-"));
  await fs.writeFile(
    path.join(vaultDir, "cats.md"),
    "# Cats\n\nCat care and feline behavior.",
    "utf-8"
  );
  process.env.OBSIDIAN_CACHE_DISABLED = "1";
  setProviderForTests(new TopicProvider());
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
  setProviderForTests(null);
  resetProviderForTests();
  delete process.env.OBSIDIAN_CACHE_DISABLED;
  await fs.rm(vaultDir, { recursive: true, force: true });
});

async function connectClient(
  server: ReturnType<typeof buildMcpServer>,
  name: string
): Promise<Client> {
  const client = new Client({ name, version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  clients.push(client);
  return client;
}

describe("MCP server semantic services", () => {
  it("shares one in-memory embedding store across separate server instances", async () => {
    const services = createMcpServerServices(vaultDir);
    const firstServer = buildMcpServer(vaultDir, services);
    const secondServer = buildMcpServer(vaultDir, services);
    const firstClient = await connectClient(firstServer, "indexer");
    const secondClient = await connectClient(secondServer, "searcher");

    const indexed = await firstClient.callTool({
      name: "index_vault",
      arguments: { confirm: INDEX_CONFIRM },
    });
    expect(indexed.isError).not.toBe(true);

    // Persistence is disabled above. This can only succeed if both server
    // instances received the exact same in-memory EmbeddingStore handle.
    const searched = await secondClient.callTool({
      name: "search_semantic",
      arguments: { query: "cat care", limit: 5 },
    });
    expect(searched.isError).not.toBe(true);
    const first = searched.content[0] as { type?: string; text?: string };
    expect(first.type).toBe("text");
    expect(first.text).toContain("cats.md");
  });
});
