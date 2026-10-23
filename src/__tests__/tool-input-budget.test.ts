import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  buildMcpServer,
  startHttpServer,
  type HttpServerHandle,
} from "../index.js";

function maxElements(
  schema: unknown,
  root: unknown = schema,
  ancestors = new Set<unknown>()
): number {
  if (!schema || typeof schema !== "object")
    throw new Error("Unbounded schema");
  if (ancestors.has(schema))
    throw new Error("Recursive tool schema needs a budget review");
  const next = new Set(ancestors).add(schema);
  const s = schema as Record<string, unknown>;
  if (
    s.allOf ||
    s.if ||
    s.dependentSchemas ||
    s.patternProperties ||
    s.prefixItems
  )
    throw new Error("Review unsupported tool schema budget");
  if (typeof s.$ref === "string") {
    if (s.type || s.anyOf || s.oneOf)
      throw new Error("Review schema reference siblings");
    if (!s.$ref.startsWith("#/")) throw new Error("Nonlocal schema reference");
    const target = s.$ref
      .slice(2)
      .split("/")
      .reduce<unknown>(
        (node, key) =>
          (node as Record<string, unknown>)[
            key.replace(/~1/g, "/").replace(/~0/g, "~")
          ],
        root
      );
    return maxElements(target, root, next);
  }
  for (const union of [s.anyOf, s.oneOf]) {
    if (Array.isArray(union)) {
      if (s.type) throw new Error("Review combined union schema budget");
      return Math.max(...union.map((part) => maxElements(part, root, next)));
    }
  }
  if (s.type === "object") {
    const properties = Object.values(
      (s.properties ?? {}) as Record<string, unknown>
    );
    if (s.additionalProperties && s.additionalProperties !== false)
      throw new Error("Unbounded object schema");
    return properties.reduce<number>(
      (count, property) => count + 1 + maxElements(property, root, next),
      0
    );
  }
  if (s.type === "array") {
    if (typeof s.maxItems !== "number")
      throw new Error("Unbounded array schema");
    return s.maxItems * (1 + maxElements(s.items, root, next));
  }
  if (
    ["string", "number", "integer", "boolean", "null"].includes(String(s.type))
  )
    return 0;
  throw new Error("Review unsupported tool schema budget");
}

describe.each(["stdio", "http"] as const)(
  "tool argument budget over %s",
  (protocol) => {
    it("accepts supported payloads and exactly 16 elements, rejects 17 before dispatch, and recovers", async () => {
      const vault = await fs.mkdtemp(
        path.join(os.tmpdir(), "tool-input-budget-")
      );
      const server = buildMcpServer(vault);
      const client = new Client({ name: "budget-test", version: "1" });
      let handle: HttpServerHandle | undefined;
      let transport: Transport;
      const input = new PassThrough();
      const output = new PassThrough();
      try {
        if (protocol === "http") {
          handle = await startHttpServer({
            host: "127.0.0.1",
            port: 0,
            bearerToken: "budget-test-token",
            installSignalHandlers: false,
            buildMcpServer: () => server,
          });
          transport = new StreamableHTTPClientTransport(new URL(handle.url), {
            requestInit: {
              headers: { Authorization: "Bearer budget-test-token" },
            },
          });
        } else {
          await server.connect(new StdioServerTransport(input, output));
          transport = new StdioServerTransport(output, input);
        }
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.length).toBeGreaterThanOrEqual(41);
        const largest = Math.max(
          ...tools.map((tool) => maxElements(tool.inputSchema))
        );
        expect(largest).toBeLessThanOrEqual(16);
        await fs.writeFile(
          path.join(vault, "test.canvas"),
          '{"nodes":[],"edges":[]}'
        );
        expect(
          (
            await client.callTool({
              name: "add_canvas_node",
              arguments: {
                canvasPath: "test.canvas",
                type: "text",
                content: "node",
                x: 0,
                y: 0,
                width: 250,
                height: 60,
                color: "1",
              },
            })
          ).isError
        ).not.toBe(true);

        const handler = vi.fn(async () => ({
          content: [{ type: "text" as const, text: "dispatched" }],
        }));
        server.registerTool("budget_probe", { inputSchema: {} }, handler);
        const exactly16 = { ignored: { nested: Array(14).fill(0) } };
        expect(
          (
            await client.callTool({
              name: "budget_probe",
              arguments: exactly16,
            })
          ).isError
        ).not.toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
        for (const arguments_ of [
          { ignored: { nested: Array(15).fill(0) } },
          { ignored: { nested: Array(100_000).fill(0) } },
        ]) {
          const result = await client.callTool({
            name: "budget_probe",
            arguments: arguments_,
          });
          expect(result.isError).toBe(true);
          expect(JSON.stringify(result)).toContain("maximum of 16 elements");
        }
        expect(handler).toHaveBeenCalledTimes(1);
        expect(
          (await client.callTool({ name: "get_vault_stats", arguments: {} }))
            .isError
        ).not.toBe(true);
        const content = "x".repeat(1_000_000);
        const frontmatter = JSON.stringify({ value: "f".repeat(99_988) });
        expect(frontmatter.length).toBe(100_000);
        const created = await client.callTool({
          name: "create_note",
          arguments: { path: "large.md", content, frontmatter },
        });
        expect(created.isError).not.toBe(true);
        expect(
          await fs.readFile(path.join(vault, "large.md"), "utf8")
        ).toContain(content);

        if (handle) {
          const body = "x".repeat(4 * 1024 * 1024 + 1);
          expect(
            (
              await fetch(handle.url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
              })
            ).status
          ).toBe(401);
          expect(
            (
              await fetch(handle.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: "Bearer budget-test-token",
                },
                body,
              })
            ).status
          ).toBe(413);
        }
      } finally {
        await client.close();
        await handle?.stop();
        await server.close();
        input.destroy();
        output.destroy();
        await fs.rm(vault, { recursive: true, force: true });
      }
    });
  }
);
