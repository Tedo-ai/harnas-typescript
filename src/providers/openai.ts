import type { OpenAIRequest } from "../projections/provider/openai.js";
import type { OpenAIResponse } from "../ingestors/openai.js";
import { ProviderError } from "../core/errors.js";

export interface OpenAIProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class OpenAIProvider {
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OpenAIProviderOptions = {}) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async complete(request: OpenAIRequest, options: { readonly signal?: AbortSignal } = {}): Promise<OpenAIResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#apiKey !== undefined) {
      headers.authorization = `Bearer ${this.#apiKey}`;
    }

    const init: RequestInit = {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };

    const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, init);
    if (!response.ok) {
      throw new ProviderError(`OpenAI provider returned HTTP ${response.status}`);
    }
    return (await response.json()) as OpenAIResponse;
  }
}
