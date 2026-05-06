import { describe, it, expect } from "vitest";
import {
  parseBaseFile,
  buildRow,
  queryBase,
  evaluateFilter,
} from "../lib/bases.js";

const noteWithFrontmatter = (data: Record<string, unknown>, body = "") => {
  const fm = Object.entries(data)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`)
    .join("\n");
  return `---\n${fm}\n---\n${body}`;
};

describe("parseBaseFile", () => {
  it("parses a YAML Base", () => {
    const raw = `filters:\n  and:\n    - taggedWith(file, "project")\nproperties:\n  status:\n    displayName: Status\n`;
    const { doc, warnings } = parseBaseFile(raw);
    expect(warnings).toEqual([]);
    expect(doc.filters).toBeDefined();
    expect(doc.properties?.status?.displayName).toBe("Status");
  });

  it("emits a warning for invalid YAML", () => {
    const { warnings } = parseBaseFile(":\n  - broken\n");
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("evaluateFilter / queryBase", () => {
  const rows = [
    buildRow("a.md", noteWithFrontmatter({ status: "active" }, "Body #project text")),
    buildRow("b.md", noteWithFrontmatter({ status: "done" }, "Body #other text")),
    buildRow("c.md", noteWithFrontmatter({ status: "active", priority: 5 }, "#project/alpha")),
  ];

  it("supports taggedWith()", () => {
    const result = queryBase(rows, {
      filters: ['taggedWith(file, "project")'],
    });
    expect(result.rows.map((r) => r.path).sort()).toEqual(["a.md", "c.md"]);
  });

  it("supports == comparison on frontmatter", () => {
    const result = queryBase(rows, { filters: ['status == "active"'] });
    expect(result.rows.map((r) => r.path).sort()).toEqual(["a.md", "c.md"]);
  });

  it("supports and combinator", () => {
    const result = queryBase(rows, {
      filters: { and: ['status == "active"', 'taggedWith(file, "project")'] },
    });
    expect(result.rows.map((r) => r.path).sort()).toEqual(["a.md", "c.md"]);
  });

  it("supports or combinator", () => {
    const result = queryBase(rows, {
      filters: { or: ['status == "done"', 'taggedWith(file, "other")'] },
    });
    expect(result.rows.map((r) => r.path)).toEqual(["b.md"]);
  });

  it("supports not combinator", () => {
    const result = queryBase(rows, { filters: { not: 'status == "done"' } });
    expect(result.rows.map((r) => r.path).sort()).toEqual(["a.md", "c.md"]);
  });

  it("warns on unknown filter functions and treats as match-all", () => {
    const ctx = { warnings: [] };
    expect(evaluateFilter(rows[0], "mysteryFn(\"x\")", ctx)).toBe(true);
    expect(ctx.warnings.length).toBe(1);
  });

  it("supports numeric > comparison", () => {
    const result = queryBase(rows, { filters: ["priority > 3"] });
    expect(result.rows.map((r) => r.path)).toEqual(["c.md"]);
  });

  it("supports view-level filters layered on top of base filters", () => {
    const result = queryBase(rows, {
      filters: ['status == "active"'],
      views: [
        {
          type: "table",
          name: "high-priority",
          filters: ["priority > 3"],
        },
      ],
    }, "high-priority");
    expect(result.rows.map((r) => r.path)).toEqual(["c.md"]);
  });
});
