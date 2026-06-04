// Chunker boundary-quality benchmark: generate synthetic notes that exercise
// semantic indexing chunk boundaries, then score the resulting chunks.
//
// Direct use: node scripts/bench-chunker-quality.mjs [--json]
// Run after `npm run build`.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const chunkerEntry = join(root, "build", "lib", "chunker.js");

const OPTIONS = {
  targetChars: 900,
  overlapChars: 120,
};

function repeatSentences(seed, count) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    lines.push(`${seed} Detail ${String(i).padStart(2, "0")} keeps enough text for a real embedding-sized paragraph.`);
  }
  return lines.join(" ");
}

function makeCodeBlock(lineCount) {
  const lines = ["```ts", "export function importantBoundaryCase(input: string): string {"];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(`  const value${i} = input.trim().toLowerCase() + "-case-${i}";`);
  }
  lines.push("  return value1;", "}", "```");
  return lines.join("\n");
}

const fixtures = [
  {
    name: "project-playbook",
    expectedTitle: "Atlas Playbook / Project Atlas",
    content: [
      "---",
      "title: Atlas Playbook",
      "aliases: [Project Atlas]",
      "---",
      "# Atlas",
      repeatSentences("The overview explains owners, milestones, and constraints.", 8),
      "## Research",
      repeatSentences("Research notes compare candidate retrieval behavior.", 11),
      "### Open Questions",
      repeatSentences("The open-question list tracks decisions that need evidence.", 6),
      "## Ship Plan",
      repeatSentences("The ship plan records release gates and rollback notes.", 10),
    ].join("\n\n"),
  },
  {
    name: "code-reference",
    expectedTitle: "Chunker Code Reference",
    content: [
      "---",
      "title: Chunker Code Reference",
      "---",
      "# Reference",
      "This note keeps one long fenced code block under a heading so the fixture can detect fence splits.",
      "## Reference Implementation",
      makeCodeBlock(44),
      "## Release Checklist",
      repeatSentences("Checklist items should not bleed into implementation chunks.", 7),
    ].join("\n\n"),
  },
  {
    name: "dense-meeting-log",
    expectedTitle: "Daily Research Log / R&D Log",
    content: [
      "---",
      "title: Daily Research Log",
      "aliases: [R&D Log]",
      "---",
      "# Daily Research",
      "## Morning Review",
      repeatSentences("The morning review captures short operational notes.", 8),
      "## Decisions",
      repeatSentences("Decision paragraphs stay dense enough to force paragraph grouping without losing heading context.", 16),
      "### Follow-ups",
      "- [ ] Re-run the retrieval fixture.",
      "- [ ] Compare semantic hit snippets.",
      "- [ ] Record the decision before changing runtime behavior.",
    ].join("\n\n"),
  },
];

function countFenceMarkers(text) {
  return text.match(/^```/gm)?.length ?? 0;
}

function scoreFixture(note, chunks) {
  let headingChunks = 0;
  let headingPrefixHits = 0;
  let titledChunks = 0;
  let titlePrefixHits = 0;
  let codeFenceFractures = 0;
  let oversizeChunks = 0;
  let totalChunkChars = 0;

  for (const chunk of chunks) {
    totalChunkChars += chunk.text.length;
    if (chunk.text.length > OPTIONS.targetChars * 1.1) {
      oversizeChunks++;
    }
    if (note.expectedTitle) {
      titledChunks++;
      if (chunk.text.startsWith(note.expectedTitle)) {
        titlePrefixHits++;
      }
    }
    if (chunk.headingPath.length > 0) {
      headingChunks++;
      const headingPrefix = `${chunk.headingPath.join(" / ")}\n\n`;
      if (chunk.text.includes(headingPrefix)) {
        headingPrefixHits++;
      }
    }
    if (countFenceMarkers(chunk.text) % 2 !== 0) {
      codeFenceFractures++;
    }
  }

  const missingHeadingPrefixes = headingChunks - headingPrefixHits;
  const missingTitlePrefixes = titledChunks - titlePrefixHits;
  const score = Math.max(
    0,
    100
      - codeFenceFractures * 18
      - oversizeChunks * 10
      - missingHeadingPrefixes * 8
      - missingTitlePrefixes * 6,
  );

  return {
    chunks: chunks.length,
    score,
    codeFenceFractures,
    oversizeChunks,
    headingPrefixCoverage: headingChunks === 0 ? 1 : headingPrefixHits / headingChunks,
    titlePrefixCoverage: titledChunks === 0 ? 1 : titlePrefixHits / titledChunks,
    tokenLoadRatio: totalChunkChars / note.content.length,
  };
}

export async function runChunkerQualityBench() {
  const { chunkNote } = await import(pathToFileURL(chunkerEntry).href);
  const start = performance.now();
  const rows = fixtures.map((note) => {
    const chunks = chunkNote(note.content, OPTIONS);
    return {
      fixture: note.name,
      ...scoreFixture(note, chunks),
    };
  });
  const elapsedMs = performance.now() - start;
  const totalChunks = rows.reduce((sum, row) => sum + row.chunks, 0);
  const weightedScore = rows.reduce((sum, row) => sum + row.score * row.chunks, 0) / totalChunks;
  const codeFenceFractures = rows.reduce((sum, row) => sum + row.codeFenceFractures, 0);
  const oversizeChunks = rows.reduce((sum, row) => sum + row.oversizeChunks, 0);
  const tokenLoadRatio = rows.reduce((sum, row) => sum + row.tokenLoadRatio, 0) / rows.length;

  return {
    options: OPTIONS,
    notes: fixtures.length,
    chunks: totalChunks,
    elapsedMs,
    boundaryScore: weightedScore,
    codeFenceFractures,
    oversizeChunks,
    meanTokenLoadRatio: tokenLoadRatio,
    rows,
  };
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  if (!existsSync(chunkerEntry)) {
    console.error("build/lib/chunker.js missing - run `npm run build` first.");
    process.exit(1);
  }
  const asJson = process.argv.includes("--json");
  const result = await runChunkerQualityBench();
  if (asJson) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`boundary score ${result.boundaryScore.toFixed(1)}`);
    console.log(`chunks ${result.chunks}`);
    console.log(`code fence fractures ${result.codeFenceFractures}`);
    console.log(`oversize chunks ${result.oversizeChunks}`);
    console.log(`mean token load ratio ${result.meanTokenLoadRatio.toFixed(2)}x`);
    console.log(`elapsed ${result.elapsedMs.toFixed(2)}ms`);
    console.log("\n| fixture | chunks | score | fence fractures | oversize | heading prefix | title prefix | token load |");
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const row of result.rows) {
      console.log(
        `| ${row.fixture} | ${row.chunks} | ${row.score.toFixed(1)} | ${row.codeFenceFractures} | ${row.oversizeChunks} | ${(row.headingPrefixCoverage * 100).toFixed(0)}% | ${(row.titlePrefixCoverage * 100).toFixed(0)}% | ${row.tokenLoadRatio.toFixed(2)}x |`,
      );
    }
  }
}
