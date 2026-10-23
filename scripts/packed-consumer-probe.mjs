import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildMcpServer, createMcpServerServices, startHttpServer } from "obsidian-mcp-pro";

const consumer = import.meta.dirname;
const installed = path.join(consumer, "node_modules", "obsidian-mcp-pro");
const entry = await fs.realpath(fileURLToPath(import.meta.resolve("obsidian-mcp-pro")));
assert(entry.startsWith(`${await fs.realpath(installed)}${path.sep}`), "library resolves inside the installed package");
const metadata = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"));
const cli = path.join(installed, metadata.bin["obsidian-mcp-pro"]);
const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 15_000 });
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /obsidian-mcp-pro/i);

const vault = path.join(consumer, "vault");
await fs.mkdir(path.join(vault, ".obsidian"), { recursive: true });
await fs.mkdir(path.join(vault, "public"));
await fs.mkdir(path.join(vault, "archive"));
await fs.writeFile(path.join(vault, "public", "source.md"), "PACKED_SOURCE\n[[public/source#Detail]]\n[neighbor](./neighbor.md)\n");
await fs.writeFile(path.join(vault, "public", "neighbor.md"), "PACKED_NEIGHBOR\n");
await fs.writeFile(path.join(vault, ".obsidian", "private.md"), "PACKED_EXCLUDED\n");

const clients = new Set();
let server;
function client(name) {
  const value = new Client({ name, version: "1.0.0" });
  clients.add(value);
  return value;
}
function text(result) {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}
async function call(value, name, args) {
  const result = await value.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, text(result));
  return result;
}

try {
  const stdio = client("packed-stdio");
  await stdio.connect(new StdioClientTransport({
    command: process.execPath, args: [cli], stderr: "pipe",
    env: { OBSIDIAN_VAULT_PATH: vault, LOG_LEVEL: "silent" },
  }));
  assert.match(text(await call(stdio, "get_note", { path: "public/source.md" })), /PACKED_SOURCE/);
  await call(stdio, "append_to_note", { path: "public/source.md", content: "PACKED_APPEND" });
  assert.match(await fs.readFile(path.join(vault, "public", "source.md"), "utf8"), /PACKED_APPEND/);
  await call(stdio, "move_note", { oldPath: "./public/source.md", newPath: "archive/moved.md", confirmPath: "archive/moved.md" });
  const movedPath = path.join(vault, "archive", "moved.md");
  const moved = await fs.readFile(movedPath, "utf8");
  const selfTarget = /\[\[([^#|\]]+)/.exec(moved)?.[1];
  assert(selfTarget, "moved note retains its self-link");
  assert.equal(await fs.realpath(path.join(vault, `${selfTarget}.md`)), await fs.realpath(movedPath));
  const neighborTarget = /\[neighbor\]\(([^)]+)\)/.exec(moved)?.[1];
  assert(neighborTarget, "moved note retains its relative link");
  assert.equal(await fs.realpath(path.resolve(path.dirname(movedPath), neighborTarget)), await fs.realpath(path.join(vault, "public", "neighbor.md")));
  if (process.platform !== "win32") {
    await fs.chmod(movedPath, 0o600);
    await call(stdio, "append_to_note", { path: "archive/moved.md", content: "PRIVATE_APPEND" });
    assert.equal((await fs.stat(movedPath)).mode & 0o777, 0o600);
  }

  const aliases = [];
  for (const [name, target] of [["allowed-alias", "public"], ["excluded-alias", ".obsidian"]]) {
    try {
      await fs.symlink(path.join(vault, target), path.join(vault, name), process.platform === "win32" ? "junction" : "dir");
      aliases.push(name);
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS", "EINVAL"].includes(error.code)) throw error;
    }
  }
  if (aliases.includes("allowed-alias")) {
    assert.match(text(await call(stdio, "get_note", { path: "allowed-alias/neighbor.md" })), /PACKED_NEIGHBOR/);
  }
  if (aliases.includes("excluded-alias")) {
    const denied = await stdio.callTool({ name: "get_note", arguments: { path: "excluded-alias/private.md" } });
    assert.equal(denied.isError, true);
    assert(!text(denied).includes("PACKED_EXCLUDED"));
  }
  await stdio.close();

  const services = createMcpServerServices(vault);
  server = await startHttpServer({
    host: "127.0.0.1", port: 0, bearerToken: "packed-test-token", installSignalHandlers: false,
    buildMcpServer: () => buildMcpServer(vault, services),
  });
  const connect = async (name) => {
    const value = client(name);
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: "Bearer packed-test-token" } },
    });
    await value.connect(transport);
    return { value, transport };
  };
  const [first, second] = await Promise.all([connect("packed-http-one"), connect("packed-http-two")]);
  assert(first.transport.sessionId);
  assert(second.transport.sessionId);
  assert.notEqual(first.transport.sessionId, second.transport.sessionId);
  const firstSession = first.transport.sessionId;
  const reads = await Promise.all([first.value, second.value].map((value) => call(value, "get_note", { path: "archive/moved.md" })));
  for (const result of reads) assert.match(text(result), /PACKED_SOURCE/);
  await first.transport.terminateSession();
  await first.value.close();
  const reconnect = await connect("packed-http-reconnect");
  assert.notEqual(reconnect.transport.sessionId, firstSession);
  await call(reconnect.value, "append_to_note", { path: "archive/moved.md", content: "HTTP_APPEND" });
  assert.match(text(await call(second.value, "get_note", { path: "archive/moved.md" })), /HTTP_APPEND/);
  for (const value of clients) await value.close();
  const health = server.url.replace(/\/mcp$/, "/health");
  await server.stop();
  await server.stop();
  await assert.rejects(fetch(health, { signal: AbortSignal.timeout(2_000) }));
  console.log(JSON.stringify({ checks: ["installed-cli", "stdio-read-write-move", "relative-link-targets", "http-concurrent-sessions", "http-reconnect", "shutdown"], aliases, posixModes: process.platform !== "win32" }));
} finally {
  for (const value of clients) await value.close().catch(() => {});
  await server?.stop();
}
