import * as fs from "fs";
import * as path from "path";

export function isValidVaultPath(vaultPath: string): boolean {
  try {
    return (
      fs.statSync(vaultPath).isDirectory() &&
      fs.statSync(path.join(vaultPath, ".obsidian")).isDirectory()
    );
  } catch {
    return false;
  }
}
