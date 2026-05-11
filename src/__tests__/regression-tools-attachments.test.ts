import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, textContent, isError, type TestEnv } from "./handlers/harness.js";

// ---------------------------------------------------------------------------
// C5: find_unused_attachments "Total reclaimable" must reflect ALL unused
// attachments, not the truncated subset shown to the user.
//
// Original bug: the stat loop ran on `truncated = unused.slice(0, limit)`,
// so a user with 1,000 unused PNGs and the default limit of 200 was told
// the reclaimable total covered only the first 200. Acting on that number
// silently under-deletes by 80% in extreme cases.
//
// Fix: stat ALL files in `unused` so totalBytes is accurate; per-file
// byte sizes still only render for the truncated subset (we don't dump
// thousands of lines back at the user). The label now spells out that
// the figure spans every unused attachment.
// ---------------------------------------------------------------------------

let env: TestEnv;

afterEach(async () => {
  if (env) await env.cleanup();
});

/**
 * Build an `extraFiles` map of N attachments where attachment i has a body
 * of length `(i + 1)`. Total expected byte count is the sum 1..N = N*(N+1)/2.
 * Deterministic and trivially verifiable.
 */
function makeAttachments(count: number): { files: Record<string, string>; expectedTotal: number } {
  const files: Record<string, string> = {};
  let expectedTotal = 0;
  for (let i = 0; i < count; i++) {
    const size = i + 1;
    const body = "x".repeat(size);
    // Zero-pad so lexicographic sort matches numeric order — keeps test
    // assertions about ordering simpler if we ever need them later.
    const name = `assets/orphan-${String(i).padStart(4, "0")}.bin`;
    files[name] = body;
    expectedTotal += size;
  }
  return { files, expectedTotal };
}

describe("C5: find_unused_attachments — totalBytes covers all unused, not truncated", () => {
  it("reports totalBytes for ALL 100 unused attachments when limit=10", async () => {
    const { files, expectedTotal } = makeAttachments(100);
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: files,
    });

    const result = await env.client.callTool({
      name: "find_unused_attachments",
      arguments: { limit: 10, includeBytes: true },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);

    // Total must equal sum 1..100 = 5050, not the sum of the first 10 (=55)
    // or the last 10 (=955). We assert the exact number so any regression
    // that re-introduces stat-on-truncated trips this immediately.
    const match = text.match(/Total reclaimable: ([\d,]+) bytes/);
    expect(match).not.toBeNull();
    const reported = Number.parseInt(match![1].replace(/,/g, ""), 10);
    expect(reported).toBe(expectedTotal);
    expect(reported).toBe(5050);

    // The output should also mention the full count of unused attachments,
    // not just the shown count, so users know there's more behind the cap.
    expect(text).toMatch(/100 unused attachment/);
    expect(text).toMatch(/showing first 10/);
  });

  it("matches the simple-case total when unused.length <= limit (behavior unchanged)", async () => {
    const { files, expectedTotal } = makeAttachments(5);
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: files,
    });

    const result = await env.client.callTool({
      name: "find_unused_attachments",
      arguments: { limit: 200, includeBytes: true },
    });
    expect(isError(result)).toBe(false);
    const text = textContent(result);

    const match = text.match(/Total reclaimable: ([\d,]+) bytes/);
    expect(match).not.toBeNull();
    const reported = Number.parseInt(match![1].replace(/,/g, ""), 10);
    // Sum 1..5 = 15
    expect(reported).toBe(expectedTotal);
    expect(reported).toBe(15);

    // Every attachment is shown (no truncation) and each carries its size.
    for (let i = 0; i < 5; i++) {
      const name = `orphan-${String(i).padStart(4, "0")}\\.bin`;
      expect(text).toMatch(new RegExp(`${name}\\s+\\(\\d+ bytes\\)`));
    }
    // No truncation message when limit is not exceeded.
    expect(text).not.toMatch(/showing first/);
  });

  it("reports the total count of unused attachments alongside the shown count", async () => {
    const { files } = makeAttachments(50);
    env = await createTestEnv({
      skipFixtures: true,
      extraFiles: files,
    });

    const result = await env.client.callTool({
      name: "find_unused_attachments",
      arguments: { limit: 5, includeBytes: false },
    });
    const text = textContent(result);

    // Header must mention 50 (total unused) AND 5 (shown).
    expect(text).toMatch(/50 unused attachment/);
    expect(text).toMatch(/showing first 5/);

    // Body should list exactly 5 attachment lines (lines beginning with "- ").
    const bulletLines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(bulletLines.length).toBe(5);
  });
});
