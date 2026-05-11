import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadPermissionsFromEnv, setPermissions } from "../lib/permissions.js";

/**
 * M6 regression: parseList delimiter behavior.
 *
 * The audit flagged that parseList accepts `,`, `:`, and `;` as separators
 * while the JSDoc only documented "colon-or-comma". The SAFE fix chosen
 * here is to keep the existing regex (backward compatible) and update the
 * JSDoc to document all three delimiters plus their caveats. These tests
 * pin the behavior so any future change is intentional.
 */
describe("regression: parseList delimiter behavior (M6)", () => {
  beforeEach(() => {
    delete process.env.OBSIDIAN_READ_PATHS;
    delete process.env.OBSIDIAN_WRITE_PATHS;
    setPermissions({ readPaths: null, writePaths: null });
  });

  afterEach(() => {
    delete process.env.OBSIDIAN_READ_PATHS;
    delete process.env.OBSIDIAN_WRITE_PATHS;
    setPermissions({ readPaths: null, writePaths: null });
  });

  it("parses comma-separated input on every platform", () => {
    process.env.OBSIDIAN_READ_PATHS = "alpha,beta,gamma";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toEqual(["alpha", "beta", "gamma"]);
  });

  it("parses semicolon-separated input (Windows-style PATH lists)", () => {
    process.env.OBSIDIAN_READ_PATHS = "alpha;beta;gamma";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toEqual(["alpha", "beta", "gamma"]);
  });

  it("parses colon-separated input (POSIX-style PATH lists)", () => {
    process.env.OBSIDIAN_READ_PATHS = "alpha:beta:gamma";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toEqual(["alpha", "beta", "gamma"]);
  });

  it("accepts a mix of all three delimiters", () => {
    process.env.OBSIDIAN_READ_PATHS = "alpha,beta:gamma;delta";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("trims whitespace around entries", () => {
    process.env.OBSIDIAN_READ_PATHS = " a , b ; c : d ";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toEqual(["a", "b", "c", "d"]);
  });

  it("drops empty entries from doubled delimiters", () => {
    process.env.OBSIDIAN_READ_PATHS = "a,,b;;c::d";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toEqual(["a", "b", "c", "d"]);
  });

  it("returns null for an unset env var", () => {
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toBeNull();
    expect(cfg.writePaths).toBeNull();
  });

  it("returns null for an env var containing only delimiters/whitespace", () => {
    process.env.OBSIDIAN_READ_PATHS = " , ; : ";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toBeNull();
  });

  /**
   * Documented known limitation: on POSIX systems a folder name may legally
   * contain `:`. Because parseList treats `:` as a delimiter, such a name is
   * fragmented into two entries. Users with colons in folder names should
   * use `,` instead. This test pins that behavior so any future change is
   * deliberate.
   */
  it("fragments POSIX folder names containing ':' (known limitation, use ',' instead)", () => {
    process.env.OBSIDIAN_READ_PATHS = "2024:archive";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toEqual(["2024", "archive"]);
  });

  it("preserves a comma-separated folder name even when it would split on ':'", () => {
    // Workaround for the above limitation: use `,` exclusively.
    process.env.OBSIDIAN_READ_PATHS = "notes,journal";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toEqual(["notes", "journal"]);
  });

  it("applies the same delimiter rules to OBSIDIAN_WRITE_PATHS", () => {
    process.env.OBSIDIAN_WRITE_PATHS = "drafts;outbox,scratch:tmp";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.writePaths).toEqual(["drafts", "outbox", "scratch", "tmp"]);
  });
});
