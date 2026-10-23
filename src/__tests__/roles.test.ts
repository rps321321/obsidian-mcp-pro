import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  buildMcpServer,
  TOOL_NAMES,
  type AuthorizationAuditEvent,
} from "../index.js";
import {
  startHttpServer,
  type AuthorizedHttpServerHandle,
  type RoleHttpServerOptions,
} from "../http-server.js";

const roles = [
  {
    id: "reader",
    tools: ["get_note", "list_tags", "get_daily_note", "get_recent_notes"],
  },
  { id: "search", tools: ["search_notes"] },
  { id: "writer", tools: ["create_note"] },
  { id: "empty", tools: [] },
];
const tokens = [
  { token: "reader-secret", roleId: "reader" },
  { token: "reader-second", roleId: "reader" },
  { token: "search-secret", roleId: "search" },
  { token: "writer-secret", roleId: "writer" },
  { token: "empty-secret", roleId: "empty" },
];
let vault: string;
let handle: AuthorizedHttpServerHandle | undefined;
const clients: Client[] = [];
let events: AuthorizationAuditEvent[];
beforeEach(async () => {
  vault = await mkdtemp(join(tmpdir(), "mcp-roles-"));
  await writeFile(join(vault, "secret.md"), "private vault text #test");
  events = [];
});
afterEach(async () => {
  await Promise.all(
    clients.splice(0).map((c) => c.close().catch(() => undefined))
  );
  await handle?.stop();
  handle = undefined;
  await rm(vault, { recursive: true, force: true });
});
async function start(overrides: Partial<RoleHttpServerOptions> = {}) {
  handle = await startHttpServer({
    host: "127.0.0.1",
    port: 0,
    roles,
    tokens,
    buildMcpServer: (options) => buildMcpServer(vault, undefined, options),
    onAudit: (event) => events.push(event),
    installSignalHandlers: false,
    ...overrides,
  });
  return handle;
}
async function connect(token: string) {
  const client = new Client({ name: "role-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(handle!.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
}
async function post(
  token: string,
  sessionId: string | undefined,
  method: string,
  params: unknown = {}
) {
  return fetch(handle!.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 42, method, params }),
  });
}
async function local(tools?: readonly string[]) {
  const server = buildMcpServer(vault, undefined, { tools });
  const client = new Client({ name: "local-role-test", version: "1" });
  clients.push(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, server };
}

