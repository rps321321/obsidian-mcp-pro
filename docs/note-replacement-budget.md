# Bounded note replacement

`replace_in_note` runs pattern compilation, match counting, and replacement in a separate Node worker. The parent thread enforces a 1,000 ms monotonic deadline measured from before worker creation. Worker startup and execution both count toward that budget. A response received after the deadline is rejected even if the timer callback has not run yet.

On timeout or tool cancellation, the parent terminates the worker and waits for termination before rejecting the operation. The deadline is a termination trigger, not a guarantee that the caller receives a response within exactly one second. Scheduling and termination add overhead. The caller's file lock is released after rejection, so subsequent requests can proceed.

## Limits and semantics

- The existing input limits remain 4,096 pattern characters, 1,000,000 note characters, and 1,000,000 replacement characters.
- Worker V8 limits are 64 MiB for the old generation, 16 MiB for the young generation, and 4 MiB for the stack. These are per-worker JavaScript limits, not a cap on total process memory or concurrent callers.
- Output above 5 MiB of UTF-8 is rejected before it is sent back to the parent. Replacement allocation itself occurs inside the resource-limited worker; allocation failure also rejects the operation.
- Regex mode retains JavaScript's native flags and replacement syntax, including numbered and named capture references, `$$`, `$&`, and the prefix and suffix tokens. The existing allowed flags are `g`, `i`, `m`, `s`, `u`, and `y`. Global matching remains mandatory.
- Literal mode escapes the find string and uses a replacement callback. Dollar tokens remain literal text.
- `expectedCount` compares the full native match count before replacement. A mismatch returns an error without changing the note.

The worker source is static trusted code. Pattern, input, and replacement strings travel through `workerData` and are never interpolated into executable code. The same worker source runs in source tests and compiled packages without a separate worker-file path.

The pattern-shape guard remains an early rejection for known costly shapes. It is not the execution bound. An accepted pattern still runs inside the worker deadline.

Timeout, cancellation, worker failure, invalid syntax, and output-limit errors use fixed messages without existing note text. Successful output still passes through `updateNote` and its optimistic external-edit check before any replacement reaches the filesystem. Failed work never commits its candidate content.

## Verification and measured scope

Run `npm test -- src/__tests__/note-replacement-worker.test.ts src/__tests__/regression-tools-sections.test.ts`. Tests cover a costly pattern accepted by the shape guard, unrelated MCP reads during execution, subsequent edits after timeout, cancellation, output growth, UTF-8 limits, match counts, zero-width Unicode matching, sticky matching, flags, and replacement tokens.

On Windows with Node 24.13.0, a built-library probe on 23 October 2026 measured these individual calls, including worker creation and termination:

| Fixture                                               | Result                            | Elapsed    |
| ----------------------------------------------------- | --------------------------------- | ---------- |
| 1,000,000 input characters and matches                | 1,000,000 output bytes            | 97.7 ms    |
| 1,000,000 input and replacement characters, one match | 1,000,000 output bytes            | 30.1 ms    |
| Five matches with a 1,000,000-character replacement   | 5,000,000 output bytes            | 33.8 ms    |
| Guard-accepted costly expression on synthetic input   | Deadline error, worker terminated | 1,004.5 ms |

These measurements establish those fixtures on that host. They do not qualify every valid JavaScript pattern or guarantee the same timings under load. A legitimate expensive call can exceed the budget and leave its note unchanged.
