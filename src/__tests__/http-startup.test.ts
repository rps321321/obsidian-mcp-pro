import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { createServer, get, Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { log } from "../lib/logger.js";
import {
  startHttpServer,
  type HttpServerHandle,
  type HttpServerOptions,
} from "../http-server.js";

const handles: HttpServerHandle[] = [];
const holders: Server[] = [];
const nativeListeningListeners = createServer().listenerCount("listening");
let intervals: MockInstance<typeof globalThis.setInterval>;

function options(
  overrides: Partial<HttpServerOptions> = {}
): HttpServerOptions {
  return {
    host: "127.0.0.1",
    port: 0,
    bearerToken: "synthetic-startup-token",
    buildMcpServer: () => new McpServer({ name: "startup-test", version: "1" }),
    installSignalHandlers: false,
    ...overrides,
  };
}

beforeEach(() => {
  intervals = vi.spyOn(globalThis, "setInterval");
});

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop();
  for (const holder of holders.splice(0)) {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
  for (const result of intervals.mock.results) {
    if (result.type === "return") clearInterval(result.value);
  }
  vi.restoreAllMocks();
});

describe("HTTP startup lifecycle", () => {
  it("rejects scoped IPv6 before listening or allocating timers and signals", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const signalCounts = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    await expect(
      startHttpServer(
        options({
          host: "fe80::1%synthetic-interface",
          installSignalHandlers: true,
        })
      )
    ).rejects.toThrow(
      "Scoped IPv6 bind addresses are not supported for HTTP URLs"
    );
    expect(listen).not.toHaveBeenCalled();
    expect(intervals).not.toHaveBeenCalled();
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(signalCounts);
  });
  it.each([
    ["::1", "[::1]"],
    ["::ffff:127.0.0.1", "[::ffff:7f00:1]"],
  ])(
    "returns a usable %s URL and canonical derived Host rule",
    async (host, hostname, context) => {
      const listeningLog = vi.spyOn(log, "info");
      let handle: HttpServerHandle;
      try {
        handle = await startHttpServer(
          options({ host, allowedHosts: ["vault.example.com:3333"] })
        );
      } catch (err) {
        if (
          err instanceof Error &&
          "code" in err &&
          ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(String(err.code))
        ) {
          context.skip();
          return;
        }
        throw err;
      }
      handles.push(handle);
      expect((await fetch(new URL("/health", handle.url))).status).toBe(200);
      const client = new Client({ name: "ipv6-test", version: "1" });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(handle.url), {
            requestInit: {
              headers: { Authorization: "Bearer synthetic-startup-token" },
            },
          })
        );
        expect(handle.host).toBe(host);
        expect(handle.url).toBe(`http://${hostname}:${handle.port}/mcp`);
        expect(listeningLog).toHaveBeenCalledWith(
          "HTTP server listening",
          expect.objectContaining({
            url: handle.url,
            allowedHosts: `vault.example.com:3333,${hostname}:${handle.port},127.0.0.1:${handle.port},localhost:${handle.port},[::1]:${handle.port}`,
          })
        );
        const denied = await new Promise<number | undefined>(
          (resolve, reject) => {
            get(
              {
                host,
                port: handle.port,
                path: "/mcp",
                headers: {
                  Host: `[2001:db8::42]:${handle.port}`,
                  Authorization: "Bearer synthetic-startup-token",
                },
                agent: false,
              },
              (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode));
              }
            ).on("error", reject);
          }
        );
        expect(denied).toBe(403);
      } finally {
        await client.close();
      }
      await handle.stop();
      await expect(handle.stop()).resolves.toBeUndefined();
    }
  );

  it("allocates no sweeper when allowedHosts validation fails", async () => {
    await expect(
      startHttpServer(options({ allowedHosts: ["*"] }))
    ).rejects.toThrow(/allowedHosts/);

    expect(intervals).not.toHaveBeenCalled();
  });

  it.each([-1, 65536, NaN])(
    "allocates no sweeper after invalid port %s",
    async (port) => {
      const listeners = vi.spyOn(Server.prototype, "once");
      await expect(startHttpServer(options({ port }))).rejects.toHaveProperty(
        "code",
        "ERR_SOCKET_BAD_PORT"
      );

      expect(intervals).not.toHaveBeenCalled();
      const attempted = listeners.mock.contexts.find(
        (server) => server instanceof Server
      );
      expect(attempted).toBeInstanceOf(Server);
      if (!(attempted instanceof Server))
        throw new Error("No startup server observed");
      expect(attempted.listenerCount("error")).toBe(0);
      expect(attempted.listenerCount("listening")).toBe(
        nativeListeningListeners
      );
    }
  );

  it("rejects an occupied port without leaving startup listeners, timers, or signals", async () => {
    const holder = createServer();
    holders.push(holder);
    await new Promise<void>((resolve) =>
      holder.listen(0, "127.0.0.1", resolve)
    );
    const address = holder.address();
    if (!address || typeof address === "string")
      throw new Error("No bound port");
    const listeners = vi.spyOn(Server.prototype, "once");
    const signalCounts = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];

    await expect(
      startHttpServer(
        options({ port: address.port, installSignalHandlers: true })
      )
    ).rejects.toHaveProperty("code", "EADDRINUSE");

    expect(intervals).not.toHaveBeenCalled();
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(signalCounts);
    const attempted = listeners.mock.contexts.find(
      (server) => server instanceof Server
    );
    expect(attempted).toBeInstanceOf(Server);
    if (!(attempted instanceof Server))
      throw new Error("No startup server observed");
    expect(attempted.listenerCount("error")).toBe(0);
    expect(attempted.listenerCount("listening")).toBe(nativeListeningListeners);

    await new Promise<void>((resolve) => holder.close(() => resolve()));
    holders.pop();
    const restarted = await startHttpServer(options({ port: address.port }));
    handles.push(restarted);
    expect(restarted.port).toBe(address.port);
  });

  it("preserves a synchronous listen error and removes startup listeners", async () => {
    const failure = Object.assign(new TypeError("Synthetic invalid host"), {
      code: "ERR_INVALID_ARG_VALUE",
    });
    const listeners = vi.spyOn(Server.prototype, "once");
    vi.spyOn(Server.prototype, "listen").mockImplementationOnce(() => {
      throw failure;
    });
    await expect(startHttpServer(options())).rejects.toBe(failure);

    expect(intervals).not.toHaveBeenCalled();
    const attempted = listeners.mock.contexts.find(
      (server) => server instanceof Server
    );
    if (!(attempted instanceof Server))
      throw new Error("No startup server observed");
    expect(attempted.listenerCount("error")).toBe(0);
    expect(attempted.listenerCount("listening")).toBe(nativeListeningListeners);
  });

  it("starts after failure, serves health, and clears its sweeper on repeated stop", async () => {
    await expect(startHttpServer(options({ port: -1 }))).rejects.toHaveProperty(
      "code",
      "ERR_SOCKET_BAD_PORT"
    );
    const listeners = vi.spyOn(Server.prototype, "once");
    const handle = await startHttpServer(options());
    handles.push(handle);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(
        { host: handle.host, port: handle.port, path: "/health", agent: false },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        }
      ).on("error", reject);
    });

    expect(status).toBe(200);
    expect(intervals).toHaveBeenCalledTimes(1);
    const listening = listeners.mock.contexts.find(
      (server) => server instanceof Server
    );
    if (!(listening instanceof Server))
      throw new Error("No listening server observed");
    expect(listening.listenerCount("error")).toBe(0);
    expect(listening.listenerCount("listening")).toBe(nativeListeningListeners);
    const clear = vi.spyOn(globalThis, "clearInterval");
    await handle.stop();
    await expect(handle.stop()).resolves.toBeUndefined();

    expect(clear).toHaveBeenCalledWith(intervals.mock.results[0].value);
    expect(listening.listening).toBe(false);
  });
});
