import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";

export const REPLACEMENT_BUDGET_MS = 1_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

interface ReplacementInput {
  text: string;
  find: string;
  replace: string;
  regex: boolean;
  flags: string;
  expectedCount?: number;
}

interface ReplacementResult {
  count: number;
  nextContent: string;
}

type WorkerResult =
  | { kind: "success"; value: ReplacementResult }
  | { kind: "pattern" | "output" | "execution" }
  | { kind: "count"; count: number };

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { text, find, replace, regex, flags, expectedCount, maxOutputBytes } = workerData;
let compiled = false;
try {
  const source = regex ? find : find.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(source, regex ? flags : "g");
  compiled = true;
  const matches = text.match(pattern);
  const count = matches ? matches.length : 0;
  if (expectedCount !== undefined && count !== expectedCount) {
    parentPort.postMessage({ kind: "count", count });
  } else {
    const nextContent = count === 0 ? text : regex
      ? text.replace(pattern, replace)
      : text.replace(pattern, () => replace);
    if (Buffer.byteLength(nextContent, "utf8") > maxOutputBytes) {
      parentPort.postMessage({ kind: "output" });
    } else {
      parentPort.postMessage({ kind: "success", value: { count, nextContent } });
    }
  }
} catch {
  parentPort.postMessage({ kind: compiled ? "execution" : "pattern" });
}
`;

export function replaceNoteText(
  input: ReplacementInput,
  signal?: AbortSignal
): Promise<ReplacementResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Replacement cancelled. No changes written."));
      return;
    }
    const deadline = performance.now() + REPLACEMENT_BUDGET_MS;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        execArgv: [],
        env: {},
        workerData: { ...input, maxOutputBytes: MAX_OUTPUT_BYTES },
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      });
    } catch {
      reject(new Error("Replacement worker failed. No changes written."));
      return;
    }
    let settled = false;
    const finish = (result: ReplacementResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate().then(
        () => {
          if (result instanceof Error) reject(result);
          else if (signal?.aborted)
            reject(new Error("Replacement cancelled. No changes written."));
          else resolve(result);
        },
        () =>
          reject(new Error("Replacement worker failed. No changes written."))
      );
    };
    const onAbort = (): void =>
      finish(new Error("Replacement cancelled. No changes written."));
    const budgetError = (): Error =>
      new Error(
        `Replacement exceeded the ${REPLACEMENT_BUDGET_MS} ms worker budget. No changes written.`
      );
    const timer = setTimeout(
      () => finish(budgetError()),
      Math.max(0, deadline - performance.now())
    );
    worker.once("message", (message: WorkerResult) => {
      if (performance.now() >= deadline) {
        finish(budgetError());
        return;
      }
      switch (message.kind) {
        case "success":
          finish(message.value);
          break;
        case "count":
          finish(
            new Error(
              `Match-count check failed: expected ${input.expectedCount}, found ${message.count}. No changes written.`
            )
          );
          break;
        case "pattern":
          finish(new Error("Invalid regex pattern. No changes written."));
          break;
        case "output":
          finish(
            new Error(
              "Replacement output exceeds the 5 MiB limit. No changes written."
            )
          );
          break;
        case "execution":
          finish(new Error("Replacement worker failed. No changes written."));
          break;
      }
    });
    worker.once("error", () =>
      finish(new Error("Replacement worker failed. No changes written."))
    );
    worker.once("exit", () =>
      finish(
        new Error(
          "Replacement worker exited before returning a result. No changes written."
        )
      )
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
