import fs from "fs/promises";

// Windows raises EPERM/EBUSY/EACCES from fs.rename when another process has
// either endpoint open. Obsidian, sync clients, and antivirus scanners usually
// release those handles within a few milliseconds, so retry the transient
// class before surfacing a failure. POSIX EACCES is normally structural, not a
// timing issue, so non-Windows platforms stay fail-fast.
const RENAME_RETRY_CODES: ReadonlySet<string> = process.platform === "win32"
  ? new Set(["EPERM", "EBUSY", "EACCES"])
  : new Set();

const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160];

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!RENAME_RETRY_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}
