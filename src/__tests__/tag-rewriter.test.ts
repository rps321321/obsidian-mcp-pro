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

describe("rewriteInlineTags", () => {
  it("renames simple inline tags", () => {
    const input = "Hello #project world";
    const { body, count } = rewriteInlineTags(input, opts("project", "client"));
    expect(body).toBe("Hello #client world");
    expect(count).toBe(1);
  });

  it("renames hierarchical sub-tags when hierarchical=true", () => {
    const input = "x #project/alpha y";
    const { body, count } = rewriteInlineTags(input, opts("project", "client"));
    expect(body).toBe("x #client/alpha y");
    expect(count).toBe(1);
  });

  it("does NOT rename hierarchical sub-tags when hierarchical=false", () => {
    const input = "x #project/alpha y";
    const { body, count } = rewriteInlineTags(input, opts("project", "client", false));
    expect(body).toBe(input);
    expect(count).toBe(0);
  });

  it("skips matches inside fenced code blocks", () => {
    const input = "```\n#project\n```\n#project outside\n";
    const { body, count } = rewriteInlineTags(input, opts("project", "client"));
    expect(body).toBe("```\n#project\n```\n#client outside\n");
    expect(count).toBe(1);
  });

  it("does not touch ATX headings starting with #", () => {
    const input = "# project\n#project body\n";
    const { body, count } = rewriteInlineTags(input, opts("project", "client"));
    expect(body).toContain("# project\n");
    expect(body).toContain("#client body");
    expect(count).toBe(1);
  });

  it("skips inline-code matches", () => {
    const input = "outside #project, inside `#project` text\n";
    const { body, count } = rewriteInlineTags(input, opts("project", "client"));
    expect(body).toBe("outside #client, inside `#project` text\n");
    expect(count).toBe(1);
  });
});

describe("rewriteFrontmatterTags", () => {
  it("rewrites array-form tags", () => {
    const input = `---\ntags:\n  - project\n  - other\n---\nbody\n`;
    const { content, count } = rewriteFrontmatterTags(input, opts("project", "client"));
    expect(content).toContain("client");
    expect(content).not.toMatch(/^\s+- project$/m);
    expect(count).toBe(1);
  });

  it("rewrites comma-string form tags", () => {
    const input = `---\ntags: project, other\n---\nbody\n`;
    const { content, count } = rewriteFrontmatterTags(input, opts("project", "client"));
    expect(content).toContain("client");
    expect(count).toBe(1);
  });

  it("rewrites hierarchical sub-tags", () => {
    const input = `---\ntags:\n  - project/alpha\n  - other\n---\n`;
    const { content, count } = rewriteFrontmatterTags(input, opts("project", "client"));
    expect(content).toContain("client/alpha");
    expect(count).toBe(1);
  });

  it("returns count=0 if nothing matches", () => {
    const input = `---\ntags:\n  - foo\n---\n`;
    const { count } = rewriteFrontmatterTags(input, opts("project", "client"));
    expect(count).toBe(0);
  });
});

describe("rewriteAllTags (combined)", () => {
  it("rewrites both frontmatter and inline tags in one pass", () => {
    const input = `---\ntags: [project]\n---\nA #project tag.\n`;
    const result = rewriteAllTags(input, opts("project", "client"));
    expect(result.frontmatterCount).toBe(1);
    expect(result.inlineCount).toBe(1);
    expect(result.content).toContain("client");
    expect(result.content).toContain("#client");
    expect(result.content).not.toContain("#project");
  });
});
