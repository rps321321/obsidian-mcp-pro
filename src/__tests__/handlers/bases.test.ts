import { describe, it, expect, afterEach } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./harness.js";

let env: TestEnv | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

describe("base handlers — query_base", () => {
  it("populates file.size/ctime/mtime for Base filters", async () => {
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: {
        "note.md": "# Note\n\nBody",
        "stats.base": [
          "filters:",
          "  and:",
          "    - file.size > 0",
          "    - file.ctime > 0",
          "    - file.mtime > 0",
          "",
        ].join("\n"),
      },
    });

    const result = await env.client.callTool({
      name: "query_base",
      arguments: { path: "stats.base" },
    });

    expect(isError(result)).toBe(false);
    expect(textContent(result)).toContain("- note.md");
  });
});
