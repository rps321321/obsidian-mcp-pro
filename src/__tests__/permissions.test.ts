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

  // Regression for the CRITICAL bypass identified in v1.8.0 audit:
  // assertAllowed used to run on the raw user-supplied path, before
  // path.resolve collapsed `..` segments. A path like
  // `Allowed/../Secret.md` would pass the prefix check (string starts with
  // `Allowed/`) but resolve to `Secret.md` outside the allowlist.
  describe("dot-dot traversal cannot escape the allowlist", () => {
    it("rejects ..-escape from within an allowed folder", () => {
      setPermissions({ readPaths: ["projects"], writePaths: null });
      expect(() => assertAllowed("projects/../private/secret.md", "read")).toThrow(/Access denied/);
    });

    it("rejects deeper ..-escape that climbs above the vault root", () => {
      setPermissions({ readPaths: ["projects"], writePaths: null });
      expect(() => assertAllowed("projects/sub/../../../../etc/passwd", "read")).toThrow(/Access denied/);
    });

    it("rejects a leading .. that bypasses the prefix check", () => {
      setPermissions({ readPaths: ["projects"], writePaths: null });
      expect(() => assertAllowed("../projects/a.md", "read")).toThrow(/Access denied/);
    });

    it("rejects writes that ..-escape into a different folder", () => {
      setPermissions({ readPaths: null, writePaths: ["drafts"] });
      expect(() => assertAllowed("drafts/../public/post.md", "write")).toThrow(/Access denied/);
    });

    it("permits ..-traversal that lands back inside the same allowed folder", () => {
      setPermissions({ readPaths: ["projects"], writePaths: null });
      // `projects/sub/../a.md` collapses to `projects/a.md` — still allowed.
      expect(() => assertAllowed("projects/sub/../a.md", "read")).not.toThrow();
    });

    it("rejects backslash-encoded ..-escape on Windows-style paths", () => {
      setPermissions({ readPaths: ["projects"], writePaths: null });
      expect(() => assertAllowed("projects\\..\\private\\secret.md", "read")).toThrow(/Access denied/);
    });
  });
});
