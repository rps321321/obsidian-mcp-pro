import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setPermissions,
  loadPermissionsFromEnv,
  assertAllowed,
  describePermissions,
} from "../lib/permissions.js";

describe("permissions", () => {
  beforeEach(() => {
    setPermissions({ readPaths: null, writePaths: null });
  });

  afterEach(() => {
    delete process.env.OBSIDIAN_READ_PATHS;
    delete process.env.OBSIDIAN_WRITE_PATHS;
    setPermissions({ readPaths: null, writePaths: null });
  });

  it("permits everything when allowlists are unset", () => {
    expect(() => assertAllowed("a/b.md", "read")).not.toThrow();
    expect(() => assertAllowed("any/path.md", "write")).not.toThrow();
  });

  it("restricts reads to listed folders", () => {
    setPermissions({ readPaths: ["projects"], writePaths: null });
    expect(() => assertAllowed("projects/a.md", "read")).not.toThrow();
    expect(() => assertAllowed("private/a.md", "read")).toThrow(/Access denied/);
  });

  it("restricts writes independently of reads", () => {
    setPermissions({ readPaths: null, writePaths: ["drafts"] });
    expect(() => assertAllowed("anywhere/a.md", "read")).not.toThrow();
    expect(() => assertAllowed("drafts/a.md", "write")).not.toThrow();
    expect(() => assertAllowed("public/a.md", "write")).toThrow(/Access denied/);
  });

  it("treats '.' as vault-root unrestriction", () => {
    setPermissions({ readPaths: ["."], writePaths: null });
    expect(() => assertAllowed("anywhere/a.md", "read")).not.toThrow();
  });

  it("matches subfolders under listed roots", () => {
    setPermissions({ readPaths: ["projects"], writePaths: null });
    expect(() => assertAllowed("projects/sub/a.md", "read")).not.toThrow();
  });

  it("loads allowlists from env vars", () => {
    process.env.OBSIDIAN_READ_PATHS = "a,b:c";
    process.env.OBSIDIAN_WRITE_PATHS = "drafts";
    const cfg = loadPermissionsFromEnv();
    expect(cfg.readPaths).toEqual(["a", "b", "c"]);
    expect(cfg.writePaths).toEqual(["drafts"]);
  });

  it("describePermissions returns 'unrestricted' when null", () => {
    expect(describePermissions()).toEqual({ read: "unrestricted", write: "unrestricted" });
  });

  it("describePermissions joins folders when set", () => {
    setPermissions({ readPaths: ["a", "b"], writePaths: ["c"] });
    expect(describePermissions()).toEqual({ read: "a, b", write: "c" });
  });
});
