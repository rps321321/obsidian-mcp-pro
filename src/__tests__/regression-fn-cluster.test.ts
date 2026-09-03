import { describe, it, expect } from "vitest";
import { parseBaseFile } from "../lib/bases.js";

/**
 * Regression coverage for the FN-cluster security findings:
 *
 *   FN-H6: parseBaseFile must not be vulnerable to YAML alias bombs.
 *          It rejects YAML anchors/aliases before js-yaml, uses JSON_SCHEMA
 *          for the remaining parse, and caps raw input at 1 MB before handing
 *          it to the parser, so a "billion laughs" / quadratic-blowup payload
 *          can no longer drive unbounded memory or CPU.
 */

describe("FN-H6: parseBaseFile resists YAML alias bombs", () => {
  it("completes quickly on a 20-level alias bomb (no exponential blowup)", () => {
    // Classic "billion laughs" shape adapted for YAML: each level doubles
    // the references to the level below. A naive parser would materialise
    // 2^20 references; this parser rejects aliases before handing the raw
    // text to js-yaml.
    const lines: string[] = [];
    lines.push("a0: &a0 [1, 2]");
    for (let i = 1; i <= 20; i++) {
      lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}]`);
    }
    lines.push("root: *a20");
    const raw = lines.join("\n");

    const start = Date.now();
    const { doc, warnings } = parseBaseFile(raw);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(doc).toEqual({});
    expect(warnings.some((w) => /anchors or aliases/i.test(w))).toBe(true);
  });

  it("rejects raw input over 1 MB with a clear warning and an empty doc", () => {
    // Pad past the 1 MB cap with benign content so we test the size
    // guard rather than YAML syntax.
    const raw = "key: value\n" + "x".repeat(1_048_577);
    const { doc, warnings } = parseBaseFile(raw);
    expect(doc).toEqual({});
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => /size cap|exceeds/i.test(w))).toBe(true);
  });

  it("still parses normal Base files after the hardening", () => {
    // Sanity check: a vanilla Base with a filter and a property block
    // must keep working under the more restrictive JSON_SCHEMA.
    const raw = `filters:\n  and:\n    - taggedWith(file, "project")\nproperties:\n  status:\n    displayName: Status\n`;
    const { doc, warnings } = parseBaseFile(raw);
    expect(warnings).toEqual([]);
    expect(doc.filters).toBeDefined();
    expect((doc.properties as { status?: { displayName?: string } })?.status?.displayName).toBe("Status");
  });
});
