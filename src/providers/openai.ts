import type { OpenAIRequest } from "../projections/provider/openai.js";
import type { OpenAIResponse } from "../ingestors/openai.js";
import { classifyProviderStatus, ProviderError } from "../core/errors.js";

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
      const detail = await bodyExcerpt(response);
      throw new ProviderError(
        `OpenAI provider returned HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
        {
          status: response.status,
          ...(detail === undefined ? {} : { detail }),
          errorClass: classifyProviderStatus(response.status),
        },
      );
    }
    return (await response.json()) as OpenAIResponse;
  }
}

async function bodyExcerpt(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).trim();
    if (text.length === 0) {
      return undefined;
    }
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return undefined;
  }
}
