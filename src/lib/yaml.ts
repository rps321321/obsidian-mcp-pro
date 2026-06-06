export function hasYamlAnchorOrAliasToken(yaml: string): boolean {
  let inSingle = false;
  let inDouble = false;

  for (const rawLine of yaml.split(/\n/)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    let nodeStart = 0;

    for (let i = 0; i < line.length; i += 1) {
      const ch = line.charAt(i);
      const prev = i === 0 ? "" : line.charAt(i - 1);
      const next = line.charAt(i + 1);

      if (inSingle) {
        if (ch === "'" && line[i + 1] === "'") {
          i += 1;
        } else if (ch === "'") {
          inSingle = false;
        }
        continue;
      }

      if (inDouble) {
        if (ch === "\\") {
          i += 1;
        } else if (ch === "\"") {
          inDouble = false;
        }
        continue;
      }

      if (ch === "#") {
        if (i === 0 || /\s/.test(prev)) break;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        continue;
      }
      if (ch === "\"") {
        inDouble = true;
        continue;
      }
      if (ch === "[" || ch === "{" || ch === ",") {
        nodeStart = i + 1;
        continue;
      }
      if (ch === ":" && (next === "" || /[\s\]},]/.test(next))) {
        nodeStart = i + 1;
        continue;
      }
      if (ch !== "&" && ch !== "*") continue;

      if (!/[A-Za-z0-9_-]/.test(next)) continue;

      const prefix = line.slice(nodeStart, i).trim();
      if (
        prefix === "" ||
        prefix === "-" ||
        prefix === "?" ||
        /^!\S+$/.test(prefix) ||
        /^[-?]\s+!\S+$/.test(prefix)
      ) {
        return true;
      }
    }
  }
  return false;
}
