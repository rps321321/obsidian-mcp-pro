// Similar-note quality benchmark: populate the embedding store with synthetic
// vectors, run the same source-anchored search used by find_similar_notes, and
// score the returned note order.
//
// Direct use: node scripts/bench-similar-notes-quality.mjs [--json]
// Run after `npm run build`.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const storeEntry = join(root, "build", "lib", "embedding-store.js");
const SOURCE_NOTE = "source-cat-care.md";
const LIMIT = 5;

const notes = [
  {
    path: SOURCE_NOTE,
    relevance: null,
    chunks: [
      { heading: ["Cats", "Care"], text: "Source note's main cat-care section.", vector: [1, 0, 0] },
      { heading: ["Appendix", "Recipes"], text: "Unrelated recipe appendix copied into the source note.", vector: [0.1, 1, 0] },
      { heading: ["Appendix", "Kitchen"], text: "Kitchen inventory copied into the source note.", vector: [0.1, 1, 0] },
    ],
  },
  {
    path: "cats-care.md",
    relevance: 3,
    chunks: [
      { heading: ["Cats", "Care"], text: "Focused cat-care note.", vector: [0.98, 0.05, 0] },
      { heading: ["Cats", "Behavior"], text: "Feline behavior and care routines.", vector: [0.96, 0.08, 0] },
    ],
  },
  {
    path: "cat-health.md",
    relevance: 3,
    chunks: [
      { heading: ["Cats", "Health"], text: "Veterinary and cat health notes.", vector: [0.97, 0.04, 0] },
    ],
  },
  {
    path: "pet-overview.md",
    relevance: 2,
    chunks: [
      { heading: ["Pets"], text: "Mixed pet overview with some cat material.", vector: [0.75, 0.25, 0] },
    ],
  },
  {
    path: "kitchen-recipes.md",
    relevance: 0,
    chunks: [
      { heading: ["Kitchen"], text: "Recipes and pantry notes.", vector: [0, 1, 0] },
      { heading: ["Oven"], text: "Kitchen appliance checklist.", vector: [0, 1, 0] },
    ],
  },
  {
    path: "dogs.md",
    relevance: 0,
    chunks: [
      { heading: ["Dogs"], text: "Dog training notes.", vector: [0, 0, 1] },
    ],
  },
];

function gain(relevance) {
  return (2 ** relevance) - 1;
}

function dcg(relevances) {
  return relevances.reduce((sum, relevance, index) => {
    return sum + gain(relevance) / Math.log2(index + 2);
  }, 0);
}

function ndcgAt(results, k) {
  const actual = results.slice(0, k).map((row) => row.relevance);
  const ideal = notes
    .filter((note) => typeof note.relevance === "number")
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, k)
    .map((row) => row.relevance);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 0 : dcg(actual) / idealDcg;
}

export async function runSimilarNotesQualityBench() {
  const {
    loadStore,
    setNoteChunks,
    searchEmbeddings,
    getNoteEmbeddings,
    buildSimilarNotesQueryVector,
    hashText,
    clearStore,
  } = await import(pathToFileURL(storeEntry).href);

  const vault = mkdtempSync(join(tmpdir(), "ompro-similar-quality-"));
  try {
    await loadStore(vault);
    for (const note of notes) {
      setNoteChunks(
        vault,
        note.path,
        hashText(note.path),
        note.chunks.map((chunk, index) => ({
          notePath: note.path,
          chunkIndex: index + 1,
          headingPath: chunk.heading,
          text: chunk.text,
          hash: "",
          vector: chunk.vector,
        })),
        "fixture",
        "similar-quality",
      );
    }

    const ownChunks = getNoteEmbeddings(vault, SOURCE_NOTE);
    const queryVector = buildSimilarNotesQueryVector(ownChunks);
    const hits = searchEmbeddings(vault, queryVector, {
      limit: LIMIT,
      excludeNotes: new Set([SOURCE_NOTE]),
    });
    const relevanceByPath = new Map(
      notes
        .filter((note) => typeof note.relevance === "number")
        .map((note) => [note.path, note.relevance]),
    );
    const rows = hits.map((hit, index) => ({
      rank: index + 1,
      notePath: hit.notePath,
      chunkIndex: hit.chunkIndex,
      score: hit.score,
      relevance: relevanceByPath.get(hit.notePath) ?? 0,
      headingPath: hit.headingPath,
    }));
    const topK = rows.slice(0, 3);

    return {
      source: SOURCE_NOTE,
      limit: LIMIT,
      queryVector,
      ndcgAt3: ndcgAt(rows, 3),
      precisionAt3: topK.filter((row) => row.relevance >= 2).length / 3,
      topRelevance: rows[0]?.relevance ?? 0,
      offTopicTopResult: rows[0]?.relevance === 0,
      rows,
    };
  } finally {
    await clearStore(vault, { removeSnapshot: true });
    rmSync(vault, { recursive: true, force: true });
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  if (!existsSync(storeEntry)) {
    console.error("build/lib/embedding-store.js missing - run `npm run build` first.");
    process.exit(1);
  }
  const result = await runSimilarNotesQualityBench();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`NDCG@3 ${result.ndcgAt3.toFixed(3)}`);
    console.log(`precision@3 ${result.precisionAt3.toFixed(3)}`);
    console.log(`top relevance ${result.topRelevance}`);
    console.log(`off-topic top result ${result.offTopicTopResult}`);
    console.log("\n| rank | note | rel | score | chunk | heading |");
    console.log("|---:|---|---:|---:|---:|---|");
    for (const row of result.rows) {
      console.log(
        `| ${row.rank} | ${row.notePath} | ${row.relevance} | ${row.score.toFixed(3)} | ${row.chunkIndex} | ${row.headingPath.join(" / ")} |`,
      );
    }
  }
}
