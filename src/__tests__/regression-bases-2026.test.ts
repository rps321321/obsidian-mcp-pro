import { describe, it, expect } from "vitest";
import {
  buildRow,
  queryBase,
  evaluateFilter,
  parseBaseFile,
} from "../lib/bases.js";

/**
 * Regression coverage for the 2026 Bases parser rewrite:
 *
 *   - O1: chained-method syntax (`file.name.contains("x")`, `file.hasTag("x")`)
 *   - O2: extended file.* property surface (basename, folder, ext, etc.)
 *   - O3: file.hasProperty() and file.linksTo() methods
 *   - C4: ReDoS hardening on FUNC_RE / COMPARISON_RE
 *
 * Backward compat with src/__tests__/bases.test.ts is verified by that file
 * continuing to pass; the cases here intentionally don't duplicate it.
 */

const noteWithFrontmatter = (data: Record<string, unknown>, body = "") => {
  const fm = Object.entries(data)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`)
    .join("\n");
  return `---\n${fm}\n---\n${body}`;
};

describe("O1: chained-method filter syntax", () => {
  it("file.name.contains() matches by basename substring", () => {
    const rows = [
      buildRow("notes/Project 2026 plan.md", noteWithFrontmatter({})),
      buildRow("notes/Project 2025 plan.md", noteWithFrontmatter({})),
      buildRow("notes/random.md", noteWithFrontmatter({})),
    ];
    const result = queryBase(rows, { filters: ['file.name.contains("2026")'] });
    expect(result.rows.map((r) => r.path)).toEqual(["notes/Project 2026 plan.md"]);
  });

  it("file.hasTag() matches a note tagged #project", () => {
    const rows = [
      buildRow("a.md", noteWithFrontmatter({}, "Body #project text")),
      buildRow("b.md", noteWithFrontmatter({}, "Body #other text")),
      buildRow("c.md", noteWithFrontmatter({}, "#project/alpha")),
    ];
    const result = queryBase(rows, { filters: ['file.hasTag("project")'] });
    expect(result.rows.map((r) => r.path).sort()).toEqual(["a.md", "c.md"]);
  });

  it("file.name.startsWith() / .endsWith() work as expected", () => {
    const rows = [
      buildRow("foo-bar.md", noteWithFrontmatter({})),
      buildRow("bar-foo.md", noteWithFrontmatter({})),
    ];
    expect(
      queryBase(rows, { filters: ['file.name.startsWith("foo")'] }).rows.map((r) => r.path),
    ).toEqual(["foo-bar.md"]);
    expect(
      queryBase(rows, { filters: ['file.name.endsWith("foo.md")'] }).rows.map((r) => r.path),
    ).toEqual(["bar-foo.md"]);
  });

  it("isNotEmpty on a frontmatter key filters out blank entries", () => {
    const rows = [
      buildRow("a.md", noteWithFrontmatter({ status: "active" })),
      buildRow("b.md", noteWithFrontmatter({})),
    ];
    const result = queryBase(rows, { filters: ["status.isNotEmpty()"] });
    expect(result.rows.map((r) => r.path)).toEqual(["a.md"]);
  });
});

describe("O2: extended file.* properties", () => {
  it("file.basename returns the name without the extension", () => {
    const rows = [
      buildRow("folder/my-note.md", noteWithFrontmatter({})),
    ];
    const result = queryBase(rows, {
      filters: ['file.basename == "my-note"'],
    });
    expect(result.rows).toHaveLength(1);
  });

  it("file.folder returns the parent folder", () => {
    const rows = [
      buildRow("Projects/alpha.md", noteWithFrontmatter({})),
      buildRow("Archive/beta.md", noteWithFrontmatter({})),
    ];
    const result = queryBase(rows, { filters: ['file.folder == "Projects"'] });
    expect(result.rows.map((r) => r.path)).toEqual(["Projects/alpha.md"]);
  });

  it("file.ext exposes the file extension", () => {
    const rows = [
      buildRow("notes/a.md", noteWithFrontmatter({})),
    ];
    const result = queryBase(rows, { filters: ['file.ext == "md"'] });
    expect(result.rows).toHaveLength(1);
  });

  it("file.size/ctime/mtime come from the optional stats arg", () => {
    const row = buildRow("a.md", noteWithFrontmatter({}), {
      size: 1024,
      ctime: 1_700_000_000_000,
      mtime: 1_800_000_000_000,
    });
    const result = queryBase([row], { filters: ["file.size > 500"] });
    expect(result.rows).toHaveLength(1);
    const mtimeResult = queryBase([row], { filters: ["file.mtime > 1700000000000"] });
    expect(mtimeResult.rows).toHaveLength(1);
  });

  it("filters on unpopulated optional fields fail closed with a warning", () => {
    const row = buildRow("a.md", noteWithFrontmatter({}));
    const result = queryBase([row], { filters: ['file.linksTo("Other")'] });
    expect(result.rows).toHaveLength(0);
    expect(result.warnings.some((w) => w.toLowerCase().includes("links"))).toBe(true);
  });
});

describe("O3: file.hasProperty() and file.linksTo()", () => {
  it("file.hasProperty matches notes with that frontmatter key", () => {
    const rows = [
      buildRow("a.md", noteWithFrontmatter({ status: "active" })),
      buildRow("b.md", noteWithFrontmatter({ priority: 1 })),
    ];
    const result = queryBase(rows, { filters: ['file.hasProperty("status")'] });
    expect(result.rows.map((r) => r.path)).toEqual(["a.md"]);
  });

  it("file.linksTo matches when the target appears in row.links", () => {
    const row = buildRow("a.md", noteWithFrontmatter({}));
    row.links = ["Project Plan", "Archive/Old"];
    const result = queryBase([row], { filters: ['file.linksTo("Project Plan")'] });
    expect(result.rows).toHaveLength(1);

    const noMatch = queryBase([row], { filters: ['file.linksTo("Other")'] });
    expect(noMatch.rows).toHaveLength(0);
  });

  it("file.linksTo keeps path targets from falling back to basename-only matches", () => {
    const archiveRow = buildRow("archive-source.md", noteWithFrontmatter({}));
    archiveRow.links = ["archive/idea"];
    const projectRow = buildRow("project-source.md", noteWithFrontmatter({}));
    projectRow.links = ["projects/idea"];

    const result = queryBase([archiveRow, projectRow], {
      filters: ['file.linksTo("projects/idea")'],
    });

    expect(result.rows.map((r) => r.path)).toEqual(["project-source.md"]);
  });

  it("file.hasLink ignores heading fragments when matching linked files", () => {
    const row = buildRow("a.md", noteWithFrontmatter({}));
    row.links = ["projects/idea#Heading"];

    const result = queryBase([row], { filters: ['file.hasLink("projects/idea")'] });

    expect(result.rows.map((r) => r.path)).toEqual(["a.md"]);
  });
});

describe("C4: ReDoS hardening", () => {
  it("parses a 1000-arg function expression in <100ms", () => {
    const long = "a".repeat(1000);
    const expr = `f(${long})`;
    const start = performance.now();
    // The unknown function still evaluates (and warns), but the parser must
    // terminate promptly regardless of input length.
    evaluateFilter(buildRow("x.md", ""), expr, { warnings: [] });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("rejects pathological comparison inputs quickly", () => {
    // Long unbroken token on either side of the operator; would have blown up
    // the old `(.+?) op (.+?)` lazy regex on backtrack.
    const long = "x".repeat(2000);
    const expr = `${long} == "${long}"`;
    const start = performance.now();
    evaluateFilter(buildRow("x.md", ""), expr, { warnings: [] });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

describe("Backward compat: existing parseBaseFile/queryBase behaviors", () => {
  it("still parses the canonical YAML example", () => {
    const raw = `filters:\n  and:\n    - file.hasTag("project")\nproperties:\n  status:\n    displayName: Status\n`;
    const { doc, warnings } = parseBaseFile(raw);
    expect(warnings).toEqual([]);
    expect(doc.filters).toBeDefined();
  });

  it("still honors taggedWith(file, \"x\") legacy form", () => {
    const rows = [
      buildRow("a.md", noteWithFrontmatter({}, "#project")),
      buildRow("b.md", noteWithFrontmatter({}, "#other")),
    ];
    const result = queryBase(rows, { filters: ['taggedWith(file, "project")'] });
    expect(result.rows.map((r) => r.path)).toEqual(["a.md"]);
  });
});
