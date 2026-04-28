import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { deleteNote, listNotes, moveNote, readNote, writeNote } from "../lib/vault.js";
import { planMoveRewrites, planDeleteRewrites, applyRewrites } from "../lib/link-rewriter.js";

let vaultDir: string;

beforeEach(async () => {
  vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "rewriter-test-"));
});

afterEach(async () => {
  await fs.rm(vaultDir, { recursive: true, force: true });
});

async function seed(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(vaultDir, rel)), { recursive: true });
  await fs.writeFile(path.join(vaultDir, rel), content, "utf-8");
}

describe("moveNote — wikilink rewriting", () => {
  it("preserves a basename wikilink unchanged when basename stays unambiguous", async () => {
    // `[[idea]]` is the bare basename. After moving inbox/idea.md →
    // archive/idea.md the basename is still unique, so the link doesn't need
    // to be rewritten — and the referrer's mtime is preserved.
    await seed("inbox/idea.md", "# Idea");
    await seed("projects/index.md", "See [[idea]] for details.");
    const result = await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "projects/index.md")).toBe(
      "See [[idea]] for details.",
    );
    // No actual write occurred — the rewrite was a no-op, so no entry here.
    expect(result.updatedReferrers).toEqual([]);
    expect(result.failedReferrers).toEqual([]);
  });

  it("reports referrers that actually had content rewritten", async () => {
    await seed("inbox/idea.md", "# Idea");
    await seed("projects/index.md", "See [[inbox/idea]].");
    const result = await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(result.updatedReferrers).toEqual(["projects/index.md"]);
    expect(result.failedReferrers).toEqual([]);
  });

  it("rewrites a path-form wikilink to the new path", async () => {
    await seed("inbox/idea.md", "# Idea");
    await seed("projects/index.md", "See [[inbox/idea]].");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "projects/index.md")).toBe(
      "See [[archive/idea]].",
    );
  });

  it("preserves alias on rewrite", async () => {
    await seed("inbox/idea.md", "# Idea");
    await seed("ref.md", "[[inbox/idea|the idea]]");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "ref.md")).toBe("[[archive/idea|the idea]]");
  });

  it("preserves heading fragment", async () => {
    await seed("inbox/idea.md", "# Idea\n## Detail");
    await seed("ref.md", "[[inbox/idea#Detail]]");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "ref.md")).toBe("[[archive/idea#Detail]]");
  });

  it("preserves block-id fragment", async () => {
    await seed("inbox/idea.md", "Body ^abc");
    await seed("ref.md", "[[inbox/idea#^abc]]");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "ref.md")).toBe("[[archive/idea#^abc]]");
  });

  it("preserves the embed prefix", async () => {
    await seed("inbox/idea.md", "body");
    await seed("ref.md", "before ![[inbox/idea]] after");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "ref.md")).toBe("before ![[archive/idea]] after");
  });

  it("rewrites markdown link with .md extension", async () => {
    await seed("inbox/idea.md", "x");
    await seed("ref.md", "[link](inbox/idea.md) here");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "ref.md")).toBe("[link](archive/idea.md) here");
  });

  it("rewrites markdown link without extension and preserves fragment", async () => {
    await seed("inbox/idea.md", "x");
    await seed("ref.md", "[link](inbox/idea#Section)");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "ref.md")).toBe("[link](archive/idea#Section)");
  });

  it("does not rewrite external URLs that happen to contain a similar path", async () => {
    await seed("inbox/idea.md", "x");
    await seed("ref.md", "[a](https://example.com/inbox/idea.md)");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "ref.md")).toBe(
      "[a](https://example.com/inbox/idea.md)",
    );
  });

  it("does not rewrite wikilinks inside fenced code blocks", async () => {
    await seed("inbox/idea.md", "x");
    const body = ["normal [[inbox/idea]]", "```", "[[inbox/idea]]", "```"].join("\n");
    await seed("ref.md", body);
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    const out = await readNote(vaultDir, "ref.md");
    expect(out).toContain("normal [[archive/idea]]");
    expect(out).toContain("```\n[[inbox/idea]]\n```");
  });

  it("does not touch files that don't reference the moved note", async () => {
    await seed("a.md", "# A");
    await seed("b.md", "[[a]]");
    await seed("c.md", "unrelated content");
    const before = (await fs.stat(path.join(vaultDir, "c.md"))).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    const result = await moveNote(vaultDir, "a.md", "moved.md");
    const after = (await fs.stat(path.join(vaultDir, "c.md"))).mtimeMs;
    expect(after).toBe(before);
    expect(result.updatedReferrers).toEqual(["b.md"]);
  });

  it("self-reference inside the moved file is not touched", async () => {
    await seed("idea.md", "I am [[idea]] myself");
    await moveNote(vaultDir, "idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "archive/idea.md")).toBe(
      "I am [[idea]] myself",
    );
  });

  it("falls back to path form when post-move basename collides", async () => {
    await seed("inbox/idea.md", "moving");
    await seed("projects/idea.md", "different note same name");
    await seed("ref.md", "[[inbox/idea]]");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    // Two `idea.md` exist post-move (projects + archive). Bare basename would
    // be ambiguous, so the rewrite must use the path form.
    expect(await readNote(vaultDir, "ref.md")).toBe("[[archive/idea]]");
  });

  it("preserves bare-basename form when still unambiguous post-move", async () => {
    await seed("inbox/idea.md", "x");
    await seed("ref.md", "[[idea]]");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "ref.md")).toBe("[[idea]]");
  });

  it("does not rewrite links that resolved to a different basename match", async () => {
    // `[[idea]]` from `projects/index.md` resolves to `projects/idea.md` by
    // proximity, NOT to `inbox/idea.md`. Moving `inbox/idea.md` must leave
    // that link alone.
    await seed("inbox/idea.md", "moving");
    await seed("projects/idea.md", "stays put");
    await seed("projects/index.md", "[[idea]]");
    await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    expect(await readNote(vaultDir, "projects/index.md")).toBe("[[idea]]");
  });

  it("updateLinks: false skips the rewrite pass entirely", async () => {
    await seed("inbox/idea.md", "x");
    await seed("ref.md", "[[inbox/idea]]");
    const result = await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md", {
      updateLinks: false,
    });
    expect(await readNote(vaultDir, "ref.md")).toBe("[[inbox/idea]]");
    expect(result.updatedReferrers).toEqual([]);
  });

  it("rewrites canvas nodes[].file references", async () => {
    await seed("inbox/idea.md", "x");
    const canvas = {
      nodes: [
        {
          id: "n1",
          type: "file",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          file: "inbox/idea.md",
        },
        {
          id: "n2",
          type: "text",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          text: "hello",
        },
      ],
      edges: [],
    };
    await seed("board.canvas", JSON.stringify(canvas, null, 2));
    const result = await moveNote(vaultDir, "inbox/idea.md", "archive/idea.md");
    const updated = JSON.parse(
      await fs.readFile(path.join(vaultDir, "board.canvas"), "utf-8"),
    );
    expect(updated.nodes[0].file).toBe("archive/idea.md");
    expect(updated.nodes[1].text).toBe("hello");
    expect(result.updatedReferrers).toContain("board.canvas");
  });

  it("rewrites multiple links in a single line", async () => {
    await seed("a.md", "");
    await seed("ref.md", "[[a]] and [[a|x]] and [[a#h]] all on one line");
    await moveNote(vaultDir, "a.md", "moved.md");
    expect(await readNote(vaultDir, "ref.md")).toBe(
      "[[moved]] and [[moved|x]] and [[moved#h]] all on one line",
    );
  });

  it("returns empty arrays when nothing references the moved file", async () => {
    await seed("orphan.md", "alone");
    const result = await moveNote(vaultDir, "orphan.md", "archive/orphan.md");
    expect(result.updatedReferrers).toEqual([]);
    expect(result.failedReferrers).toEqual([]);
  });

  it("respects the existing per-destination existence check", async () => {
    await seed("a.md", "");
    await seed("b.md", "");
    await seed("ref.md", "[[a]]");
    await expect(moveNote(vaultDir, "a.md", "b.md")).rejects.toThrow(
      "Destination already exists",
    );
    // No referrer should have been mutated since the rename failed.
    expect(await readNote(vaultDir, "ref.md")).toBe("[[a]]");
  });

  it("integration: vault-wide reorganization with mixed reference styles", async () => {
    await seed("topic.md", "# Topic\n\n## Detail ^anchor");
    await seed(
      "summary.md",
      [
        "Wikilink: [[topic]].",
        "Path: [[old/topic]].",
        "Alias: [[topic|the topic]].",
        "Heading: [[topic#Detail]].",
        "Block: [[topic#^anchor]].",
        "Embed: ![[topic]].",
        "MD: [link](topic.md).",
        "MD path: [link](topic).",
      ].join("\n"),
    );
    await writeNote(vaultDir, "old/topic.md", "alias resolution probe");
    // The above seeds two notes both basename-`topic`. Move the root one;
    // every basename reference in summary.md was resolving to it (closer to
    // root via the proximity tie-break), so they should all rewrite — falling
    // back to path form because basename is now ambiguous.
    await moveNote(vaultDir, "topic.md", "archive/topic.md");
    const out = await readNote(vaultDir, "summary.md");
    expect(out).toContain("[[archive/topic]]");
    expect(out).toContain("[[archive/topic|the topic]]");
    expect(out).toContain("[[archive/topic#Detail]]");
    expect(out).toContain("[[archive/topic#^anchor]]");
    expect(out).toContain("![[archive/topic]]");
    expect(out).toContain("[link](archive/topic.md)");
    expect(out).toContain("[link](archive/topic)");
  });
});

