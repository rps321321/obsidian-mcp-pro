---
type: "query"
date: "2026-07-18T17:11:10.580516+00:00"
question: "Why does parseFrontmatter() bridge Link & Markdown Rewriting to Bases Filter Engine and Sections & Chunking?"
contributor: "graphify"
source_nodes:
  [
    "parseFrontmatter()",
    "buildRow()",
    "chunkNote()",
    "parseStrictYamlFrontmatter()",
    "extractAliases()",
  ]
---

# Q: Why does parseFrontmatter() bridge Link & Markdown Rewriting to Bases Filter Engine and Sections & Chunking?

## Answer

parseFrontmatter() in markdown.ts is the shared metadata foundation: bases.ts imports it and buildRow() calls it to read note properties for Base query rows; chunker.ts imports it and chunkNote() calls it to handle frontmatter before heading-based splitting; within its own community it feeds buildNoteMetadata/extractAliases/extractTags, which power link-rewriter alias resolution (planMoveRewrites/planDeleteRewrites). All parses funnel through parseStrictYamlFrontmatter, which shares the yaml.ts anchor/alias-bomb guard with bases. markdown.ts is a de-facto lower layer like vault-fs, with no reverse dependencies on its consumers.

## Source Nodes

- parseFrontmatter()
- buildRow()
- chunkNote()
- parseStrictYamlFrontmatter()
- extractAliases()
