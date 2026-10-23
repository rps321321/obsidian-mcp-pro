import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { configureLogger } from "../../lib/logger.js";
import {
  createTestEnv,
  isError,
  textContent,
  type TestEnv,
} from "./harness.js";

let env: TestEnv | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  configureLogger({ level: "info", format: "text", mcpServer: null });
  await env?.cleanup();
  env = undefined;
});

const operations = [
  {
    name: "delete_note",
    arguments: {
      path: "note-c.md",
      permanent: true,
      confirm: true,
      removeReferences: true,
    },
  },
  {
    name: "move_note",
    arguments: {
      oldPath: "note-c.md",
      newPath: "moved.md",
      updateLinks: true,
      confirmPath: "moved.md",
    },
  },
  {
    name: "rename_tag",
    arguments: {
      oldName: "draft",
      newName: "ready",
      dryRun: false,
      confirmTag: "ready",
    },
  },
];

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const relative of await fs.readdir(root, { recursive: true })) {
    const full = path.join(root, relative);
    if ((await fs.stat(full)).isFile())
      files[relative] = await fs.readFile(full, "utf8");
  }
  return files;
}

describe("failed interactive confirmation", () => {
  it.each(operations)(
    "aborts $name on a client error without logging its contents",
    async (operation) => {
      const marker = "PRIVATE_CONFIRMATION_ERROR";
      env = await createTestEnv({
        clientCapabilities: { elicitation: { form: {} } },
        onElicit: () => {
          throw new Error(marker);
        },
      });
      const before = await snapshot(env.vaultDir);
      const logs: string[] = [];
      configureLogger({ level: "warn", format: "json", mcpServer: null });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        logs.push(String(chunk));
        return true;
      });
      const result = await env.client.callTool(operation);
      expect(isError(result)).toBe(true);
      expect(textContent(result)).toMatch(/confirmation failed.*aborted/i);
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(logs.join("")).not.toContain(marker);
      expect(await snapshot(env.vaultDir)).toEqual(before);
    }
  );

  it("aborts on an invalid typed-form response", async () => {
    env = await createTestEnv({
      clientCapabilities: { elicitation: { form: {} } },
      onElicit: () => ({ action: "accept", content: { confirmPath: 42 } }),
    });
    const before = await snapshot(env.vaultDir);
    const result = await env.client.callTool(operations[0]!);
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/confirmation failed.*aborted/i);
    expect(await snapshot(env.vaultDir)).toEqual(before);
  });

  it("aborts when the SDK confirmation request times out", async () => {
    const entered = Promise.withResolvers<void>();
    env = await createTestEnv({
      clientCapabilities: { elicitation: { form: {} } },
      onElicit: async () => {
        entered.resolve();
        return new Promise(() => {});
      },
    });
    const before = await snapshot(env.vaultDir);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = env.client.callTool(operations[0]!, undefined, {
      timeout: 120_000,
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(60_001);
    const result = await pending;
    vi.useRealTimers();
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/confirmation failed.*aborted/i);
    expect(await snapshot(env.vaultDir)).toEqual(before);
  });

  it.each(operations)(
    "does not accept a late $name confirmation after its tool request is cancelled",
    async (operation) => {
      const entered = Promise.withResolvers<void>();
      const reply = Promise.withResolvers<{
        action: "accept";
        content: { confirmPath: string; confirmTag: string };
      }>();
      env = await createTestEnv({
        clientCapabilities: { elicitation: { form: {} } },
        onElicit: () => {
          entered.resolve();
          return reply.promise;
        },
      });
      const before = await snapshot(env.vaultDir);
      const logs: string[] = [];
      configureLogger({ level: "warn", format: "json", mcpServer: null });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        logs.push(String(chunk));
        return true;
      });
      const controller = new AbortController();
      const pending = env.client
        .callTool(operation, undefined, { signal: controller.signal })
        .catch((error: unknown) => error);
      await entered.promise;
      controller.abort(new Error("PRIVATE_CANCELLATION_REASON"));
      await pending;
      reply.resolve({
        action: "accept",
        content: {
          confirmPath:
            operation.name === "move_note" ? "moved.md" : "note-c.md",
          confirmTag: "ready",
        },
      });
      await vi.waitFor(() =>
        expect(logs.join("")).toMatch(/confirmation failed.*aborted/i)
      );
      expect(logs.join("")).not.toContain("PRIVATE_CANCELLATION_REASON");
      expect(await snapshot(env.vaultDir)).toEqual(before);
    }
  );

  it("does not mutate after the transport closes during confirmation", async () => {
    const entered = Promise.withResolvers<void>();
    env = await createTestEnv({
      clientCapabilities: { elicitation: { form: {} } },
      onElicit: async () => {
        entered.resolve();
        return new Promise(() => {});
      },
    });
    const before = await snapshot(env.vaultDir);
    const logs: string[] = [];
    configureLogger({ level: "warn", format: "json", mcpServer: null });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      logs.push(String(chunk));
      return true;
    });
    const pending = env.client
      .callTool(operations[0]!)
      .catch((error: unknown) => error);
    await entered.promise;
    await env.client.close();
    await pending;
    await vi.waitFor(() =>
      expect(logs.join("")).toMatch(/confirmation failed.*aborted/i)
    );
    expect(await snapshot(env.vaultDir)).toEqual(before);
  });

  it.each([{}, { elicitation: { url: {} } }])(
    "uses the explicit-latch fallback when form elicitation is unsupported",
    async (capabilities) => {
      const onElicit = vi.fn(() => ({
        action: "accept" as const,
        content: { confirmPath: "note-c.md" },
      }));
      env = await createTestEnv({
        clientCapabilities: capabilities,
        ...("elicitation" in capabilities ? { onElicit } : {}),
      });
      const result = await env.client.callTool(operations[0]!);
      expect(isError(result)).toBe(false);
      expect(textContent(result)).toContain("permanently deleted");
      expect(onElicit).not.toHaveBeenCalled();
      await expect(
        fs.access(path.join(env.vaultDir, "note-c.md"))
      ).rejects.toThrow();
    }
  );

  it("retains the independent permanent-delete latch even with form support", async () => {
    const onElicit = vi.fn(() => ({
      action: "accept" as const,
      content: { confirmPath: "note-c.md" },
    }));
    env = await createTestEnv({
      clientCapabilities: { elicitation: { form: {} } },
      onElicit,
    });
    const before = await snapshot(env.vaultDir);
    const result = await env.client.callTool({
      name: "delete_note",
      arguments: { path: "note-c.md", permanent: true },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toContain("confirm=true");
    expect(onElicit).not.toHaveBeenCalled();
    expect(await snapshot(env.vaultDir)).toEqual(before);
  });
});
