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

/** Per-request HTTP timeout. Long-running embedding calls (a 64-batch on a
 *  cold Ollama with a 4 GB model) can legitimately take 10s+, but anything
 *  past 30s is almost certainly a hung connection or a misconfigured URL. */
const EMBED_REQUEST_TIMEOUT_MS = 30_000;

/** SEC-3: Validate that an embedding URL uses an allowed scheme and base shape.
 *  Only https:// and http:// to loopback addresses are permitted.
 *  This prevents SSRF and API-key exfiltration if an attacker can
 *  influence the OBSIDIAN_EMBEDDING_URL environment variable. */
function validateEmbeddingUrl(raw: string): string {
  const value = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "OBSIDIAN_EMBEDDING_URL is not a valid URL. " +
        "Provide a full URL like https://api.example.com or http://localhost:11434",
    );
  }

  const isHttps = parsed.protocol === "https:";
  const isLoopback =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]");

  if (!isHttps && !isLoopback) {
    throw new Error(
      "OBSIDIAN_EMBEDDING_URL scheme/host not allowed. " +
        "Only https:// URLs and http:// to localhost/127.0.0.1 are permitted.",
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error(
      "OBSIDIAN_EMBEDDING_URL must not include credentials. " +
        "Provide the provider base URL without embedded credentials.",
    );
  }

  if (parsed.search || value.includes("?") || parsed.hash || value.includes("#")) {
    throw new Error(
      "OBSIDIAN_EMBEDDING_URL must not include query strings or fragments. " +
        "Provide only the provider base URL.",
    );
  }

  return value;
}

/** SEC-15: Validate that a model name looks reasonable.
 *  Rejects empty strings, control characters, and names longer than 200
 *  characters. The allowed character set covers every major provider's
 *  naming conventions (alphanumeric, hyphens, dots, slashes, colons,
 *  underscores, plus signs, at signs). */
const MODEL_NAME_RE = /^[a-zA-Z0-9\-._/:@+]+$/;
const MODEL_NAME_MAX_LENGTH = 200;

function validateModelName(name: string, context: string): string {
  if (!name || name.trim().length === 0) {
    throw new Error(
      `OBSIDIAN_EMBEDDING_MODEL is empty (context: ${context}). Provide a valid model name.`,
    );
  }
  if (name.length > MODEL_NAME_MAX_LENGTH) {
    throw new Error(
      `OBSIDIAN_EMBEDDING_MODEL is too long (${name.length} chars, max ${MODEL_NAME_MAX_LENGTH}). ` +
        `Context: ${context}.`,
    );
  }
  if (!MODEL_NAME_RE.test(name)) {
    throw new Error(
      `OBSIDIAN_EMBEDDING_MODEL contains invalid characters: "${name}". ` +
        "Only alphanumeric characters, hyphens, dots, slashes, colons, underscores, plus signs, " +
        `and at signs are allowed. Context: ${context}.`,
    );
  }
  return name;
}

function firstNonBlankEnvValue(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
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
    // /api/embed yet. We probe with a SINGLE-ITEM request on cold start so a
    // transient failure (timeout / network blip) doesn't take down a full
    // batch with it. On a generic error we leave batchSupported=null so a
    // future call can re-probe cheaply; only a 404-style "endpoint missing"
    // pins us to the per-item fallback permanently.
    //
    // When the probe succeeds we REUSE its vector as the embedding for
    // texts[0] and batch-embed only the remaining texts. Without this reuse
    // a cold-start call on N texts wastes one full embedding (the probe's
    // result is thrown away and texts[0] is re-embedded inside the followup
    // batched call).
    if (this.batchSupported === null) {
      let probeVector: number[] | null = null;
      try {
        const probe = await this.embedBatched(texts.slice(0, 1));
        this.batchSupported = true;
        probeVector = probe[0] ?? null;
      } catch (err) {
        if (this.isMethodMissing(err)) {
          this.batchSupported = false;
        } else {
          throw err;
        }
      }
      // Probe succeeded: stitch its result with a batched call over the
      // rest. If there was only one input, the probe already covered it.
      if (this.batchSupported && probeVector !== null) {
        if (texts.length === 1) return [probeVector];
        const rest = await this.embedBatched(texts.slice(1));
        return [probeVector, ...rest];
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
      body: JSON.stringify({ model: this.model, input: texts, truncate: false }),
      signal: AbortSignal.timeout(EMBED_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Ollama /api/embed returned HTTP ${res.status}`);
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
        signal: AbortSignal.timeout(EMBED_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Ollama /api/embeddings returned HTTP ${res.status}`);
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
      signal: AbortSignal.timeout(EMBED_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings returned HTTP ${res.status}`);
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
    const model = validateModelName(
      process.env.OBSIDIAN_EMBEDDING_MODEL ?? "nomic-embed-text",
      "ollama",
    );
    const url = validateEmbeddingUrl(
      process.env.OBSIDIAN_EMBEDDING_URL ?? "http://localhost:11434",
    );
    cachedProvider = new OllamaProvider(model, url);
    return cachedProvider;
  }
  if (kind === "openai") {
    const apiKey = firstNonBlankEnvValue(
      process.env.OBSIDIAN_EMBEDDING_API_KEY,
      process.env.OPENAI_API_KEY,
    );
    if (!apiKey) {
      cachedProvider = null;
      return null;
    }
    const model = validateModelName(
      process.env.OBSIDIAN_EMBEDDING_MODEL ?? "text-embedding-3-small",
      "openai",
    );
    const url = validateEmbeddingUrl(
      process.env.OBSIDIAN_EMBEDDING_URL ?? "https://api.openai.com/v1",
    );
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
