/**
 * Pluggable embedding providers.
 *
 * The semantic-search stack depends on something that turns text into a
 * fixed-length numeric vector. We don't ship our own model — we delegate to
 * a local Ollama instance (the most common self-hosted setup) and leave the
 * door open for additional providers (OpenAI, Voyage, llama.cpp server, …)
 * by isolating the call behind this interface. Adding a provider is one
 * `EmbeddingProvider` implementation plus a case in `getActiveProvider`.
 *
 * Configuration via env:
 *   OBSIDIAN_EMBEDDING_PROVIDER  ollama (default) | openai | none
 *   OBSIDIAN_EMBEDDING_MODEL     model name (default: provider-specific)
 *   OBSIDIAN_EMBEDDING_URL       base URL for HTTP providers
 *   OBSIDIAN_EMBEDDING_API_KEY   api key for hosted providers
 *
 * No provider is auto-installed: when `OBSIDIAN_EMBEDDING_PROVIDER` is unset
 * or `none`, the semantic tools register themselves but return an
 * informative error on call, so users can discover the feature without it
 * crashing the server.
 */

export interface EmbeddingProvider {
  /** Stable identifier used in the persisted index — switching providers
   *  invalidates cached vectors because dimensions / spaces don't match. */
  readonly id: string;
  /** Model identifier, also baked into the index for invalidation. */
  readonly model: string;
  /** Embed a batch of texts. Returning order matches input order. */
  embed(texts: string[]): Promise<number[][]>;
}

class OllamaProvider implements EmbeddingProvider {
  readonly id = "ollama";
  readonly model: string;
  private readonly baseUrl: string;

  constructor(model: string, baseUrl: string) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Ollama supports both single-prompt (older /api/embeddings) and batched
    // (/api/embed). Prefer the batched endpoint when the runtime is recent;
    // fall back per-input for older Ollama installs that haven't shipped
    // /api/embed yet. We probe by attempting the batched call once and
    // remembering the result for subsequent calls within this provider
    // instance.
    if (this.batchSupported === null) {
      try {
        const result = await this.embedBatched(texts);
        this.batchSupported = true;
        return result;
      } catch (err) {
        if (this.isMethodMissing(err)) {
          this.batchSupported = false;
        } else {
          throw err;
        }
      }
    }
    if (this.batchSupported) {
      return this.embedBatched(texts);
    }
    return this.embedPerItem(texts);
  }

  private batchSupported: boolean | null = null;

  private async embedBatched(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/embed returned ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error("Ollama /api/embed returned an unexpected shape");
    }
    return data.embeddings;
  }

  private async embedPerItem(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) {
        throw new Error(`Ollama /api/embeddings returned ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as { embedding?: number[] };
      if (!Array.isArray(data.embedding)) {
        throw new Error("Ollama /api/embeddings returned an unexpected shape");
      }
      out.push(data.embedding);
    }
    return out;
  }

  private isMethodMissing(err: unknown): boolean {
    const m = (err as Error)?.message ?? "";
    return /404|not\s*found/i.test(m);
  }
}

class OpenAIProvider implements EmbeddingProvider {
  readonly id = "openai";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(model: string, baseUrl: string, apiKey: string) {
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings returned ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    if (!Array.isArray(data.data) || data.data.length !== texts.length) {
      throw new Error("OpenAI embeddings returned an unexpected shape");
    }
    // Sort by index to be safe — the API guarantees order, but let's not
    // rely on it.
    const sorted = data.data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((row, i) => {
      if (!Array.isArray(row.embedding)) {
        throw new Error(`OpenAI embeddings: missing vector at row ${i}`);
      }
      return row.embedding;
    });
  }
}

let cachedProvider: EmbeddingProvider | null | undefined;

/**
 * Resolve the configured embedding provider, or null if none is set up.
 * Cached for the lifetime of the process so successive calls don't re-read
 * env vars.
 */
export function getActiveProvider(): EmbeddingProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;
  const kind = (process.env.OBSIDIAN_EMBEDDING_PROVIDER ?? "ollama").toLowerCase().trim();
  if (kind === "" || kind === "none" || kind === "off" || kind === "disabled") {
    cachedProvider = null;
    return null;
  }
  if (kind === "ollama") {
    const model = process.env.OBSIDIAN_EMBEDDING_MODEL ?? "nomic-embed-text";
    const url = process.env.OBSIDIAN_EMBEDDING_URL ?? "http://localhost:11434";
    cachedProvider = new OllamaProvider(model, url);
    return cachedProvider;
  }
  if (kind === "openai") {
    const apiKey = process.env.OBSIDIAN_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      cachedProvider = null;
      return null;
    }
    const model = process.env.OBSIDIAN_EMBEDDING_MODEL ?? "text-embedding-3-small";
    const url = process.env.OBSIDIAN_EMBEDDING_URL ?? "https://api.openai.com/v1";
    cachedProvider = new OpenAIProvider(model, url, apiKey);
    return cachedProvider;
  }
  // Unknown provider: behave as if disabled rather than crash.
  cachedProvider = null;
  return null;
}

/** Test seam — drop the cached provider so subsequent calls re-read env. */
export function resetProviderForTests(): void {
  cachedProvider = undefined;
}

/** Test seam — install a custom provider for a single test, bypassing
 *  env-var resolution. Pass `null` to simulate "no provider configured". */
export function setProviderForTests(p: EmbeddingProvider | null): void {
  cachedProvider = p;
}
