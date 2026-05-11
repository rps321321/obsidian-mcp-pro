/**
 * Regression suite covering two narrow bugs that surfaced during audit:
 *
 * 1. `updateFence` in sections.ts trimmed leading whitespace before testing the
 *    close-fence regex, which made a 4-space-indented run of backticks (an
 *    indented-code line per CommonMark, not a fence) prematurely terminate the
 *    fence. That mis-set section / heading bounds for notes whose fenced code
 *    block happened to contain an indented ` ``` ` line.
 *
 * 2. `updateFrontmatter` in markdown.ts relied on gray-matter / js-yaml's
 *    default emitter, which leaves wikilink values unquoted. Obsidian's
 *    Properties editor then renders `link: [[Episode IV]]` as raw text instead
 *    of a link, and some YAML parsers misread the bare `[[` as a malformed
 *    flow sequence.
 */
import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  updateFrontmatter,
  quoteWikilinksInFrontmatter,
} from "../lib/markdown.js";
import { findSection, parseHeadings } from "../lib/sections.js";

// ---------------------------------------------------------------------------
// O5: frontmatter wikilink quoting
// ---------------------------------------------------------------------------
describe("updateFrontmatter wikilink quoting", () => {
  it("quotes a scalar wikilink value", () => {
    const out = updateFrontmatter("body\n", { link: "[[Episode IV]]" });
    // The frontmatter line for `link` must be quoted.
    expect(out).toMatch(/^link: "\[\[Episode IV\]\]"$/m);
    // And the body must survive untouched.
    expect(out).toMatch(/\nbody\n?$/);
  });

  it("quotes every item of a wikilink array", () => {
    const out = updateFrontmatter("body\n", { links: ["[[A]]", "[[B]]"] });
    expect(out).toMatch(/^  - "\[\[A\]\]"$/m);
    expect(out).toMatch(/^  - "\[\[B\]\]"$/m);
    // Sanity: the bare unquoted forms must NOT appear in the frontmatter.
    const fm = out.slice(0, out.indexOf("\n---", 4));
    expect(fm).not.toMatch(/^  - \[\[A\]\]$/m);
    expect(fm).not.toMatch(/^  - \[\[B\]\]$/m);
  });

  it("round-trips: quoted output parses back to the original wikilink string", () => {
    const out = updateFrontmatter("body\n", { link: "[[Episode IV]]" });
    const parsed = parseFrontmatter(out);
    expect(parsed.data.link).toBe("[[Episode IV]]");
  });

  it("round-trips a list of wikilinks back to a JS array of strings", () => {
    const out = updateFrontmatter("body\n", { links: ["[[A]]", "[[B]]"] });
    const parsed = parseFrontmatter(out);
    expect(parsed.data.links).toEqual(["[[A]]", "[[B]]"]);
  });

  it("leaves non-wikilink scalar values unchanged", () => {
    const out = updateFrontmatter("body\n", { title: "Hello", count: 3 });
    expect(out).toMatch(/^title: Hello$/m);
    expect(out).toMatch(/^count: 3$/m);
  });

  it("preserves merge with existing frontmatter and quotes new wikilink", () => {
    const original = "---\ntitle: Old\n---\nbody\n";
    const out = updateFrontmatter(original, { link: "[[Foo]]" });
    expect(out).toMatch(/^title: Old$/m);
    expect(out).toMatch(/^link: "\[\[Foo\]\]"$/m);
  });

  it("quoteWikilinksInFrontmatter is exported and idempotent", () => {
    const once = quoteWikilinksInFrontmatter('link: [[Foo]]\n');
    expect(once).toBe('link: "[[Foo]]"\n');
    // Already-quoted lines are left alone (no double-quoting).
    expect(quoteWikilinksInFrontmatter(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// Audit #16/23: indented closing fence is not a fence per CommonMark
// ---------------------------------------------------------------------------
describe("section parsing with deeply-indented fence-like lines", () => {
  // A fenced block whose body contains a 4-space-indented run of backticks.
  // Per CommonMark 4.5, that line is part of the code content, NOT a closing
  // fence. Anything *after* the real closing fence is markdown again, so the
  // `## After` heading must be visible to parseHeadings.
  const note = [
    "# Top",
    "Body before fence.",
    "",
    "```",
    "code line 1",
    "    ```", // 4-space-indented backticks: NOT a closing fence.
    "still inside the fence",
    "# Not a heading",
    "```", // The real closing fence.
    "",
    "## After",
    "Tail.",
    "",
  ].join("\n");

  it("findSection on Top stays inside the fence and extends to next sibling/end", () => {
    const sec = findSection(note, ["Top"]);
    expect(sec).not.toBeNull();
    if (!sec) throw new Error("unreachable");
    // The body of `# Top` should include the indented backticks and the
    // `# Not a heading` line — they are inside a fenced code block, so they
    // do NOT terminate the section.
    const body = note.slice(sec.bodyStart, sec.end);
    expect(body).toContain("    ```");
    expect(body).toContain("# Not a heading");
    // The next heading is `## After`, so the section ends right before it.
    expect(note.slice(sec.end)).toMatch(/^## After/);
  });

  it("parseHeadings sees only the real headings, skipping fenced impostors", () => {
    const heads = parseHeadings(note);
    const labels = heads.map((h) => `${h.level}:${h.text}`);
    expect(labels).toEqual(["1:Top", "2:After"]);
  });

  it("findSection on After is reachable (proves the fence was correctly closed)", () => {
    const sec = findSection(note, ["After"]);
    expect(sec).not.toBeNull();
    if (!sec) throw new Error("unreachable");
    expect(note.slice(sec.bodyStart, sec.end)).toContain("Tail.");
  });

  it("a 3-space-indented closing fence still closes (CommonMark allows 0–3)", () => {
    const c = [
      "# H",
      "```",
      "x",
      "   ```", // 3 spaces: still a valid closing fence.
      "## After",
      "",
    ].join("\n");
    const heads = parseHeadings(c);
    expect(heads.map((h) => h.text)).toEqual(["H", "After"]);
  });

  it("a 4-space-indented opening fence is not an opener", () => {
    // Here the line `    ```` is an indented code line, not a fence opener.
    // The `# Inside` line on the next row is therefore a real heading.
    const c = ["# Top", "", "    ```", "# Inside", "    ```", ""].join("\n");
    const heads = parseHeadings(c);
    expect(heads.map((h) => h.text)).toEqual(["Top", "Inside"]);
  });
});
