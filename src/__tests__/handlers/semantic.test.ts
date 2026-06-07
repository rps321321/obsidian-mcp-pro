import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";
import { setProviderForTests, resetProviderForTests, type EmbeddingProvider } from "../../lib/embedding-providers.js";
import { clearStore, hashText } from "../../lib/embedding-store.js";
import { setPermissions } from "../../lib/permissions.js";

/**
 * Deterministic mock embedding provider for handler tests. Maps text to a
 * tiny vector based on which "topic" keywords appear, so the relative
 * cosine ordering of fixture notes is predictable without spinning up a
 * real Ollama server.
 *
 * Topics: cats / dogs / cooking / weather. Each contributes one dimension.
 */
class MockProvider implements EmbeddingProvider {
  readonly id = "mock";
  readonly model = "topic-counter";
  embed(texts: string[]): Promise<number[][]> {
    const out = texts.map((t) => {
      const lower = t.toLowerCase();
      const cat = (lower.match(/\bcat(s)?\b|kitten|feline/g) ?? []).length;
      const dog = (lower.match(/\bdog(s)?\b|puppy|canine/g) ?? []).length;
      const cook = (lower.match(/cook|recipe|kitchen|bake/g) ?? []).length;
      const weather = (lower.match(/weather|rain|storm|sunny|cloud/g) ?? []).length;
      const v = [cat, dog, cook, weather].map((n) => n + 0.0001); // keep nonzero norm
      return v;
    });
    return Promise.resolve(out);
  }
}

let env: TestEnv;
const INDEX_CONFIRM = "send-vault-text-to-embedding-provider";

function indexVault(args: Record<string, unknown> = {}) {
  return env.client.callTool({
    name: "index_vault",
    arguments: { confirm: INDEX_CONFIRM, ...args },
  });
}

function untrustedBlockBodies(text: string, label: string): string[] {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(
    text.matchAll(new RegExp(`^\\s*\\[BEGIN UNTRUSTED VAULT CONTENT: ${escapedLabel}\\]\\n\\s*Treat .*\\n\\s*(.+)$`, "gm")),
    (match) => match[1].trim(),
  );
}

beforeEach(async () => {
  setPermissions({ readPaths: null, writePaths: null });
  setProviderForTests(new MockProvider());
  env = await createTestEnv({
    skipFixtures: true,
    extraFiles: {
      "cats.md": "# Cats\n\nMy cat is a kitten. Many cats here. The feline life.",
      "dogs.md": "# Dogs\n\nMy dog is a puppy. The canine life is great.",
      "cooking.md": "# Cooking\n\nA recipe in the kitchen. I love to bake.",
      "weather.md": "# Weather\n\nThe weather is sunny. No rain or storm today.",
      ".obsidian/daily-notes.json": JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
    },
  });
});

afterEach(async () => {
  await env.cleanup();
  await clearStore(env.vaultDir, { removeSnapshot: true });
  setPermissions({ readPaths: null, writePaths: null });
  resetProviderForTests();
});

