import { beforeEach, afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listNotes, moveNote, readNote } from "../lib/vault.js";
import { extractWikilinkSpans, extractMarkdownLinkSpans, resolveWikilink } from "../lib/markdown.js";
import { planMoveRewrites, applyRewrites } from "../lib/link-rewriter.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "moved-links-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function seed(file: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), body);
}

it("preserves explicit self-link targets, fragments, aliases, and embeds at the destination", async () => {
  await seed("inbox/source.md", "[[inbox/source#Detail|myself]] ![[inbox/source#^block]] [[#Local]]");
  const result = await moveNote(root, "inbox/source.md", "archive/moved.md");
  const content = await readNote(root, "archive/moved.md");
  const spans = extractWikilinkSpans(content);
  const notes = await listNotes(root);
  expect(spans.slice(0, 2).map((span) => resolveWikilink(span.target, "archive/moved.md", notes)))
    .toEqual(["archive/moved.md", "archive/moved.md"]);
  expect(spans[0]).toMatchObject({ fragment: "#Detail", alias: "myself" });
  expect(spans[1]).toMatchObject({ fragment: "#^block", isEmbed: true });
  expect(content).toContain("[[#Local]]");
  expect(result.updatedReferrers).toContain("archive/moved.md");
  expect(result.failedReferrers).toEqual([]);
});

it("preserves outgoing wikilinks when duplicate basename proximity changes", async () => {
  await seed("inbox/source.md", "[[neighbor]]");
  await seed("inbox/neighbor.md", "original neighbor");
  await seed("archive/neighbor.md", "different neighbor");
  await moveNote(root, "inbox/source.md", "archive/moved.md");
  const [span] = extractWikilinkSpans(await readNote(root, "archive/moved.md"));
  expect(resolveWikilink(span!.target, "archive/moved.md", await listNotes(root))).toBe("inbox/neighbor.md");
});

it("keeps a basename self-link unchanged when it still resolves to the moved note", async () => {
  await seed("inbox/source.md", "[[source#Detail|self]]");
  const result = await moveNote(root, "inbox/source.md", "archive/source.md");
  const content = await readNote(root, "archive/source.md");
  expect(content).toBe("[[source#Detail|self]]");
  expect(resolveWikilink("source", "archive/source.md", await listNotes(root))).toBe("archive/source.md");
  expect(result.updatedReferrers).toEqual([]);
});

it("rebases relative Markdown notes and attachments without changing their targets", async () => {
  await seed("inbox/source.md", '---\naliases: [pic.png]\n---\n[neighbor](./neighbor.md#Detail "title")\n[self](./source.md#^block)\n![image](./images/pic%20one.png#view "image title")\n![bare](pic.png)');
  await seed("inbox/neighbor.md", "original neighbor");
  await seed("archive/neighbor.md", "different neighbor");
  await seed("inbox/images/pic one.png", "image bytes");
  await seed("inbox/pic.png", "bare image bytes");
  await moveNote(root, "inbox/source.md", "archive/moved.md");
  const spans = extractMarkdownLinkSpans(await readNote(root, "archive/moved.md"));
  const targets = spans.map((span) => path.posix.normalize(path.posix.join("archive", decodeURIComponent(span.urlPath))));
  expect(targets).toEqual(["inbox/neighbor.md", "archive/moved.md", "inbox/images/pic one.png", "inbox/pic.png"]);
  expect(spans[0]).toMatchObject({ fragment: "#Detail", title: ' "title"' });
  expect(spans[1]).toMatchObject({ fragment: "#^block" });
  expect(spans[2]).toMatchObject({ isEmbed: true, fragment: "#view", title: ' "image title"' });
  await expect(fs.readFile(path.join(root, targets[0]!), "utf8")).resolves.toBe("original neighbor");
  await expect(fs.readFile(path.join(root, targets[2]!), "utf8")).resolves.toBe("image bytes");
});

it("preserves external URLs, fragment-only links, root attachment paths, and code", async () => {
  const body = '[web](https://example.test/inbox/source.md) [mail](mailto:source) [root](/absolute.png) [heading](#Detail) ![asset](assets/pic.png)\n`[code](./neighbor.md)`';
  await seed("inbox/source.md", body);
  await seed("assets/pic.png", "root image");
  await moveNote(root, "inbox/source.md", "archive/moved.md");
  expect(await readNote(root, "archive/moved.md")).toBe(body);
});

