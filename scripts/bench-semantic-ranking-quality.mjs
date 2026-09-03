// Semantic ranking-quality benchmark: populate the embedding store with
// synthetic vectors and score note-level search order.
//
// Direct use: node scripts/bench-semantic-ranking-quality.mjs [--json]
// Run after `npm run build`.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const storeEntry = join(root, "build", "lib", "embedding-store.js");

const QUERY_VECTOR = [1, 0, 0];
const LIMIT = 5;

const notes = [
  {
    path: "kitchen-with-cat.md",
    relevance: 1,
    chunks: [
      { heading: ["Kitchen"], text: "A kitchen remodel note with one cat anecdote.", vector: [1, 0, 0] },
      { heading: ["Recipes"], text: "Recipe planning and pantry notes.", vector: [0, 1, 0] },
      { heading: ["Oven"], text: "Oven cleaning checklist.", vector: [0, 1, 0] },
    ],
  },
  {
    path: "cats-care.md",
    relevance: 3,
    chunks: [
      { heading: ["Cats", "Care"], text: "Focused cat care guidance.", vector: [0.98, 0.05, 0] },
      { heading: ["Cats", "Behavior"], text: "Focused feline behavior notes.", vector: [0.96, 0.08, 0] },
    ],
  },
  {
    path: "cat-health.md",
    relevance: 3,
    chunks: [
      { heading: ["Cats", "Health"], text: "Vaccines, food, and vet care for cats.", vector: [0.97, 0.06, 0] },
      { heading: ["Cats", "Symptoms"], text: "Symptoms to track before a vet visit.", vector: [0.93, 0.1, 0] },
    ],
  },
  {
    path: "pet-overview.md",
    relevance: 2,
    chunks: [
      { heading: ["Pets"], text: "Mixed cat and dog household notes.", vector: [0.85, 0.2, 0] },
      { heading: ["Budget"], text: "Pet supplies and monthly budget.", vector: [0.75, 0.25, 0] },
    ],
  },
  {
    path: "dogs.md",
    relevance: 0,
    chunks: [
      { heading: ["Dogs"], text: "Dog training and puppy notes.", vector: [0.1, 0.95, 0] },
    ],
  },
  {
    path: "weather.md",
    relevance: 0,
    chunks: [
      { heading: ["Weather"], text: "Storm tracking and weather notes.", vector: [0, 0, 1] },
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
  const ideal = [...notes].sort((a, b) => b.relevance - a.relevance).slice(0, k).map((row) => row.relevance);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 0 : dcg(actual) / idealDcg;
}

function hasIncidentalBeforeFocused(results) {
  const firstFocused = results.findIndex((row) => row.relevance === 3);
  const firstIncidental = results.findIndex((row) => row.relevance === 1);
  return firstIncidental !== -1 && firstFocused !== -1 && firstIncidental < firstFocused;
}

export async function runSemanticRankingQualityBench() {
  const {
    openEmbeddingStore,
    hashText,
  } = await import(pathToFileURL(storeEntry).href);

  const vault = mkdtempSync(join(tmpdir(), "ompro-semantic-ranking-"));
  const store = openEmbeddingStore(vault);
  try {
    await store.load();
    for (const note of notes) {
      store.setNoteChunks(
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
        "ranking-quality",
      );
    }

    const hits = store.search(QUERY_VECTOR, { limit: LIMIT });
    const relevanceByPath = new Map(notes.map((note) => [note.path, note.relevance]));
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
      query: "cat care",
      limit: LIMIT,
      ndcgAt3: ndcgAt(rows, 3),
      precisionAt3: topK.filter((row) => row.relevance >= 2).length / 3,
      topRelevance: rows[0]?.relevance ?? 0,
      incidentalBeforeFocused: hasIncidentalBeforeFocused(rows),
      rows,
    };
  } finally {
    await store.clear({ removeSnapshot: true });
    rmSync(vault, { recursive: true, force: true });
  }
}

const invokedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (invokedDirectly) {
  if (!existsSync(storeEntry)) {
    console.error("build/lib/embedding-store.js missing - run `npm run build` first.");
    process.exit(1);
  }
  const result = await runSemanticRankingQualityBench();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`NDCG@3 ${result.ndcgAt3.toFixed(3)}`);
    console.log(`precision@3 ${result.precisionAt3.toFixed(3)}`);
    console.log(`top relevance ${result.topRelevance}`);
    console.log(`incidental before focused ${result.incidentalBeforeFocused}`);
    console.log("\n| rank | note | rel | score | chunk | heading |");
    console.log("|---:|---|---:|---:|---:|---|");
    for (const row of result.rows) {
      console.log(
        `| ${row.rank} | ${row.notePath} | ${row.relevance} | ${row.score.toFixed(3)} | ${row.chunkIndex} | ${row.headingPath.join(" / ")} |`,
      );
    }
  }
}