describe("applyRewrites — TOCTOU safety", () => {
  it("aborts a referrer rewrite when bytes shift between plan and apply", async () => {
    // Race: plan is built against `ref.md` v1, then a parallel `write_note`
    // prepends a paragraph and shifts every wikilink offset before
    // `applyRewrites` runs. Bounds-only validation would still pass and we'd
    // splice the wrong bytes; the `expected` check catches it.
    await seed("inbox/idea.md", "# Idea");
    await seed("ref.md", "See [[inbox/idea]] please.");

    const preMoveNotes = await listNotes(vaultDir);
    const plan = await planMoveRewrites(
      vaultDir,
      "inbox/idea.md",
      "archive/idea.md",
      preMoveNotes,
    );

    const racedContent =
      "Inserted paragraph that shifts everything.\n\nSee [[inbox/idea]] please.";
    await fs.writeFile(path.join(vaultDir, "ref.md"), racedContent, "utf-8");

    const result = await applyRewrites(vaultDir, plan);

    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([
      { path: "ref.md", error: "content changed during move; references not updated" },
    ]);

    // Crucially: ref.md was not corrupted by a misaligned splice.
    const finalContent = await fs.readFile(path.join(vaultDir, "ref.md"), "utf-8");
    expect(finalContent).toBe(racedContent);
  });

  it("aborts when bytes at the same offsets changed in place (no length shift)", async () => {
    // Subtle case: a parallel edit replaces the wikilink with a different
    // wikilink of identical length. Bounds still pass, but the `expected`
    // slice now mismatches — apply must refuse.
    await seed("inbox/idea.md", "# Idea");
    await seed("ref.md", "See [[inbox/idea]] now.");

    const preMoveNotes = await listNotes(vaultDir);
    const plan = await planMoveRewrites(
      vaultDir,
      "inbox/idea.md",
      "archive/idea.md",
      preMoveNotes,
    );

    // Same byte length as `[[inbox/idea]]` (14), keeps every offset intact.
    const racedContent = "See [[other/note]] now.";
    expect(racedContent.length).toBe("See [[inbox/idea]] now.".length);
    await fs.writeFile(path.join(vaultDir, "ref.md"), racedContent, "utf-8");

    const result = await applyRewrites(vaultDir, plan);

    expect(result.updated).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].path).toBe("ref.md");
    const finalContent = await fs.readFile(path.join(vaultDir, "ref.md"), "utf-8");
    expect(finalContent).toBe(racedContent);
  });

  it("succeeds when the referrer is unchanged between plan and apply", async () => {
    // Positive control: with no concurrent modification, the plan applies
    // cleanly — confirming `expected` doesn't reject the happy path.
    await seed("inbox/idea.md", "# Idea");
    await seed("ref.md", "See [[inbox/idea]] please.");

    const preMoveNotes = await listNotes(vaultDir);
    const plan = await planMoveRewrites(
      vaultDir,
      "inbox/idea.md",
      "archive/idea.md",
      preMoveNotes,
    );

    const result = await applyRewrites(vaultDir, plan);

    expect(result.failed).toEqual([]);
    expect(result.updated).toEqual(["ref.md"]);
    expect(await readNote(vaultDir, "ref.md")).toBe("See [[archive/idea]] please.");
  });
});