describe("Role registration", () => {
  it("registers only requested tools and audits the complete catalog against SDK discovery", async () => {
    const all = await local();
    expect(
      (await all.client.listTools()).tools.map((t) => t.name).sort()
    ).toEqual([...TOOL_NAMES].sort());
    const one = await local(["get_note"]);
    expect((await one.client.listTools()).tools.map((t) => t.name)).toEqual([
      "get_note",
    ]);
    expect(
      await one.client.callTool({
        name: "create_note",
        arguments: { path: "forbidden.md", content: "no" },
      })
    ).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringMatching(/not found/i) }],
    });
    await expect(readFile(join(vault, "forbidden.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(() =>
      one.server.registerTool("create_note", {}, () => ({ content: [] }))
    ).toThrow(/outside/);
  });
  it("returns empty discovery and rejects direct tools, resources, and prompts", async () => {
    await start();
    const { client } = await connect("empty-secret");
    expect(await client.listTools()).toEqual({ tools: [] });
    expect(await client.listResources()).toEqual({ resources: [] });
    expect(await client.listResourceTemplates()).toEqual({
      resourceTemplates: [],
    });
    expect(await client.listPrompts()).toEqual({ prompts: [] });
    await expect(
      client.callTool({ name: "get_note", arguments: { path: "secret.md" } })
    ).rejects.toThrow(/not found/i);
    await expect(
      client.readResource({ uri: "obsidian://note/secret.md" })
    ).rejects.toThrow();
    await expect(client.getPrompt({ name: "weekly-rollup" })).rejects.toThrow();
    const reader = await connect("reader-secret");
    expect(
      (await reader.client.listTools()).tools.map((t) => t.name).sort()
    ).toEqual([...roles[0]!.tools].sort());
    expect(
      (await reader.client.readResource({ uri: "obsidian://note/secret.md" }))
        .contents[0]
    ).toMatchObject({ text: expect.stringContaining("private vault text") });
  });
  it("gates resource templates, static resources, and prompts on their named tools", async () => {
    await start();
    const reader = await connect("reader-secret");
    expect(
      (await reader.client.listResourceTemplates()).resourceTemplates.map(
        (t) => t.uriTemplate
      )
    ).toEqual(["obsidian://note/{+path}"]);
    expect(
      (await reader.client.listResources()).resources.map((r) => r.uri).sort()
    ).toEqual(["obsidian://daily", "obsidian://tags"]);
    expect(
      (await reader.client.listPrompts()).prompts.map((p) => p.name)
    ).toEqual(["daily-review", "weekly-rollup"]);
    expect(
      (await reader.client.getPrompt({ name: "daily-review" })).messages[0]
        ?.content
    ).toMatchObject({ text: expect.stringContaining("list_tags") });
    for (const token of ["search-secret", "writer-secret"]) {
      const { client } = await connect(token);
      expect((await client.listResources()).resources).toEqual([]);
      expect((await client.listResourceTemplates()).resourceTemplates).toEqual(
        []
      );
      expect((await client.listPrompts()).prompts).toEqual([]);
      for (const uri of [
        "obsidian://note/secret.md",
        "obsidian://tags",
        "obsidian://daily",
      ])
        await expect(client.readResource({ uri })).rejects.toThrow();
      await expect(
        client.getPrompt({ name: "daily-review" })
      ).rejects.toThrow();
    }
    const { client } = await connect("writer-secret");
    const result = await client.callTool({
      name: "create_note",
      arguments: { path: "created.md", content: "written" },
    });
    expect(result.isError).not.toBe(true);
    expect(await readFile(join(vault, "created.md"), "utf8")).toContain(
      "written"
    );
  });
  it("denies all mutation and indexing paths for a read-only snapshot", async () => {
    const excluded = [
      "create_note",
      "create_daily_note",
      "append_to_note",
      "prepend_to_note",
      "update_frontmatter",
      "move_note",
      "delete_note",
      "update_section",
      "insert_at_section",
      "edit_block",
      "replace_in_note",
      "rename_tag",
      "add_canvas_node",
      "add_canvas_edge",
      "index_vault",
    ];
    await start({
      roles: [
        {
          id: "read-only",
          tools: TOOL_NAMES.filter((t) => !excluded.includes(t)),
        },
      ],
      tokens: [{ token: "read-only", roleId: "read-only" }],
    });
    const { client } = await connect("read-only");
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      TOOL_NAMES.filter((t) => !excluded.includes(t)).sort()
    );
    for (const name of excluded)
      await expect(
        client.callTool({
          name,
          arguments: { path: "secret.md", content: "destroy" },
        })
      ).rejects.toThrow(/not found/i);
    expect(await readFile(join(vault, "secret.md"), "utf8")).toBe(
      "private vault text #test"
    );
  });
});