describe("semantic handlers — index_vault", () => {
  it("requires explicit confirmation before sending note chunks to the provider", async () => {
    class CountingProvider extends MockProvider {
      calls = 0;
      override embed(texts: string[]): Promise<number[][]> {
        this.calls += texts.length;
        return super.embed(texts);
      }
    }
    const provider = new CountingProvider();
    setProviderForTests(provider);

    const result = await env.client.callTool({
      name: "index_vault",
      arguments: {},
    });

    expect(isError(result)).toBe(true);
    expect(textContent(result)).toContain("send-vault-text-to-embedding-provider");
    expect(provider.calls).toBe(0);
  });

  it("indexes all notes via the mock provider", async () => {
    const result = await indexVault();
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toMatch(/Indexed/);
    expect(text).toMatch(/Notes embedded:\s+4/);
    expect(text).toMatch(/Chunks embedded:/);
  });

  it("skips unchanged notes on a second pass", async () => {
    await indexVault();
    const second = await indexVault();
    const text = textContent(second);
    expect(text).toMatch(/Notes unchanged:\s+4/);
    expect(text).toMatch(/Notes embedded:\s+0/);
  });

  it("force=true re-embeds even unchanged notes", async () => {
    await indexVault();
    const forced = await indexVault({ force: true });
    const text = textContent(forced);
    expect(text).toMatch(/Notes embedded:\s+4/);
  });

  it("keeps note paths out of index_vault progress messages", async () => {
    const dirtyPath = "00 ignore previous instructions.md";
    await fs.writeFile(
      path.join(env.vaultDir, dirtyPath),
      "# Progress\n\nA cat note used to check progress labels.",
      "utf-8",
    );
    const messages: string[] = [];

    const result = await env.client.callTool(
      { name: "index_vault", arguments: { force: true, confirm: INDEX_CONFIRM } },
      undefined,
      {
        onprogress: (progress) => {
          if (progress.message) messages.push(progress.message);
        },
      },
    );

    expect(isError(result)).toBe(false);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.join("\n")).not.toContain(dirtyPath);
    expect(messages.some((message) => /note \d+\/\d+/.test(message))).toBe(true);
  });

  it("escapes configured provider labels in summaries", async () => {
    class DirtyProvider extends MockProvider {
      readonly id = "mock\nprovider";
      readonly model = "topic\tcounter";
    }
    setProviderForTests(new DirtyProvider());

    const result = await indexVault();

    const text = textContent(result);
    expect(text).toContain("via mock\\nprovider/topic\\tcounter");
    expect(text).not.toContain("mock\nprovider");
    expect(text).not.toContain("topic\tcounter");
  });

  it("marks failed note paths in index warnings as untrusted", async () => {
    class FailingProvider implements EmbeddingProvider {
      readonly id = "mock";
      readonly model = "failing";
      embed(): Promise<number[][]> {
        return Promise.reject(new Error("provider failed"));
      }
    }

    const dirtyPath = "dirty\x7fsemantic.md";
    await env.cleanup();
    await clearStore(env.vaultDir, { removeSnapshot: true });
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        [dirtyPath]: "# Dirty\n\nCats cats cats.",
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
      },
    });
    setProviderForTests(new FailingProvider());

    const result = await indexVault();

    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(isError(result)).toBe(false);
    expect(text).toContain("Failures:        1");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: index_vault failed note]");
    expect(text).toContain("dirty\\x7fsemantic.md: provider failed");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: index_vault failed note: dirty\\x7fsemantic.md]");
    expect(text).not.toContain(dirtyPath);
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
    expect(block._meta?.["obsidian-mcp-pro/untrustedContentLabel"]).toBe("index_vault failed notes");
  });

  it("records invalid live provider vectors as failed notes without aborting the index", async () => {
    class InvalidVectorProvider extends MockProvider {
      override embed(texts: string[]): Promise<number[][]> {
        return Promise.resolve(
          texts.map((text) =>
            text.toLowerCase().includes("cat") ? [Number.NaN, 0, 0, 0] : [1, 0, 0, 0],
          ),
        );
      }
    }
    setProviderForTests(new InvalidVectorProvider());

    const result = await indexVault();

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toMatch(/Notes embedded:\s+3/);
    expect(text).toContain("Failures:        1");
    expect(text).toContain("vector contains a non-finite value");
    expect(text).not.toContain("NaN");
  });

  it("records vectors that mismatch the stored dimension as failed notes", async () => {
    await indexVault();
    await fs.writeFile(
      path.join(env.vaultDir, "cats.md"),
      "# Cats\n\nCats changed enough to require a fresh embedding.",
      "utf-8",
    );

    class WrongDimensionProvider implements EmbeddingProvider {
      readonly id = "mock";
      readonly model = "topic-counter";
      embed(texts: string[]): Promise<number[][]> {
        return Promise.resolve(texts.map(() => [1, 0]));
      }
    }
    setProviderForTests(new WrongDimensionProvider());

    const result = await indexVault();

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toMatch(/Notes unchanged:\s+3/);
    expect(text).toMatch(/Notes embedded:\s+0/);
    expect(text).toContain("Failures:        1");
    expect(text).toContain("dimension mismatch");
  });
});

