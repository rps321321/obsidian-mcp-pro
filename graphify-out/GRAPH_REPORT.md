# Graph Report - src/lib (2026-07-18)

## Corpus Check

- Corpus is ~32,813 words - fits in a single context window. You may not need a graph.

## Summary

- 382 nodes · 858 edges · 12 communities (11 shown, 1 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)

- [[_COMMUNITY_Vault Core FS & File Ops|Vault Core: FS & File Ops]]
- [[_COMMUNITY_Link & Markdown Rewriting|Link & Markdown Rewriting]]
- [[_COMMUNITY_Logging & Error Plumbing|Logging & Error Plumbing]]
- [[_COMMUNITY_Bases Filter Engine|Bases Filter Engine]]
- [[_COMMUNITY_Embedding Store|Embedding Store]]
- [[_COMMUNITY_Sections & Chunking|Sections & Chunking]]
- [[_COMMUNITY_Search & Index Cache|Search & Index Cache]]
- [[_COMMUNITY_Embedding Providers|Embedding Providers]]
- [[_COMMUNITY_Permissions|Permissions]]
- [[_COMMUNITY_Date Utilities|Date Utilities]]
- [[_COMMUNITY_MIME Detection|MIME Detection]]
- [[_COMMUNITY_Progress Reporting|Progress Reporting]]

## God Nodes (most connected - your core abstractions)

1. `resolveVaultPathSafe()` - 21 edges
2. `openVaultFileForRead()` - 16 edges
3. `withFileLock()` - 15 edges
4. `planMoveRewrites()` - 14 edges
5. `getRealVaultRoot()` - 13 edges
6. `stateFor()` - 12 edges
7. `openResolvedVaultFileForRead()` - 11 edges
8. `escapeControlChars()` - 10 edges
9. `planDeleteRewrites()` - 10 edges
10. `assertMarkdownNotePath()` - 10 edges

## Surprising Connections (you probably didn't know these)

- `planMoveRewrites()` --calls--> `listCanvasFiles()` [EXTRACTED]
  link-rewriter.ts → canvas.ts
- `chunkNote()` --calls--> `parseFrontmatter()` [EXTRACTED]
  chunker.ts → markdown.ts
- `applyRewrites()` --calls--> `mapConcurrent()` [EXTRACTED]
  link-rewriter.ts → concurrency.ts
- `planDeleteRewrites()` --calls--> `mapConcurrent()` [EXTRACTED]
  link-rewriter.ts → concurrency.ts
- `planMoveRewrites()` --calls--> `mapConcurrent()` [EXTRACTED]
  link-rewriter.ts → concurrency.ts

## Import Cycles

- None detected.

## Communities (12 total, 1 thin omitted)

### Community 0 - "Vault Core: FS & File Ops"

Cohesion: 0.07
Nodes (73): listBaseFiles(), readBaseFile(), assertCanvasDataCounts(), assertCanvasFileSize(), assertCanvasJsonObject(), canvasDataFromObject(), listCanvasFiles(), readCanvasFile() (+65 more)

### Community 1 - "Link & Markdown Rewriting"

Cohesion: 0.07
Nodes (56): buildRow(), ApplyResult, encodeUrlPath(), formatMarkdownLinkTarget(), isExplicitRelativePath(), isExternalMarkdownUrl(), planDeleteRewrites(), planMoveRewrites() (+48 more)

### Community 2 - "Logging & Error Plumbing"

Cohesion: 0.08
Nodes (39): TextConfirmationOptions, TextConfirmationResult, ErrnoLike, escapeControlChars(), fallbackErrorMessage(), FS_ERROR_MESSAGES, redactUrlSecrets(), sanitizeError() (+31 more)

### Community 3 - "Bases Filter Engine"

Cohesion: 0.10
Nodes (40): BaseDocument, BaseFilter, basenameOf(), basenameWithoutExt(), BasePropertySpec, BaseRow, BaseView, COMPARISON_RE (+32 more)

### Community 4 - "Embedding Store"

Cohesion: 0.09
Nodes (33): buildSimilarNotesQueryVector(), ChunkEmbedding, clearStore(), cosineSimilarity(), doSave(), dropNoteChunks(), freshState(), getNoteEmbeddings() (+25 more)

### Community 5 - "Sections & Chunking"

Cohesion: 0.13
Nodes (22): Chunk, chunkNote(), ChunkOptions, formatFencedCodeChunk(), headingLineEnd(), isClosingFence(), sliceByHeadings(), splitFencedCodeBlock() (+14 more)

### Community 6 - "Search & Index Cache"

Cohesion: 0.14
Nodes (19): mapConcurrent(), CachedFileStats, CacheEntry, cacheFilePath(), caches, clearCache(), flushNow(), flushVaultCache() (+11 more)

### Community 7 - "Embedding Providers"

Cohesion: 0.18
Nodes (7): EmbeddingProvider, firstNonBlankEnvValue(), getActiveProvider(), OllamaProvider, OpenAIProvider, validateEmbeddingUrl(), validateModelName()

### Community 8 - "Permissions"

Cohesion: 0.20
Nodes (12): AccessKind, active, assertAllowed(), eq(), isUnder(), loadPermissionsFromEnv(), normalizeFolder(), normalizePermissionSeparators() (+4 more)

### Community 9 - "Date Utilities"

Cohesion: 0.23
Nodes (12): dayOfYear(), formatLocalDateOnly(), formatMomentDate(), isLeapYear(), isoWeek(), matchToken(), MONTHS, MONTHS_NON_LEAP (+4 more)

### Community 10 - "MIME Detection"

Cohesion: 0.22
Nodes (4): BLOCKED_EXTENSIONS, IMAGE_SIGNATURES, MediaCategory, MIME_BY_EXT

## Knowledge Gaps

- **67 isolated node(s):** `BaseDocument`, `BasePropertySpec`, `BaseView`, `BaseFilter`, `ParsedBase` (+62 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions

_Questions this graph is uniquely positioned to answer:_

- **Why does `parseFrontmatter()` connect `Link & Markdown Rewriting` to `Bases Filter Engine`, `Sections & Chunking`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `log` connect `Logging & Error Plumbing` to `Vault Core: FS & File Ops`, `Link & Markdown Rewriting`, `Embedding Store`, `Search & Index Cache`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **What connects `BaseDocument`, `BasePropertySpec`, `BaseView` to the rest of the system?**
  _67 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Vault Core: FS & File Ops` be split into smaller, more focused modules?**
  _Cohesion score 0.07469135802469136 - nodes in this community are weakly interconnected._
- **Should `Link & Markdown Rewriting` be split into smaller, more focused modules?**
  _Cohesion score 0.06696428571428571 - nodes in this community are weakly interconnected._
- **Should `Logging & Error Plumbing` be split into smaller, more focused modules?**
  _Cohesion score 0.08048103607770583 - nodes in this community are weakly interconnected._
- **Should `Bases Filter Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.10220673635307782 - nodes in this community are weakly interconnected._