describe("HTTP session authorization", () => {
  it("rejects a different valid token for POST, GET, and DELETE, including tokens sharing a role", async () => {
    await start();
    const { client, transport } = await connect("reader-secret");
    for (const token of ["reader-second", "search-secret"]) {
      expect(
        (await post(token, transport.sessionId, "tools/list")).status
      ).toBe(401);
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(handle!.url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Mcp-Session-Id": transport.sessionId!,
            Accept: "text/event-stream",
          },
        });
        expect(response.status).toBe(401);
      }
    }
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "get_note"
    );
  });
  it("closes edited and reassigned sessions immediately while preserving unaffected sessions", async () => {
    await start();
    const reader = await connect("reader-secret");
    const second = await connect("reader-second");
    const search = await connect("search-secret");
    await handle!.updateAuthorization({
      roles: roles.map((r) =>
        r.id === "reader" ? { ...r, tools: ["list_tags"] } : r
      ),
      tokens,
    });
    for (const sid of [
      reader.transport.sessionId,
      second.transport.sessionId,
    ]) {
      expect((await post("reader-secret", sid, "tools/list")).status).not.toBe(
        200
      );
    }
    expect((await search.client.listTools()).tools.map((t) => t.name)).toEqual([
      "search_notes",
    ]);
    const updated = await connect("reader-secret");
    expect((await updated.client.listTools()).tools.map((t) => t.name)).toEqual(
      ["list_tags"]
    );
    await handle!.updateAuthorization({
      roles,
      tokens: tokens.map((t) =>
        t.token === "search-secret" ? { ...t, roleId: "empty" } : t
      ),
    });
    expect(
      (await post("search-secret", search.transport.sessionId, "tools/list"))
        .status
    ).not.toBe(200);
    expect(
      (await (await connect("search-secret")).client.listTools()).tools
    ).toEqual([]);
  });
  it("revokes tokens and rejects invalid updates atomically without trusting caller array mutations", async () => {
    const mutable = {
      roles: structuredClone(roles),
      tokens: structuredClone(tokens),
    };
    await start(mutable);
    const reader = await connect("reader-secret");
    mutable.roles[0]!.tools.push("delete_note");
    mutable.tokens.length = 0;
    expect(
      (await reader.client.listTools()).tools.map((t) => t.name)
    ).not.toContain("delete_note");
    await expect(
      handle!.updateAuthorization({
        roles,
        tokens: [{ token: "reader-secret", roleId: "missing" }],
      })
    ).rejects.toThrow(/unknown Role/);
    expect(
      (await reader.client.listTools()).tools.map((t) => t.name)
    ).toContain("get_note");
    await handle!.updateAuthorization({
      roles,
      tokens: tokens.filter((t) => t.token !== "reader-secret"),
    });
    expect(
      (await post("reader-secret", reader.transport.sessionId, "tools/list"))
        .status
    ).toBe(401);
    expect((await post("reader-secret", undefined, "initialize")).status).toBe(
      401
    );
    expect(
      (await (await connect("reader-second")).client.listTools()).tools.map(
        (t) => t.name
      )
    ).toContain("get_note");
  });
  it("rechecks authorization after a body read that overlaps revocation", async () => {
    let admitted: (() => void) | undefined;
    await start({
      onAudit: (event) => {
        events.push(event);
        if (event.reason === "request_authenticated") admitted?.();
      },
    });
    const { transport } = await connect("writer-secret");
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_note",
        arguments: { path: "race.md", content: "no" },
      },
    });
    let finish!: () => void;
    const reading = new Promise<void>((resolve) => (admitted = resolve));
    const response = new Promise<number>((resolve, reject) => {
      const req = request(
        handle!.url,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer writer-secret",
            "Mcp-Session-Id": transport.sessionId!,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        }
      );
      req.on("error", reject);
      req.write(body.slice(0, body.length - 1));
      finish = () => req.end(body.slice(-1));
    });
    await reading;
    await handle!.updateAuthorization({
      roles,
      tokens: tokens.filter((t) => t.token !== "writer-secret"),
    });
    finish();
    expect(await response).toBe(401);
    await expect(readFile(join(vault, "race.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("does not admit an initialization revoked while connect is pending", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    await start({
      buildMcpServer: (options) => {
        const server = buildMcpServer(vault, undefined, options);
        const connect = server.connect.bind(server);
        server.connect = async (transport) => {
          entered();
          await gate;
          await connect(transport);
        };
        return server;
      },
    });
    const pending = post("reader-secret", undefined, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "race", version: "1" },
    });
    await started;
    await handle!.updateAuthorization({ roles, tokens: [] });
    release();
    expect((await pending).status).toBe(401);
  });
  it("fails closed when a factory ignores or changes the resolved tool filter", async () => {
    for (const factory of [
      () => buildMcpServer(vault),
      () => buildMcpServer(vault, undefined, { tools: ["delete_note"] }),
    ]) {
      await start({ buildMcpServer: factory });
      expect(
        (
          await post("reader-secret", undefined, "initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "x", version: "1" },
          })
        ).status
      ).toBe(500);
      await handle!.stop();
      handle = undefined;
    }
  });
  it("emits allow and deny events without secrets, arguments, note contents or unknown tool strings", async () => {
    await start();
    const { client, transport } = await connect("reader-secret");
    await client.callTool({
      name: "get_note",
      arguments: { path: "secret.md" },
    });
    await expect(
      client.callTool({ name: "delete_note", arguments: { path: "secret.md" } })
    ).rejects.toThrow();
    await expect(
      client.callTool({
        name: "reader-secret private vault text",
        arguments: {},
      })
    ).rejects.toThrow();
    expect(events).toContainEqual({
      roleId: "reader",
      sessionId: transport.sessionId,
      tool: "get_note",
      decision: "allow",
      reason: "tool_in_role",
    });
    expect(events).toContainEqual({
      roleId: "reader",
      sessionId: transport.sessionId,
      tool: "delete_note",
      decision: "deny",
      reason: "tool_not_in_role",
    });
    expect(JSON.stringify(events)).not.toMatch(
      /reader-secret|private vault text|secret\.md/
    );
  });
  it("preserves legacy single-token full discovery and token rotation through the update API", async () => {
    handle = await startHttpServer({
      host: "127.0.0.1",
      port: 0,
      bearerToken: "legacy",
      buildMcpServer: () => buildMcpServer(vault),
      installSignalHandlers: false,
    });
    const { client, transport } = await connect("legacy");
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(
      [...TOOL_NAMES].sort()
    );
    expect((await client.listPrompts()).prompts).toHaveLength(5);
    await handle.updateAuthorization({
      roles: [{ id: "full-access", tools: ["get_note"] }],
      tokens: [{ token: "new", roleId: "full-access" }],
    });
    expect(
      (await post("legacy", transport.sessionId, "tools/list")).status
    ).toBe(401);
    // A legacy callback must be upgraded to forward options before enabling Roles.
    expect(
      (
        await post("new", undefined, "initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "x", version: "1" },
        })
      ).status
    ).toBe(500);
  });
});

