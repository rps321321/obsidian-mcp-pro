import { describe, it, expect } from "vitest";
import {
  parseBaseFile,
  buildRow,
  queryBase,
  evaluateFilter,
} from "../lib/bases.js";

const noteWithFrontmatter = (data: Record<string, unknown>, body = "") => {
  const fm = Object.entries(data)
    .map(
      ([k, v]) =>
        `${k}: ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`
    )
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
    // js-yaml v5's parser is more lenient than v4: it accepts `:\n  - broken`
    // as `{ "": ["broken"] }` (empty-string key) where v4 threw. Use input
    // that is malformed under both (a mapping value that is itself a mapping
    // entry) so this still exercises the parse-error warning path.
    const { warnings } = parseBaseFile("key: value: extra\n");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("refuses YAML anchors and aliases", () => {
    const raw = [
      "shared: &shared",
      "  filters:",
      '    - file.hasTag("project")',
      "filters: *shared",
    ].join("\n");

    const { doc, warnings } = parseBaseFile(raw);
    expect(doc).toEqual({});
    expect(warnings.some((w) => /anchors or aliases/i.test(w))).toBe(true);
  });

  it("allows ampersands and stars inside scalar text", () => {
    const raw = [
      "properties:",
      "  display:",
      '    displayName: "R&D * literal"',
      'filters: [file.name.contains("A*B & C")]',
    ].join("\n");

    const { doc, warnings } = parseBaseFile(raw);
    expect(warnings).toEqual([]);
    expect(doc.properties?.display?.displayName).toBe("R&D * literal");
    expect(doc.filters).toEqual(['file.name.contains("A*B & C")']);
  });
});

describe("evaluateFilter / queryBase", () => {
  const rows = [
    buildRow(
      "a.md",
      noteWithFrontmatter({ status: "active" }, "Body #project text")
    ),
    buildRow(
      "b.md",
      noteWithFrontmatter({ status: "done" }, "Body #other text")
    ),
    buildRow(
      "c.md",
      noteWithFrontmatter({ status: "active", priority: 5 }, "#project/alpha")
    ),
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

  it("warns on unknown filter functions and treats as no-match", () => {
    const ctx = { warnings: [] };
    expect(evaluateFilter(rows[0], 'mysteryFn("x")', ctx)).toBe(false);
    expect(ctx.warnings.length).toBe(1);
  });

  it("warns on unknown filter shapes and treats as no-match", () => {
    const ctx = { warnings: [] };
    expect(evaluateFilter(rows[0], { custom: ["status"] } as never, ctx)).toBe(
      false
    );
    expect(ctx.warnings.some((w) => w.includes("Unknown filter shape"))).toBe(
      true
    );
  });

  it("fails closed when filter recursion exceeds the cap", () => {
    let filter: unknown = 'status == "active"';
    for (let i = 0; i < 70; i += 1) {
      filter = { and: [filter] };
    }

    const result = queryBase(rows, { filters: filter as never });
    expect(result.rows).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("recursion exceeded"))).toBe(
      true
    );
  });

  it("supports numeric > comparison", () => {
    const result = queryBase(rows, { filters: ["priority > 3"] });
    expect(result.rows.map((r) => r.path)).toEqual(["c.md"]);
  });

  it("supports view-level filters layered on top of base filters", () => {
    const result = queryBase(
      rows,
      {
        filters: ['status == "active"'],
        views: [
          {
            type: "table",
            name: "high-priority",
            filters: ["priority > 3"],
          },
        ],
      },
      "high-priority"
    );
    expect(result.rows.map((r) => r.path)).toEqual(["c.md"]);
  });
});
