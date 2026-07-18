import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  asError,
  defineTool,
  error,
  richText,
  text,
  untrustedText,
} from "../lib/tool-seam.js";
import {
  formatUntrustedVaultContent,
  untrustedVaultContentMeta,
} from "../lib/tool-output.js";

// The seam's ToolResult is the wire shape (CallToolResult) plus a phantom
// brand; read the fields off it as a plain result for assertions.
type Item = { type: string; text?: string; _meta?: Record<string, unknown> };
function firstItem(result: unknown): Item {
  return (result as CallToolResult).content[0] as Item;
}
function flags(result: unknown): { isError?: boolean } {
  return result as { isError?: boolean };
}

describe("tool-seam vocabulary", () => {
  it("text produces a trusted block with no trust _meta", () => {
    const item = firstItem(text("hello"));
    expect(item).toEqual({ type: "text", text: "hello" });
    expect(item._meta).toBeUndefined();
    expect(flags(text("hello")).isError).toBeUndefined();
  });

  it("untrustedText wraps the whole body and tags item _meta", () => {
    const item = firstItem(untrustedText("note body", "vault text"));
    expect(item.text).toBe(
      formatUntrustedVaultContent("note body", "vault text")
    );
    expect(item._meta).toEqual(untrustedVaultContentMeta("note body"));
  });

  it("error carries the message verbatim and sets isError", () => {
    const result = error("Note already exists at 'x.md'.");
    expect(firstItem(result).text).toBe("Note already exists at 'x.md'.");
    expect(flags(result).isError).toBe(true);
    // Domain errors are not re-wrapped as untrusted content.
    expect(firstItem(result)._meta).toBeUndefined();
  });

  it("richText joins trusted framing with inline untrusted segments", () => {
    const result = richText("item label", (b) => {
      b.trusted("Header:");
      b.untrusted("seg label", "PATH", "  ");
    });
    const item = firstItem(result);
    expect(item.text).toBe(
      "Header:\n" +
        formatUntrustedVaultContent("seg label", "PATH")
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n")
    );
    // Independent labels: the block-level _meta uses the item label, not the
    // segment label.
    expect(item._meta).toEqual(untrustedVaultContentMeta("item label"));
  });

  it("richText omits _meta when no untrusted section is appended", () => {
    const result = richText("item label", (b) => {
      b.trusted("Nothing untrusted here.");
    });
    expect(firstItem(result)._meta).toBeUndefined();
  });

  it("asError flags a built (untrusted-carrying) result as an error", () => {
    const result = asError(
      richText("expected path", (b) => {
        b.trusted("Not found.");
        b.untrusted("expected path", "daily/x.md");
      })
    );
    expect(flags(result).isError).toBe(true);
    expect(firstItem(result)._meta).toEqual(
      untrustedVaultContentMeta("expected path")
    );
  });
});

describe("defineTool boundary", () => {
  async function callThrough(
    register: (server: McpServer) => void,
    toolName: string
  ): Promise<CallToolResult> {
    const server = new McpServer(
      { name: "seam-test", version: "0.0.0" },
      { capabilities: {} }
    );
    register(server);
    const client = new Client({ name: "seam-test-client", version: "0.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    try {
      return (await client.callTool({
        name: toolName,
        arguments: {},
      })) as CallToolResult;
    } finally {
      await client.close();
    }
  }

  const baseSpec = {
    title: "Probe",
    description: "Test-only tool exercising the seam boundary.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {},
  };

  it("sanitizes thrown errors, applies the generic prefix, and sets isError", async () => {
    const secretPath = "/Users/secret/vault/private.md";
    const result = await callThrough((server) => {
      defineTool(server, "/vault", { name: "boom", ...baseSpec }, () => {
        throw new Error(`disk exploded at ${secretPath}`);
      });
    }, "boom");

    const item = firstItem(result);
    expect(result.isError).toBe(true);
    expect(item.text?.startsWith("Error: ")).toBe(true);
    // The leak is closed: the absolute path must not survive into the response.
    expect(item.text).not.toContain(secretPath);
  });

  it("renders an untrusted ToolResult with markers and trust _meta", async () => {
    const result = await callThrough((server) => {
      defineTool(server, "/vault", { name: "reads", ...baseSpec }, () =>
        untrustedText("probe body", "row-one\nrow-two")
      );
    }, "reads");

    const item = firstItem(result);
    expect(item.text).toBe(
      formatUntrustedVaultContent("probe body", "row-one\nrow-two")
    );
    expect(item._meta).toEqual(untrustedVaultContentMeta("probe body"));
    expect(result.isError).toBeFalsy();
  });
});
