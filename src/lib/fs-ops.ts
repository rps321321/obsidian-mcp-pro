import fs from "fs/promises";

// Windows raises EPERM/EBUSY/EACCES from fs.rename when another process has
// either endpoint open. Obsidian, sync clients, and antivirus scanners usually
// release those handles within a few milliseconds, so retry the transient
// class before surfacing a failure. POSIX EACCES is normally structural, not a
// timing issue, so non-Windows platforms stay fail-fast.
const FILE_RETRY_CODES: ReadonlySet<string> = process.platform === "win32"
  ? new Set(["EPERM", "EBUSY", "EACCES"])
  : new Set();

const FILE_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160];

async function retryTransientFileError(fn: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!FILE_RETRY_CODES.has(code) || attempt >= FILE_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, FILE_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export async function renameWithRetry(from: string, to: string): Promise<void> {
  await retryTransientFileError(() => fs.rename(from, to));
}

export async function unlinkWithRetry(file: string): Promise<void> {
  await retryTransientFileError(() => fs.unlink(file));
}