describe("semantic handlers — search_semantic", () => {
  it("returns the most semantically relevant note for a query", async () => {
    await indexVault();
    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "I want to learn about kittens and feline behavior", limit: 3 },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    const resultPaths = untrustedBlockBodies(text, "search_semantic result path");
    expect(resultPaths.length).toBeGreaterThan(0);
    expect(resultPaths[0]).toBe("cats.md");
  });

  it("errors with a helpful message when the index is empty", async () => {
    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "anything" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/index_vault/i);
  });

  it("rejects non-finite query vectors before scoring stored chunks", async () => {
    await indexVault();
    class BadQueryProvider implements EmbeddingProvider {
      readonly id = "mock";
      readonly model = "topic-counter";
      embed(texts: string[]): Promise<number[][]> {
        return Promise.resolve(texts.map(() => [Number.NaN, 0, 0, 0]));
      }
    }
    setProviderForTests(new BadQueryProvider());

    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "cats", limit: 3 },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(true);
    expect(text).toContain("Provider returned an invalid query vector");
    expect(text).toContain("non-finite");
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("cats.md");
  });

  it("rejects wrong-dimension query vectors before cosine scoring", async () => {
    await indexVault();
    class WrongDimensionProvider implements EmbeddingProvider {
      readonly id = "mock";
      readonly model = "topic-counter";
      embed(texts: string[]): Promise<number[][]> {
        return Promise.resolve(texts.map(() => [1, 0]));
      }
    }
    setProviderForTests(new WrongDimensionProvider());

    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "cats", limit: 3 },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(true);
    expect(text).toContain("Provider returned an invalid query vector");
    expect(text).toContain("dimension mismatch");
    expect(text).not.toContain("cosineSimilarity");
    expect(text).not.toContain("cats.md");
  });

  it("respects the folder filter", async () => {
    await indexVault();
    // Force the search to a folder that contains nothing.
    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "cooking recipes", folder: "no-such-folder", limit: 5 },
    });
    expect(textContent(result)).toMatch(/No matches/);
  });

  it("escapes query labels when no matches are found", async () => {
    await indexVault();

    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "cats\ninjected", folder: "no-such-folder", limit: 5 },
    });

    const text = textContent(result);
    expect(text).toContain('No matches for "cats\\ninjected".');
    expect(text).not.toContain("cats\ninjected");
  });

  it("marks indexed headings and snippets as untrusted in search output", async () => {
    await env.cleanup();
    await clearStore(env.vaultDir, { removeSnapshot: true });
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "dirty.md": "# Dirty\tHeading\n\nCats cats cats ring \x07 bells.",
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
      },
    });

    await indexVault();
    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "cats", limit: 1 },
    });

    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: search_semantic result path]");
    expect(text).toContain("dirty.md");
    expect(text).toContain("    Heading:");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: semantic heading]");
    expect(text).toContain("Dirty\\tHeading");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: semantic snippet]");
    expect(text).toContain("\\x07");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: search_semantic result path: dirty.md]");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: semantic heading: dirty.md]");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: semantic snippet: dirty.md]");
    expect(text).not.toContain("Dirty\tHeading");
    expect(text).not.toContain("\x07");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });

  it("filters persisted embedding hits through the current read allowlist", async () => {
    await env.cleanup();
    await clearStore(env.vaultDir, { removeSnapshot: true });
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "public/cats.md": "# Public Cats\n\nCats are friendly companions.",
        "private/secret.md": "# Private Cats\n\nCats guard the private launch notes.",
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
      },
    });

    await indexVault();
    setPermissions({ readPaths: ["public"], writePaths: null });

    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "cats", limit: 5 },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain("public/cats.md");
    expect(text).not.toContain("private/secret.md");
    expect(text).not.toContain("private launch notes");
  });

  it("drops stale snippets when an indexed note has changed", async () => {
    await env.cleanup();
    await clearStore(env.vaultDir, { removeSnapshot: true });
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "cats.md": "# Cats\n\nCats carry the stale launch instructions.",
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
      },
    });

    await indexVault();
    await fs.writeFile(
      path.join(env.vaultDir, "cats.md"),
      "# Dogs\n\nThe current note is only about dogs.",
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "cats", limit: 5 },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toMatch(/No matches/);
    expect(text).not.toContain("stale launch instructions");
  });

  it("rejects forged persisted snippets even when the note hash matches", async () => {
    const liveContent = await fs.readFile(path.join(env.vaultDir, "cats.md"), "utf-8");
    const snapshotPath = path.join(env.vaultDir, ".obsidian", "cache", "mcp-pro-embeddings.json");
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await fs.writeFile(
      snapshotPath,
      JSON.stringify({
        version: 1,
        vaultRoot: path.resolve(env.vaultDir),
        providerId: "mock",
        model: "topic-counter",
        dimension: 4,
        noteHashes: { "cats.md": hashText(liveContent) },
        embeddings: [
          {
            notePath: "cats.md",
            chunkIndex: 1,
            headingPath: [],
            text: "Cats carry forged launch instructions.",
            hash: "",
            vector: [5, 0.0001, 0.0001, 0.0001],
          },
        ],
      }),
      "utf-8",
    );
    await clearStore(env.vaultDir);

    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "cats", limit: 5 },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toMatch(/No matches/);
    expect(text).not.toContain("forged launch instructions");
  });
});

