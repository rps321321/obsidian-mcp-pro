import { afterEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";
import { createTestEnv, isError, textContent, type TestEnv } from "./harness.js";

let env: TestEnv | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

describe("write handlers — delete_note elicitation", () => {
  it("permanently deletes after a matching typed confirmation", async () => {
    env = await createTestEnv({
      clientCapabilities: { elicitation: {} },
      onElicit: (request) => {
        expect(request.params.message).toContain('Permanently delete "note-c.md"');
        expect(request.params.message).toContain("Type the note's path to confirm.");
        return {
          action: "accept",
          content: { confirmPath: "note-c.md" },
        };
      },
    });

    const result = await env.client.callTool({
      name: "delete_note",
      arguments: { path: "note-c.md", permanent: true, confirm: true },
    });

    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/permanently deleted/i);
    await expect(fs.access(path.join(env.vaultDir, "note-c.md"))).rejects.toThrow();
  });

  it("aborts when the typed confirmation path does not match", async () => {
    env = await createTestEnv({
      clientCapabilities: { elicitation: {} },
      onElicit: () => ({
        action: "accept",
        content: { confirmPath: "note-b.md" },
      }),
    });

    const result = await env.client.callTool({
      name: "delete_note",
      arguments: { path: "note-c.md", permanent: true, confirm: true },
    });

    expect(isError(result)).toBe(true);
    expect(textContent(result)).toContain(
      'Confirmation path did not match "note-c.md"; deletion aborted.'
    );
    await expect(fs.access(path.join(env.vaultDir, "note-c.md"))).resolves.toBeUndefined();
  });

  it("cancels without deleting when elicitation is dismissed", async () => {
    env = await createTestEnv({
      clientCapabilities: { elicitation: {} },
      onElicit: () => ({ action: "cancel" }),
    });

    const result = await env.client.callTool({
      name: "delete_note",
      arguments: { path: "note-c.md", permanent: true, confirm: true },
    });

    expect(isError(result)).toBe(false);
    expect(textContent(result)).toContain('Deletion of "note-c.md" cancelled.');
    await expect(fs.access(path.join(env.vaultDir, "note-c.md"))).resolves.toBeUndefined();
  });
});
