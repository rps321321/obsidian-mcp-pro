import { describe, expect, it } from "vitest";

import {
  findPrivatePaths,
  isPrivatePath,
} from "../../scripts/check-private-paths.mjs";

describe("private path commit guard", () => {
  it.each([
    ".agent/internal/AGENTS.md",
    ".codex/session-context.md",
    "docs/AGENT_GOAL.md",
    "docs/DEVELOPMENT_GOAL.md",
    "docs/COMPETITIVE.md",
    "docs/rnd/search-ranking-quality.md",
    "docs/outreach/launch.md",
    "docs/drafts/announcement.md",
    "docs/devto-article.md",
    "docs/reddit-obsidianmd-post.md",
    "docs/twitter-thread.md",
  ])("blocks %s", (filePath) => {
    expect(isPrivatePath(filePath)).toBe(true);
  });

  it.each([
    "AGENTS.md",
    "docs/agents/domain.md",
    "docs/architecture.md",
    "docs/TOOL_AUTHORING.md",
    "README.md",
    "src/index.ts",
  ])("allows %s", (filePath) => {
    expect(isPrivatePath(filePath)).toBe(false);
  });

  it("normalizes separators, removes duplicates, and sorts blocked paths", () => {
    expect(
      findPrivatePaths([
        "src/index.ts",
        ".\\docs\\rnd\\result.md",
        ".agent/internal/AGENTS.md",
      ])
    ).toEqual([".agent/internal/AGENTS.md", "docs/rnd/result.md"]);
  });
});