describe("Role boundary edge cases", () => {
  it("keeps Full Access as a saved snapshot and denies mixed batches before any write", async () => {
    await start({
      roles: [{ id: "full-access", tools: ["create_note"] }],
      tokens: [{ token: "snapshot", roleId: "full-access" }],
    });
    const { client, transport } = await connect("snapshot");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "create_note",
    ]);
    const response = await fetch(handle!.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer snapshot",
        "Mcp-Session-Id": transport.sessionId!,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "create_note",
            arguments: { path: "batch.md", content: "no" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "get_note", arguments: { path: "secret.md" } },
        },
      ]),
    });
    expect(await response.json()).toMatchObject({
      id: 2,
      error: { message: "Tool not found" },
    });
    await expect(readFile(join(vault, "batch.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("validates Host before the bearer in Role mode", async () => {
    await start({ allowedHosts: ["vault.example.com"] });
    async function probe(host: string) {
      return new Promise<number>((resolve, reject) => {
        const req = request(
          handle!.url,
          {
            method: "POST",
            headers: { Host: host, Authorization: "Bearer invalid" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          }
        );
        req.on("error", reject);
        req.end();
      });
    }
    expect(await probe("evil.example.com")).toBe(403);
    expect(await probe("vault.example.com")).toBe(401);
  });
  it("registers each prompt only while every Tool named in any argument branch is allowed", async () => {
    const full = await local();
    for (const { name } of (await full.client.listPrompts()).prompts) {
      const required = new Set<string>();
      for (const args of [
        {},
        { tag: "test" },
        { folder: "notes" },
        {
          path: "secret.md",
          tag: "test",
          folder: "notes",
          date: "2026-10-23",
          endDate: "2026-10-23",
          days: "90",
        },
      ]) {
        const prompt = await full.client.getPrompt({ name, arguments: args });
        const text = JSON.stringify(prompt.messages);
        for (const tool of TOOL_NAMES)
          if (new RegExp(`\\b${tool}\\b`).test(text)) required.add(tool);
      }
      expect(required.size).toBeGreaterThan(0);
      const allowed = await local([...required]);
      expect(
        (await allowed.client.listPrompts()).prompts.map((p) => p.name)
      ).toContain(name);
      for (const tool of required) {
        const restricted = await local([...required].filter((t) => t !== tool));
        expect(
          (await restricted.client.listPrompts()).prompts.map((p) => p.name)
        ).not.toContain(name);
      }
    }
  });
});

describe("Startup validation", () => {
  it.each([
    { bearerToken: "illegal", roles, tokens },
    { roles, tokens: [tokens[0], tokens[0]] },
    { roles: [...roles, roles[0]], tokens },
    { roles: [{ id: "x", tools: ["unknown_tool"] }], tokens: [] },
    { roles: [{ id: "x", tools: ["get_note", "get_note"] }], tokens: [] },
    { roles, tokens: [{ token: "x", roleId: "missing" }] },
    { roles, tokens: [{ token: "", roleId: "reader" }] },
    { roles, tokens: [{ token: " spaced ", roleId: "reader" }] },
    { roles: [{ id: "", tools: [] }], tokens: [] },
    { tokens: [] },
    { roles: [{ id: "sparse", tools: new Array<string>(1) }], tokens: [] },
    { roles, tokens: new Array(1) },
  ])("rejects invalid configuration before listen (%#)", async (invalid) => {
    await expect(
      startHttpServer({
        host: "127.0.0.1",
        port: 0,
        installSignalHandlers: false,
        buildMcpServer: () => buildMcpServer(vault),
        ...invalid,
      } as RoleHttpServerOptions)
    ).rejects.toThrow();
  });
});
