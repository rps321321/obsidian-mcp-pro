// Perf regression gate: run the bench and compare to a committed baseline. Timing
// is noisy, so this is standalone (not in verify) and uses a wide margin to catch
// gross regressions, not jitter. Run it before changing scan-heavy code.
//
//   node scripts/perf-check.mjs            compare against tests/perf/baseline.json
//   node scripts/perf-check.mjs --update   record the current run as the new baseline
//
// Baseline timings are machine-specific — regenerate on the machine the loop runs on.

import { runBench } from "./bench.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, "build", "index.js");
const baselinePath = join(root, "tests", "perf", "baseline.json");
const MARGIN = 2.0; // a run may be up to 2x the baseline before it's flagged

if (!existsSync(entry)) {
  console.error("build/index.js missing — run `npm run build` first.");
  process.exit(1);
}

const update = process.argv.includes("--update");
const sizes = !update && existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8")).map((r) => r.n)
  : [100, 1000];

const rows = await runBench(sizes);

if (update) {
  mkdirSync(dirname(baselinePath), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(rows, null, 2) + "\n");
  console.log(`baseline written: ${baselinePath}`);
  for (const r of rows) console.log(`  ${r.n} notes: cold ${r.coldMs.toFixed(0)}ms  warm ${r.warmMs.toFixed(0)}ms`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error("no baseline yet — run `npm run perf:update` first.");
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const byN = new Map(baseline.map((r) => [r.n, r]));
let failed = false;

for (const r of rows) {
  const base = byN.get(r.n);
  if (!base) continue;
  for (const k of ["coldMs", "warmMs"]) {
    const limit = base[k] * MARGIN;
    const ok = r[k] <= limit;
    if (!ok) failed = true;
    console.log(`${r.n} ${k}\t${r[k].toFixed(0)}ms (baseline ${base[k].toFixed(0)}ms, limit ${limit.toFixed(0)}ms) ${ok ? "ok" : "REGRESSION"}`);
  }
}

process.exit(failed ? 1 : 0);