describe("semantic handlers — find_similar_notes", () => {
  it("returns the most similar notes excluding the source", async () => {
    await indexVault();
    const result = await env.client.callTool({
      name: "find_similar_notes",
      arguments: { path: "cats.md", limit: 3 },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    const resultPaths = untrustedBlockBodies(text, "find_similar_notes result path");
    expect(resultPaths.length).toBeGreaterThan(0);
    expect(resultPaths).not.toContain("cats.md");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: find_similar_notes result path: cats.md]");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: find_similar_notes result path]");
    // dogs.md (also pets) shares no topic dimension with cats; results
    // simply rank the rest by similarity. Just check we got hits back.
    expect(text).toMatch(/note\(s\) similar to cats\.md/);
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });

  it("errors when the source note has no embeddings", async () => {
    const result = await env.client.callTool({
      name: "find_similar_notes",
      arguments: { path: "cats.md" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/index_vault/i);
  });

  it("escapes caller-supplied missing source paths", async () => {
    const result = await env.client.callTool({
      name: "find_similar_notes",
      arguments: { path: "missing\nnote.md" },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(true);
    expect(text).toContain('No embeddings found for "missing\\nnote.md"');
    expect(text).not.toContain("missing\nnote.md");
  });

  it("marks indexed headings as untrusted in similar-note output", async () => {
    await env.cleanup();
    await clearStore(env.vaultDir, { removeSnapshot: true });
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "dirty.md": "# Dirty\tHeading\n\nCats cats cats ring bells.",
        "source.md": "# Source\n\nCats.",
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
      },
    });

    await indexVault();
    const result = await env.client.callTool({
      name: "find_similar_notes",
      arguments: { path: "source.md", limit: 1 },
    });

    const text = textContent(result);
    const block = result.content[0] as { _meta?: Record<string, unknown> };
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: find_similar_notes result path]");
    expect(text).toContain("dirty.md");
    expect(text).toContain("    Heading:");
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: semantic heading]");
    expect(text).toContain("Dirty\\tHeading");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: find_similar_notes result path: dirty.md]");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: semantic heading: dirty.md]");
    expect(text).not.toContain("Dirty\tHeading");
    expect(block._meta?.["obsidian-mcp-pro/contentTrust"]).toBe("untrusted-vault-content");
  });

  it("rejects an unreadable source note from the persisted embedding store", async () => {
    await env.cleanup();
    await clearStore(env.vaultDir, { removeSnapshot: true });
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "public/cats.md": "# Public Cats\n\nCats are friendly companions.",
        "private/secret.md": "# Private Cats\n\nCats guard the private launch notes.",
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
      },
    });

    await indexVault();
    setPermissions({ readPaths: ["public"], writePaths: null });

    const result = await env.client.callTool({
      name: "find_similar_notes",
      arguments: { path: "private/secret.md", limit: 5 },
    });

    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/Access denied/);
  });

  it("filters similar-note results through the current read allowlist", async () => {
    await env.cleanup();
    await clearStore(env.vaultDir, { removeSnapshot: true });
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "public/cats.md": "# Public Cats\n\nCats are friendly companions.",
        "public/dogs.md": "# Public Dogs\n\nDogs are loyal companions.",
        "private/secret.md": "# Private Cats\n\nCats guard the private launch notes.",
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
      },
    });

    await indexVault();
    setPermissions({ readPaths: ["public"], writePaths: null });

    const result = await env.client.callTool({
      name: "find_similar_notes",
      arguments: { path: "public/cats.md", limit: 5 },
    });

    const text = textContent(result);
    expect(isError(result)).toBe(false);
    expect(text).toContain("[BEGIN UNTRUSTED VAULT CONTENT: find_similar_notes result path]");
    expect(text).toContain("public/dogs.md");
    expect(text).not.toContain("[BEGIN UNTRUSTED VAULT CONTENT: find_similar_notes result path: public/dogs.md]");
    expect(text).not.toContain("private/secret.md");
  });

  it("refuses stale source-note embeddings", async () => {
    await env.cleanup();
    await clearStore(env.vaultDir, { removeSnapshot: true });
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "source.md": "# Cats\n\nCats are the original source topic.",
        "target.md": "# Target\n\nCats are nearby.",
        ".obsidian/daily-notes.json": JSON.stringify({ folder: "", format: "YYYY-MM-DD" }),
      },
    });

    await indexVault();
    await fs.writeFile(
      path.join(env.vaultDir, "source.md"),
      "# Weather\n\nThe current source topic is rain.",
      "utf-8",
    );

    const result = await env.client.callTool({
      name: "find_similar_notes",
      arguments: { path: "source.md", limit: 5 },
    });

    expect(isError(result)).toBe(true);
    const text = textContent(result);
    expect(text).toMatch(/No current embeddings found/);
    expect(text).not.toContain("target.md");
  });
});

