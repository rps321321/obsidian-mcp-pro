/**
 * Progress-notification helper for long-running tools.
 *
 * MCP clients can pass `_meta.progressToken` on a tool call to subscribe to
 * `notifications/progress` events tied to that token. This helper wraps the
 * SDK's `sendNotification` plumbing with two pragmatic behaviors:
 *
 *   - **No-op when the token is absent** — clients that don't ask for
 *     progress shouldn't pay for it (and don't expect notifications they
 *     can't route).
 *   - **Throttle** — for vault-wide loops we emit at most one notification
 *     every ~100ms in the middle of the loop, then a final 100% emission.
 *     Without this a 4k-note vault would generate 4k notifications and
 *     blow client log buffers.
 */

interface ProgressMeta {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

const THROTTLE_MS = 100;

export interface ProgressReporter {
  /** Emit a progress notification. Throttled to ~10/s except when
   *  `progress === total` (final tick is always sent). */
  (progress: number, total: number, message?: string): Promise<void>;
}

/**
 * Build a progress reporter for a single tool invocation. Returns a no-op
 * function when the client didn't request progress, so callers don't need
 * to branch.
 */
export function makeProgressReporter(extra: ProgressMeta): ProgressReporter {
  const token = extra._meta?.progressToken;
  if (token === undefined) {
    return async () => undefined;
  }
  let lastSent = 0;
  return async (progress, total, message) => {
    const now = Date.now();
    const isFinal = total > 0 && progress >= total;
    if (!isFinal && now - lastSent < THROTTLE_MS) return;
    lastSent = now;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress,
          total,
          message,
        },
      });
    } catch {
      // The client may have disconnected mid-op; we don't want to fail the
      // tool just because a status notification couldn't be delivered.
    }
  };
}
