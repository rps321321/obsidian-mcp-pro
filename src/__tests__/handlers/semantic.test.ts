import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";
import { setProviderForTests, resetProviderForTests, type EmbeddingProvider } from "../../lib/embedding-providers.js";
import { clearStore } from "../../lib/embedding-store.js";

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

beforeEach(async () => {
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
  resetProviderForTests();
});

describe("semantic handlers — index_vault", () => {
  it("indexes all notes via the mock provider", async () => {
    const result = await env.client.callTool({
      name: "index_vault",
      arguments: {},
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toMatch(/Indexed/);
    expect(text).toMatch(/Notes embedded:\s+4/);
    expect(text).toMatch(/Chunks embedded:/);
  });

  it("skips unchanged notes on a second pass", async () => {
    await env.client.callTool({ name: "index_vault", arguments: {} });
    const second = await env.client.callTool({ name: "index_vault", arguments: {} });
    const text = textContent(second);
    expect(text).toMatch(/Notes unchanged:\s+4/);
    expect(text).toMatch(/Notes embedded:\s+0/);
  });

  it("force=true re-embeds even unchanged notes", async () => {
    await env.client.callTool({ name: "index_vault", arguments: {} });
    const forced = await env.client.callTool({
      name: "index_vault",
      arguments: { force: true },
    });
    const text = textContent(forced);
    expect(text).toMatch(/Notes embedded:\s+4/);
  });
});

describe("semantic handlers — search_semantic", () => {
  it("returns the most semantically relevant note for a query", async () => {
    await env.client.callTool({ name: "index_vault", arguments: {} });
    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "I want to learn about kittens and feline behavior", limit: 3 },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toContain("cats.md");
  });

  it("errors with a helpful message when the index is empty", async () => {
    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "anything" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/index_vault/i);
  });

  it("respects the folder filter", async () => {
    await env.client.callTool({ name: "index_vault", arguments: {} });
    // Force the search to a folder that contains nothing.
    const result = await env.client.callTool({
      name: "search_semantic",
      arguments: { query: "cooking recipes", folder: "no-such-folder", limit: 5 },
    });
    expect(textContent(result)).toMatch(/No matches/);
  });
});

describe("semantic handlers — find_similar_notes", () => {
  it("returns the most similar notes excluding the source", async () => {
    await env.client.callTool({ name: "index_vault", arguments: {} });
    const result = await env.client.callTool({
      name: "find_similar_notes",
      arguments: { path: "cats.md", limit: 3 },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).not.toContain("- cats.md");
    // dogs.md (also pets) shares no topic dimension with cats; results
    // simply rank the rest by similarity. Just check we got hits back.
    expect(text).toMatch(/note\(s\) similar to cats\.md/);
  });

  it("errors when the source note has no embeddings", async () => {
    const result = await env.client.callTool({
      name: "find_similar_notes",
      arguments: { path: "cats.md" },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/index_vault/i);
  });
});

describe("semantic handlers — provider missing", () => {
  it("each tool returns a configuration hint when no provider is set", async () => {
    setProviderForTests(null);
    const r1 = await env.client.callTool({ name: "index_vault", arguments: {} });
    expect(isError(r1)).toBe(true);
    expect(textContent(r1)).toMatch(/OBSIDIAN_EMBEDDING_PROVIDER/);

    const r2 = await env.client.callTool({ name: "search_semantic", arguments: { query: "x" } });
    expect(isError(r2)).toBe(true);
    expect(textContent(r2)).toMatch(/OBSIDIAN_EMBEDDING_PROVIDER/);
  });
});