describe("moveNote — concurrent serialization", () => {
  it("two parallel moves on disjoint files both land cleanly", async () => {
    // Without vault-level locking, two move_note calls plan against the
    // same pre-move snapshot, then race on writing referrer.md (which
    // contains links to both moved files). With the vault lock, they
    // serialize: first move applies, second move plans against the
    // already-rewritten referrer.md and produces a correct second edit.
    await seed("a.md", "# A");
    await seed("b.md", "# B");
    await seed("ref.md", "Links: [[a]] and [[b]].");

    // Trigger a basename collision so the rewrite has to use path form,
    // forcing an actual edit rather than a no-op.
    await seed("archive/a.md", "# also-A");
    await seed("archive/b.md", "# also-B");

    const [r1, r2] = await Promise.all([
      moveNote(vaultDir, "a.md", "moved/a.md"),
      moveNote(vaultDir, "b.md", "moved/b.md"),
    ]);

    // Both moves succeed and both rewrites land in ref.md.
    expect(r1.failedReferrers).toEqual([]);
    expect(r2.failedReferrers).toEqual([]);
    const final = await readNote(vaultDir, "ref.md");
    expect(final).toContain("[[moved/a]]");
    expect(final).toContain("[[moved/b]]");
    // Neither old reference survived.
    expect(final).not.toMatch(/\[\[a\]\]/);
    expect(final).not.toMatch(/\[\[b\]\]/);
  });

  it("updateLinks: false skips the vault lock so concurrent renames don't serialize", async () => {
    // Smoke test that the rename-only path still works under parallel load.
    // Without referrer rewriting there's no need to serialize, and the
    // existing per-file locks suffice.
    await seed("x.md", "# X");
    await seed("y.md", "# Y");
    await Promise.all([
      moveNote(vaultDir, "x.md", "renamed-x.md", { updateLinks: false }),
      moveNote(vaultDir, "y.md", "renamed-y.md", { updateLinks: false }),
    ]);
    await expect(fs.access(path.join(vaultDir, "renamed-x.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(vaultDir, "renamed-y.md"))).resolves.toBeUndefined();
  });
});

describe("planDeleteRewrites", () => {
  it("strips a bare wikilink to the deleted file's basename", async () => {
    await seed("inbox/idea.md", "# Idea");
    await seed("ref.md", "See [[inbox/idea]] for context.");

    const preDeleteNotes = await listNotes(vaultDir);
    const plan = await planDeleteRewrites(vaultDir, "inbox/idea.md", preDeleteNotes);
    const result = await applyRewrites(vaultDir, plan);

    expect(result.failed).toEqual([]);
    expect(result.updated).toEqual(["ref.md"]);
    expect(await readNote(vaultDir, "ref.md")).toBe("See idea for context.");
  });

  it("strips an aliased wikilink to its alias", async () => {
    await seed("notes/old.md", "# Old");
    await seed("ref.md", "Read [[notes/old|the old version]] later.");

    const preDeleteNotes = await listNotes(vaultDir);
    const plan = await planDeleteRewrites(vaultDir, "notes/old.md", preDeleteNotes);
    const result = await applyRewrites(vaultDir, plan);

    expect(result.updated).toEqual(["ref.md"]);
    expect(await readNote(vaultDir, "ref.md")).toBe("Read the old version later.");
  });

  it("drops a fragment when the target is gone", async () => {
    await seed("doc.md", "# Doc\n## Methods");
    await seed("ref.md", "See [[doc#Methods]].");

    const preDeleteNotes = await listNotes(vaultDir);
    const plan = await planDeleteRewrites(vaultDir, "doc.md", preDeleteNotes);
    const result = await applyRewrites(vaultDir, plan);

    expect(result.updated).toEqual(["ref.md"]);
    expect(await readNote(vaultDir, "ref.md")).toBe("See doc.");
  });

  it("removes an embed entirely (no fallback text)", async () => {
    await seed("snippet.md", "# Snippet body");
    await seed("ref.md", "Before. ![[snippet]] After.");

    const preDeleteNotes = await listNotes(vaultDir);
    const plan = await planDeleteRewrites(vaultDir, "snippet.md", preDeleteNotes);
    const result = await applyRewrites(vaultDir, plan);

    expect(result.updated).toEqual(["ref.md"]);
    expect(await readNote(vaultDir, "ref.md")).toBe("Before.  After.");
  });

  it("strips a markdown link to its visible text", async () => {
    await seed("notes/topic.md", "# Topic");
    await seed("ref.md", "Read [the topic](notes/topic.md) carefully.");

    const preDeleteNotes = await listNotes(vaultDir);
    const plan = await planDeleteRewrites(vaultDir, "notes/topic.md", preDeleteNotes);
    const result = await applyRewrites(vaultDir, plan);

    expect(result.updated).toEqual(["ref.md"]);
    expect(await readNote(vaultDir, "ref.md")).toBe("Read the topic carefully.");
  });

  it("does not touch references in unrelated files", async () => {
    await seed("a.md", "# A");
    await seed("b.md", "# B");
    await seed("ref.md", "[[a]] and [[b]]");

    const preDeleteNotes = await listNotes(vaultDir);
    const plan = await planDeleteRewrites(vaultDir, "a.md", preDeleteNotes);
    const result = await applyRewrites(vaultDir, plan);

    expect(result.updated).toEqual(["ref.md"]);
    // [[b]] survives — only [[a]] was stripped.
    expect(await readNote(vaultDir, "ref.md")).toBe("a and [[b]]");
  });

  it("skips edits inside the file being deleted itself", async () => {
    // The deleted file is about to disappear, so editing its content is
    // wasted work. The plan must not include it as a referrer.
    await seed("self.md", "I link to [[self]] and [[other]]");
    await seed("other.md", "# Other");

    const preDeleteNotes = await listNotes(vaultDir);
    const plan = await planDeleteRewrites(vaultDir, "self.md", preDeleteNotes);

    expect(plan.notes.has("self.md")).toBe(false);
  });
});

describe("deleteNote — removeReferences integration", () => {
  it("does NOT strip references when permanent: false (trash mode)", async () => {
    // Trashed files are recoverable, so references must stay intact.
    await seed("recoverable.md", "# Will be trashed");
    await seed("ref.md", "Read [[recoverable]].");

    const result = await deleteNote(vaultDir, "recoverable.md", {
      permanent: false,
      removeReferences: true, // ignored when not permanent
    });

    expect(result.updatedReferrers).toEqual([]);
    expect(await readNote(vaultDir, "ref.md")).toBe("Read [[recoverable]].");
  });

  it("does NOT strip references when removeReferences is omitted", async () => {
    await seed("doomed.md", "# Will be deleted");
    await seed("ref.md", "Read [[doomed]].");

    const result = await deleteNote(vaultDir, "doomed.md", { permanent: true });

    expect(result.updatedReferrers).toEqual([]);
    expect(await readNote(vaultDir, "ref.md")).toBe("Read [[doomed]].");
  });

  it("strips references end-to-end when permanent + removeReferences", async () => {
    await seed("doomed.md", "# Will be deleted");
    await seed("ref.md", "Before. [[doomed|the doomed note]] After.");

    const result = await deleteNote(vaultDir, "doomed.md", {
      permanent: true,
      removeReferences: true,
    });

    expect(result.updatedReferrers).toEqual(["ref.md"]);
    expect(await readNote(vaultDir, "ref.md")).toBe("Before. the doomed note After.");
    // File actually gone (not in .trash either).
    await expect(fs.access(path.join(vaultDir, "doomed.md"))).rejects.toThrow();
    await expect(
      fs.access(path.join(vaultDir, ".trash", "doomed.md")),
    ).rejects.toThrow();
  });
});
