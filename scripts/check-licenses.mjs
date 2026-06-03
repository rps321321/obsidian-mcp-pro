// License gate: scan installed dependencies and fail on copyleft/non-permissive
// licenses that are incompatible with shipping under MIT. Dependency-free so it
// runs as part of `verify:full` without adding a tool to the tree.
//
// Exit 1 if any installed package carries a denied license. Unknown licenses are
// reported as warnings (review them; they don't block).

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modulesDir = join(root, "node_modules");

// SPDX ids we accept for a package we redistribute under MIT.
const ALLOW = new Set([
  "MIT", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0",
  "Unlicense", "CC0-1.0", "BlueOak-1.0.0", "Python-2.0", "WTFPL", "MIT-0",
]);

// Hard fails: copyleft / source-available / non-commercial.
const DENY = [
  "GPL-1.0", "GPL-2.0", "GPL-3.0", "AGPL", "LGPL", "SSPL", "EUPL",
  "CC-BY-NC", "CC-BY-SA", "BUSL", "CPAL", "OSL", "EPL", "MPL-1",
];

function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object") return pkg.license.type ?? "";
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "";
}

// Split an SPDX expression like "(MIT OR Apache-2.0)" into atoms.
function atoms(expr) {
  return expr.replace(/[()]/g, " ").split(/\s+(?:OR|AND)\s+/i).map((s) => s.trim()).filter(Boolean);
}

function* installedPackages(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === ".bin" || entry === ".cache") continue;
    const full = join(dir, entry);
    if (entry.startsWith("@")) {
      yield* installedPackages(full); // scoped packages live one level deeper
      continue;
    }
    if (!statSync(full).isDirectory()) continue;
    const manifest = join(full, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      if (pkg.name) yield pkg;
    } catch {
      // ignore unreadable manifest
    }
  }
}

const denied = [];
const unknown = [];
let count = 0;

for (const pkg of installedPackages(modulesDir)) {
  count++;
  const expr = licenseOf(pkg);
  const parts = atoms(expr);
  if (parts.length === 0) {
    unknown.push(`${pkg.name}@${pkg.version} (no license field)`);
    continue;
  }
  // A package is fine if ANY atom is allowed (covers "MIT OR GPL" dual licenses).
  const ok = parts.some((p) => ALLOW.has(p));
  if (ok) continue;
  const bad = parts.some((p) => DENY.some((d) => p.toUpperCase().startsWith(d.toUpperCase())));
  if (bad) denied.push(`${pkg.name}@${pkg.version}: ${expr}`);
  else unknown.push(`${pkg.name}@${pkg.version}: ${expr}`);
}

console.log(`Checked ${count} installed packages.`);

if (unknown.length) {
  console.log(`\nReview (${unknown.length}) — license not on the allow list:`);
  for (const u of unknown) console.log(`  - ${u}`);
}

if (denied.length) {
  console.error(`\nDenied (${denied.length}) — incompatible with MIT redistribution:`);
  for (const d of denied) console.error(`  - ${d}`);
  process.exit(1);
}

console.log("\nNo denied licenses.");
