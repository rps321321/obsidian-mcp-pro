# Domain glossary

The ubiquitous language of obsidian-mcp-pro: the nouns the code, tests, and docs
should all use for the same thing. This is the domain vocabulary; architectural
vocabulary (module, interface, seam, depth) lives in the design notes, not here.
Grow this file lazily as terms are named or sharpened.

## Vault and notes

**Vault**: the Obsidian vault this server is bound to, resolved once at startup
from `OBSIDIAN_VAULT_PATH` or the Obsidian config. Every path a tool touches is
validated relative to the vault root.

**Note**: a Markdown file (`.md`) inside the vault. The unit most tools read and
write.

**Frontmatter**: the YAML mapping at the top of a note, between `---` fences.
Parsed strictly (anchors and aliases are rejected).

**Section**: the body under a heading, addressed by a heading path such as
`Tasks/Today`. A section ends at the next heading of any depth.

**Block**: a paragraph or element tagged with a `^id` reference, addressable on
its own.

**Tag**: an inline `#tag` in the body or a `tags` entry in frontmatter.
Hierarchical (`#area/subarea`).

## Links

**Wikilink**: an Obsidian `[[target]]` reference. Resolution follows Obsidian's
own four-step rule with a proximity tie-break.

**Backlink / Outlink**: a link pointing at a note (backlink) versus a link a note
points out to (outlink).

**Orphan**: a note with no backlinks. **Broken link**: a wikilink whose target
does not resolve anywhere in the vault.

## Other file types

**Canvas**: an Obsidian `.canvas` file: a JSON graph of nodes and edges.

**Base**: an Obsidian `.base` file: a saved query/view over notes, with its own
filter language.

**Attachment**: a non-text file in the vault (image, audio, PDF, and so on),
served as bytes rather than parsed as text.

**Daily Note**: the note for a given day, located and named per the vault's
`daily-notes` configuration.

## Retrieval

**Semantic index**: the persisted store of note embeddings that powers
`search_semantic` and `find_similar_notes`.

**Chunk**: a heading-aware slice of a note that gets embedded as one vector.

**Embedding provider**: the external service that turns chunk text into vectors
(Ollama by default, OpenAI optional). Swappable behind one interface.

## Tools and trust

**Tool**: one callable MCP operation (there are 41). **Tool group**: a family of
related tools (read, write, tags, links, canvas, sections, bases, attachments,
semantic) registered together.

**Untrusted vault content**: any vault-derived text surfaced to the model. It is
wrapped in explicit BEGIN/END markers and tagged with trust metadata so the model
treats it as data, never as instructions. This is the vault's prompt-injection
trust boundary: the dividing line between text the server authored (trusted) and
text that came out of the vault (untrusted).

**Permission allowlist**: the optional `OBSIDIAN_READ_PATHS` / `OBSIDIAN_WRITE_PATHS`
folders that scope what tools may read or modify. Enforced at a single choke point
when a path is resolved.
