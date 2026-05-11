import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { parseBaseFile } from "../lib/bases.js";

/**
 * Regression coverage for the FN-cluster security findings:
 *
 *   FN-H6: parseBaseFile must not be vulnerable to YAML alias bombs.
 *          We pass the JSON_SCHEMA to js-yaml (disabling non-JSON types)
 *          and cap raw input at 1 MB before handing it to the parser, so
 *          a "billion laughs" / quadratic-blowup payload can no longer
 *          drive unbounded memory or CPU.
 *
 *   FN-H7: delete_note's elicitation capability gate previously checked
 *          caps.elicitation.form (a TypeScript-SDK extension). Clients
 *          that declare the spec-compliant `elicitation: {}` capability
 *          would skip the confirmation prompt and a permanent delete
 *          would proceed silently. The check is now against the parent
 *          key (caps.elicitation !== undefined) so any elicitation-
 *          capable client triggers the prompt.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

describe("FN-H6: parseBaseFile resists YAML alias bombs", () => {
  it("completes quickly on a 20-level alias bomb (no exponential blowup)", () => {
    // Classic "billion laughs" shape adapted for YAML: each level doubles
    // the references to the level below. With the default schema and no
    // size cap, a naive parser would materialise 2^20 references. With
    // JSON_SCHEMA + bounded input, this stays well under a 100 ms budget.
    const lines: string[] = [];
    lines.push("a0: &a0 [1, 2]");
    for (let i = 1; i <= 20; i++) {
      lines.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}]`);
    }
    lines.push("root: *a20");
    const raw = lines.join("\n");

    const start = Date.now();
    const { warnings } = parseBaseFile(raw);
    const elapsed = Date.now() - start;

    // Hard bound: should never take anywhere near 100 ms on a healthy
    // machine. We give it some slack for CI noise but the key claim is
    // "bounded", not "fast".
    expect(elapsed).toBeLessThan(1000);
    // Either the parser succeeded (no warnings) or it tripped the size
    // cap, but it must not throw and must not hang. Both branches are
    // acceptable per the fix spec.
    expect(Array.isArray(warnings)).toBe(true);
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

describe("FN-H7: delete_note elicitation gate covers spec-compliant clients", () => {
  it("source checks caps?.elicitation !== undefined (not the SDK-only .form sub-field)", async () => {
    // Text-based regression. The MCP client harness in this repo doesn't
    // let us customise the advertised client capabilities mid-test, and
    // mocking server.server.getClientCapabilities() at the SDK boundary
    // would couple this test to SDK internals. The narrow contract we
    // care about is: the gate must trigger for any client that declares
    // `elicitation: {}`, not just the SDK's `.form` extension. Asserting
    // on the source pins that contract.
    const src = await fs.readFile(
      path.join(PROJECT_ROOT, "src", "tools", "write.ts"),
      "utf-8",
    );
    expect(src).toMatch(/caps\?\.elicitation\s*!==\s*undefined/);
    // And the old, too-narrow check is gone.
    expect(src).not.toMatch(/caps\?\.elicitation\?\.form\b/);
  });
});