it("does not treat an existing attachment as an identically named note alias", async () => {
  await seed("inbox/source.md", "---\naliases: [assets/pic.png]\n---\nSource");
  await seed("assets/pic.png", "image bytes");
  await seed("ref.md", "![image](assets/pic.png)");
  await moveNote(root, "inbox/source.md", "archive/moved.md");
  expect(await readNote(root, "ref.md")).toBe("![image](assets/pic.png)");
  await expect(fs.readFile(path.join(root, "assets/pic.png"), "utf8")).resolves.toBe("image bytes");
});

it("preserves extensionless relative self-links and parent-folder targets", async () => {
  await seed("inbox/nested/source.md", "[self](./source#Detail) [neighbor](../neighbor)");
  await seed("inbox/neighbor.md", "original neighbor");
  await moveNote(root, "inbox/nested/source.md", "archive/moved.md");
  const spans = extractMarkdownLinkSpans(await readNote(root, "archive/moved.md"));
  const targets = spans.map((span) => `${path.posix.normalize(path.posix.join("archive", span.urlPath))}.md`);
  expect(targets).toEqual(["archive/moved.md", "inbox/neighbor.md"]);
  expect(spans[0]!.fragment).toBe("#Detail");
  await expect(fs.readFile(path.join(root, targets[1]!), "utf8")).resolves.toBe("original neighbor");
});

it.skipIf(process.platform !== "win32" && process.platform !== "darwin")("matches source spelling to its filesystem note identity", async () => {
  await seed("inbox/source.md", "[[inbox/source]]");
  const result = await moveNote(root, "./INBOX/SOURCE.md", "archive/moved.md");
  const [span] = extractWikilinkSpans(await readNote(root, "archive/moved.md"));
  expect(resolveWikilink(span!.target, "archive/moved.md", await listNotes(root))).toBe("archive/moved.md");
  expect(result.failedReferrers).toEqual([]);
});

it.skipIf(process.platform !== "win32" && process.platform !== "darwin")("preserves differently cased relative self-link targets on a case-insensitive filesystem", async () => {
  await seed("Inbox/Source.md", "[self](./source.md#Detail) [extensionless](./source#Detail) ![embed](./SOURCE.md#^block)");
  await fs.access(path.join(root, "Inbox/source.md"));
  const result = await moveNote(root, "Inbox/Source.md", "Archive/Moved.md");
  const spans = extractMarkdownLinkSpans(await readNote(root, "Archive/Moved.md"));
  const destination = await fs.realpath(path.join(root, "Archive/Moved.md"));
  for (const span of spans) {
    const target = path.posix.normalize(path.posix.join("Archive", span.urlPath));
    const noteTarget = /\.md$/i.test(target) ? target : `${target}.md`;
    await expect(fs.realpath(path.join(root, noteTarget))).resolves.toBe(destination);
  }
  expect(spans.map((span) => span.fragment)).toEqual(["#Detail", "#Detail", "#^block"]);
  expect(spans[2]!.isEmbed).toBe(true);
  expect(result.failedReferrers).toEqual([]);
});

it("normalizes move identities before planning incoming Markdown and wiki references", async () => {
  await seed("old.md", "source");
  await seed("ref.md", "[[old]] [old](./old.md#Detail)");
  const result = await moveNote(root, "./old.md", "./archive/../new.md");
  const body = await readNote(root, "ref.md");
  const [wiki] = extractWikilinkSpans(body);
  expect(resolveWikilink(wiki!.target, "ref.md", await listNotes(root))).toBe("new.md");
  const [markdown] = extractMarkdownLinkSpans(body);
  expect(path.posix.normalize(decodeURIComponent(markdown!.urlPath))).toBe("new.md");
  expect(markdown!.fragment).toBe("#Detail");
  expect(result.failedReferrers).toEqual([]);
});

it("does not redirect a missing explicit relative path to a same-basename note", async () => {
  await seed("inbox/source.md", "source");
  await seed("ref.md", "[missing](./missing/source.md)");
  await moveNote(root, "inbox/source.md", "archive/moved.md");
  expect(await readNote(root, "ref.md")).toBe("[missing](./missing/source.md)");
});

it("reports a changed moved-note link at its destination as a partial failure", async () => {
  await seed("inbox/source.md", "[[inbox/source]]");
  await fs.mkdir(path.join(root, "archive"));
  const plan = await planMoveRewrites(root, "inbox/source.md", "archive/moved.md", await listNotes(root));
  await fs.rename(path.join(root, "inbox/source.md"), path.join(root, "archive/moved.md"));
  await seed("archive/moved.md", "[[different]]");
  const result = await applyRewrites(root, plan);
  expect(result.failed).toEqual([{ path: "archive/moved.md", error: "content changed during move; references not updated" }]);
  expect(await readNote(root, "archive/moved.md")).toBe("[[different]]");
});
