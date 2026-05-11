import { describe, it, expect } from "vitest";
import {
  rewriteInlineTags,
  rewriteFrontmatterTags,
  rewriteAllTags,
} from "../lib/tag-rewriter.js";

const opts = (oldName: string, newName: string, hierarchical = true) => ({
  oldName,
  newName,
  hierarchical,
});

describe("regression: rewriteAllTags idempotence (H3)", () => {
  it("is byte-identical when applied twice to the same content", () => {
    const input =
      "---\ntags: [project]\n---\nA #project tag with body text.\n";
    const once = rewriteAllTags(input, opts("project", "client")).content;
    const twice = rewriteAllTags(once, opts("project", "client")).content;
    expect(twice).toBe(once);
  });

  it("does not accumulate blank lines after 5 successive runs", () => {
    const input =
      "---\ntags: [project]\nauthor: someone\n---\nBody #project line.\nMore text.\n";
    let cur = rewriteAllTags(input, opts("project", "client")).content;
    const firstPass = cur;
    for (let i = 0; i < 4; i++) {
      cur = rewriteAllTags(cur, opts("project", "client")).content;
    }
    expect(cur).toBe(firstPass);
    // Sanity: no run of three+ consecutive newlines between fence and body.
    expect(cur).not.toMatch(/---\n\n\n/);
  });

  it("preserves a single blank line between frontmatter and body across runs", () => {
    const input =
      "---\ntags: [project]\n---\n\nBody #project text.\n";
    let cur = input;
    for (let i = 0; i < 5; i++) {
      cur = rewriteAllTags(cur, opts("project", "client")).content;
    }
    // Should not have grown to 3+ blank lines.
    expect(cur).not.toMatch(/---\n\n\n+/);
  });

  it("frontmatterCount is reported correctly on second run when nothing changes", () => {
    const input = "---\ntags: [project]\n---\n#project body\n";
    const first = rewriteAllTags(input, opts("project", "client"));
    expect(first.frontmatterCount).toBe(1);
    expect(first.inlineCount).toBe(1);
    const second = rewriteAllTags(first.content, opts("project", "client"));
    expect(second.frontmatterCount).toBe(0);
    expect(second.inlineCount).toBe(0);
    expect(second.content).toBe(first.content);
  });
});

describe("regression: INLINE_TAG_RE state (H8)", () => {
  it("works correctly after processing a long body line followed by a short call", () => {
    // Long line with several tags - exercises regex /g lastIndex advance.
    const longLine =
      "lorem ipsum #project alpha bravo charlie #project/beta delta #project echo "
        .repeat(5) + "tail";
    const first = rewriteInlineTags(longLine, opts("project", "client"));
    expect(first.body).not.toContain("#project ");
    expect(first.body).not.toContain("#project/");
    // Now a tiny call - if a module-level /g regex retained lastIndex,
    // it could miss this match. With a per-call regex it must not.
    const tiny = rewriteInlineTags("#project", opts("project", "client"));
    expect(tiny.body).toBe("#client");
    expect(tiny.count).toBe(1);
  });

  it("repeatedly handles short single-tag calls without skipping", () => {
    for (let i = 0; i < 10; i++) {
      const r = rewriteInlineTags("#project", opts("project", "client"));
      expect(r.body).toBe("#client");
      expect(r.count).toBe(1);
    }
  });
});

describe("regression: array-branch dirty flag isolation (H9)", () => {
  it("leaves the Tags key unchanged when only tags has a renamable entry", () => {
    const input =
      "---\ntags:\n  - project\n  - shared\nTags:\n  - other\n  - shared\n---\nbody\n";
    const { content, count } = rewriteFrontmatterTags(
      input,
      opts("project", "client"),
    );
    expect(count).toBe(1);
    // tags array should contain client now
    expect(content).toMatch(/tags:\s*\n\s+- client/);
    // Tags array must still contain "other" (unchanged) - the previous
    // bug would have overwritten Tags with an unchanged copy of itself,
    // but more importantly the dirty flag should not promote spurious
    // writes. Assert structural equivalence of the Tags block.
    expect(content).toMatch(/Tags:\s*\n\s+- other\s*\n\s+- shared/);
  });

  it("does not promote a no-op array assignment from a prior key", () => {
    // tags has no rename, Tags has a rename. The pre-fix bug would set
    // data.tags = next even though `dirty` was only true for Tags
    // (because the array branch reused outer `dirty`). With the fix,
    // tags is left untouched.
    const input =
      "---\ntags:\n  - foo\n  - bar\nTags:\n  - project\n---\nbody\n";
    const { content, count } = rewriteFrontmatterTags(
      input,
      opts("project", "client"),
    );
    expect(count).toBe(1);
    // tags should still list foo and bar in order.
    expect(content).toMatch(/tags:\s*\n\s+- foo\s*\n\s+- bar/);
    // Tags should now list client.
    expect(content).toMatch(/Tags:\s*\n\s+- client/);
  });
});

describe("regression: fenced close regex reuse (M15)", () => {
  it("rewrites a note with a large fenced code block in well under 50ms", () => {
    const fenceBody = Array.from({ length: 1000 }, (_, i) => `line ${i} #project`).join(
      "\n",
    );
    const input = `Header text #project\n\n\`\`\`\n${fenceBody}\n\`\`\`\n\nFooter #project\n`;
    const start = performance.now();
    const result = rewriteAllTags(input, opts("project", "client"));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    // Inside the fence: #project must NOT be rewritten.
    expect(result.content).toContain("line 0 #project");
    expect(result.content).toContain("line 999 #project");
    // Outside the fence: must be rewritten.
    expect(result.content).toContain("Header text #client");
    expect(result.content).toContain("Footer #client");
    expect(result.inlineCount).toBe(2);
  });

  it("correctly closes a fence with matching delimiter after many interior lines", () => {
    // Open with ~~~~ (4 tildes), include 100 lines, close with ~~~~.
    const body = Array.from({ length: 100 }, () => "#project inside").join("\n");
    const input = `outside #project\n~~~~\n${body}\n~~~~\nafter #project\n`;
    const result = rewriteInlineTags(input, opts("project", "client"));
    // Outside replaced, inside untouched.
    expect(result.body.startsWith("outside #client")).toBe(true);
    expect(result.body).toContain("after #client");
    expect(result.body).toContain("#project inside");
    expect(result.count).toBe(2);
  });
});
