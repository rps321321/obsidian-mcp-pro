import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv({
    extraFiles: {
      "assets/used-image.png": "PNG-fake-bytes",
      "assets/orphan-image.png": "PNG-orphan-bytes",
      "assets/screenshot.jpg": "JPEG-fake-bytes",
      "assets/notes.pdf": "PDF-fake",
      "embed-host.md": "# Embed host\n\n![[used-image.png]]\n\nAlso linked: [doc](assets/notes.pdf)\n",
    },
  });
});

afterEach(async () => {
  await env.cleanup();
});

describe("attachments handlers — list_attachments", () => {
  it("lists every non-md/canvas/base file", async () => {
    const result = await env.client.callTool({
      name: "list_attachments",
      arguments: {},
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    expect(text).toMatch(/used-image\.png/);
    expect(text).toMatch(/orphan-image\.png/);
    expect(text).toMatch(/screenshot\.jpg/);
    expect(text).toMatch(/notes\.pdf/);
    // Markdown notes never appear in attachment listings.
    expect(text).not.toMatch(/embed-host\.md/);
  });

  it("filters by extension", async () => {
    const result = await env.client.callTool({
      name: "list_attachments",
      arguments: { extension: "png" },
    });
    const text = textContent(result);
    expect(text).toMatch(/used-image\.png/);
    expect(text).toMatch(/orphan-image\.png/);
    expect(text).not.toMatch(/screenshot\.jpg/);
    expect(text).not.toMatch(/notes\.pdf/);
  });

  it("returns a friendly message when no attachments match the filter", async () => {
    const result = await env.client.callTool({
      name: "list_attachments",
      arguments: { extension: "mp4" },
    });
    expect(isError(result)).toBe(false);
    expect(textContent(result)).toMatch(/No attachments with extension/i);
  });
});

describe("attachments handlers — find_unused_attachments", () => {
  it("reports attachments not referenced by any note", async () => {
    const result = await env.client.callTool({
      name: "find_unused_attachments",
      arguments: {},
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);
    // used-image.png is embedded; notes.pdf is linked. Both should be safe.
    expect(text).not.toMatch(/used-image\.png/);
    expect(text).not.toMatch(/notes\.pdf/);
    // orphan-image.png and screenshot.jpg have no references at all.
    expect(text).toMatch(/orphan-image\.png/);
    expect(text).toMatch(/screenshot\.jpg/);
  });

  it("reports total reclaimable bytes when includeBytes=true", async () => {
    const result = await env.client.callTool({
      name: "find_unused_attachments",
      arguments: { includeBytes: true },
    });
    const text = textContent(result);
    expect(text).toMatch(/Total reclaimable: \d+ bytes/);
    // Each line for an unused attachment carries its byte size.
    expect(text).toMatch(/orphan-image\.png\s+\(\d+ bytes\)/);
  });

  it("returns a friendly message when every attachment is referenced", async () => {
    // Drop all unreferenced attachments via a fresh env tailored for it.
    await env.cleanup();
    env = await createTestEnv({
      extraFiles: {
        "assets/used-only.png": "x",
        "linker.md": "Embed: ![[used-only.png]]\n",
      },
    });
    const result = await env.client.callTool({
      name: "find_unused_attachments",
      arguments: {},
    });
    expect(textContent(result)).toMatch(/All \d+ attachment\(s\) are referenced/);
  });
});

describe("attachments handlers — get_attachment", () => {
  it("returns image content blocks for PNG attachments", async () => {
    const result = await env.client.callTool({
      name: "get_attachment",
      arguments: { path: "assets/used-image.png" },
    });
    expect(isError(result)).toBe(false);
    const blocks = (result.content as Array<{ type: string; data?: string; mimeType?: string }>);
    const imageBlock = blocks.find((b) => b.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.mimeType).toBe("image/png");
    expect(imageBlock!.data).toBe(Buffer.from("PNG-fake-bytes").toString("base64"));
  });

  it("returns a resource block for non-image/audio types", async () => {
    const result = await env.client.callTool({
      name: "get_attachment",
      arguments: { path: "assets/notes.pdf" },
    });
    expect(isError(result)).toBe(false);
    const blocks = result.content as Array<{ type: string; resource?: { uri?: string; mimeType?: string } }>;
    const resourceBlock = blocks.find((b) => b.type === "resource");
    expect(resourceBlock).toBeDefined();
    expect(resourceBlock!.resource!.mimeType).toBe("application/pdf");
    expect(resourceBlock!.resource!.uri).toBe("vault://assets/notes.pdf");
  });

  it("rejects markdown / canvas / base files", async () => {
    const md = await env.client.callTool({
      name: "get_attachment",
      arguments: { path: "embed-host.md" },
    });
    expect(isError(md)).toBe(true);
    expect(textContent(md)).toMatch(/use get_note/i);
  });

  it("enforces the maxBytes cap", async () => {
    const result = await env.client.callTool({
      name: "get_attachment",
      arguments: { path: "assets/used-image.png", maxBytes: 1 },
    });
    expect(isError(result)).toBe(true);
    expect(textContent(result)).toMatch(/over the 1-byte limit/i);
  });
});