describe("semantic handlers — provider missing", () => {
  it("each tool returns a configuration hint when no provider is set", async () => {
    setProviderForTests(null);
    const r1 = await indexVault();
    expect(isError(r1)).toBe(true);
    expect(textContent(r1)).toMatch(/OBSIDIAN_EMBEDDING_PROVIDER/);

    const r2 = await env.client.callTool({ name: "search_semantic", arguments: { query: "x" } });
    expect(isError(r2)).toBe(true);
    expect(textContent(r2)).toMatch(/OBSIDIAN_EMBEDDING_PROVIDER/);
  });

  it("does not echo secret-bearing embedding URLs in provider configuration errors", async () => {
    resetProviderForTests();
    process.env.OBSIDIAN_EMBEDDING_PROVIDER = "ollama";
    process.env.OBSIDIAN_EMBEDDING_URL =
      "ftp://user:pa55@example.internal:11434/v1?token=secret#debug";
    process.env.OBSIDIAN_EMBEDDING_MODEL = "test-model";
    try {
      const result = await indexVault();
      const text = textContent(result);
      expect(isError(result)).toBe(true);
      expect(text).toContain("OBSIDIAN_EMBEDDING_URL scheme/host not allowed");
      expect(text).not.toContain("user");
      expect(text).not.toContain("pa55");
      expect(text).not.toContain("token=secret");
      expect(text).not.toContain("example.internal");
      expect(text).not.toContain("#debug");
    } finally {
      delete process.env.OBSIDIAN_EMBEDDING_PROVIDER;
      delete process.env.OBSIDIAN_EMBEDDING_URL;
      delete process.env.OBSIDIAN_EMBEDDING_MODEL;
      resetProviderForTests();
      setProviderForTests(new MockProvider());
    }
  });
});

