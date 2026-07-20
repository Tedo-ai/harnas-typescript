import {
  classifyProviderStatus,
  ProviderError,
  ProviderProtocolError,
  ProviderStreamError,
} from "../core/errors.js";
import type {
  StreamDeltaEventType,
  StreamEventSink,
} from "../core/streaming.js";
import { normalizeUsage } from "../core/usage.js";
import type { StreamProvider } from "./openai-stream.js";
import {
  isRecord,
  parseObjectJSON,
  providerBodyExcerpt,
  readSSEBody,
} from "./provider-stream-common.js";

export interface GeminiStreamProviderOptions {
  readonly apiKey?: string;
  readonly endpointBase?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly turnId?: () => string;
}

export class GeminiStreamProvider implements StreamProvider {
  readonly #apiKey: string | undefined;
  readonly #endpointBase: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #turnId: () => string;
  #counter = 0;

  constructor(options: GeminiStreamProviderOptions = {}) {
    this.#apiKey = options.apiKey;
    this.#endpointBase =
      options.endpointBase ??
      "https://generativelanguage.googleapis.com/v1beta/models";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#turnId = options.turnId ?? (() => `turn_${(this.#counter += 1)}`);
  }

  async stream(
    request: unknown,
    emit: StreamEventSink,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly unknown[]> {
    const input = { ...(request as Record<string, unknown>) };
    const model = typeof input.model === "string" ? input.model : "";
    if (model === "") {
      throw new ProviderError("Gemini request must include 'model'");
    }
    delete input.model;
    const state = new GeminiStreamState(this.#turnId(), emit);
    state.start();
    try {
      let response: Response;
      try {
        response = await this.#fetch(
          `${this.#endpointBase}/${model}:streamGenerateContent?alt=sse`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "text/event-stream",
              ...(this.#apiKey === undefined
                ? {}
                : { "x-goog-api-key": this.#apiKey }),
            },
            body: JSON.stringify(input),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
      } catch (error) {
        throw new ProviderError(
          `Gemini stream request failed: ${String(error)}`,
          { errorClass: "network" },
        );
      }
      if (!response.ok) {
        const detail = await providerBodyExcerpt(response);
        throw new ProviderError(
          `Gemini stream returned HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
          {
            status: response.status,
            ...(detail === undefined ? {} : { detail }),
            errorClass: classifyProviderStatus(response.status),
          },
        );
      }
      await readSSEBody(response, "gemini", (data) => state.data(data));
      return state.finish();
    } catch (error) {
      state.fail(error);
      throw error;
    }
  }
}

interface GeminiTool {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

class GeminiStreamState {
  readonly #turnId: string;
  readonly #emit: StreamEventSink;
  readonly #text: string[] = [];
  readonly #tools: GeminiTool[] = [];
  readonly #usage: Record<string, unknown> = {
    input_tokens: 0,
    output_tokens: 0,
  };
  #stop = "other";
  #finishSeen = false;

  constructor(turnId: string, emit: StreamEventSink) {
    this.#turnId = turnId;
    this.#emit = emit;
  }

  start(): void {
    this.#emitDelta("assistant_turn_started", { turn_id: this.#turnId });
  }

  data(raw: string): void {
    const payload = parseObjectJSON("gemini", raw);
    if (isRecord(payload.error)) {
      const errorType =
        typeof payload.error.status === "string"
          ? payload.error.status
          : typeof payload.error.type === "string"
            ? payload.error.type
            : "";
      throw new ProviderStreamError(
        "gemini",
        errorType,
        typeof payload.error.message === "string" ? payload.error.message : "",
        {
          requestId:
            typeof payload.request_id === "string" ? payload.request_id : "",
          status:
            typeof payload.error.code === "number" ? payload.error.code : 0,
        },
      );
    }
    if (this.#finishSeen) {
      throw new ProviderProtocolError(
        "gemini",
        "invalid_order",
        "data arrived after finishReason",
      );
    }
    const candidates = Array.isArray(payload.candidates)
      ? payload.candidates
      : [];
    const candidate = isRecord(candidates[0]) ? candidates[0] : {};
    const content = isRecord(candidate.content) ? candidate.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const rawPart of parts) {
      const part = isRecord(rawPart) ? rawPart : {};
      if (typeof part.text === "string" && part.text !== "") {
        this.#text.push(part.text);
        this.#emitDelta("assistant_text_delta", {
          turn_id: this.#turnId,
          chunk: part.text,
        });
      }
      if (isRecord(part.functionCall)) {
        const name =
          typeof part.functionCall.name === "string"
            ? part.functionCall.name
            : "";
        if (name === "") {
          throw new ProviderProtocolError(
            "gemini",
            "invalid_tool",
            "functionCall requires name",
          );
        }
        const tool: GeminiTool = {
          id: `gemini_fc_${this.#tools.length}`,
          name,
          arguments: isRecord(part.functionCall.args)
            ? part.functionCall.args
            : {},
        };
        this.#tools.push(tool);
        this.#emitDelta("tool_use_begin", {
          turn_id: this.#turnId,
          tool_use_id: tool.id,
          name: tool.name,
        });
        this.#emitDelta("tool_use_end", {
          turn_id: this.#turnId,
          tool_use_id: tool.id,
          arguments: tool.arguments,
        });
      }
    }
    if (
      typeof candidate.finishReason === "string" &&
      candidate.finishReason !== ""
    ) {
      if (this.#finishSeen) {
        throw new ProviderProtocolError(
          "gemini",
          "duplicate_terminal",
          "duplicate finishReason",
        );
      }
      this.#finishSeen = true;
      this.#stop = mapGeminiStop(candidate.finishReason);
    }
    if (isRecord(payload.usageMetadata)) {
      if (payload.usageMetadata.promptTokenCount !== undefined) {
        this.#usage.input_tokens = payload.usageMetadata.promptTokenCount;
      }
      if (payload.usageMetadata.candidatesTokenCount !== undefined) {
        this.#usage.output_tokens = payload.usageMetadata.candidatesTokenCount;
      }
    }
  }

  fail(error: unknown): void {
    this.#emitDelta("assistant_turn_failed", {
      turn_id: this.#turnId,
      error: String(error),
    });
  }

  finish(): readonly unknown[] {
    if (!this.#finishSeen) {
      throw new ProviderProtocolError(
        "gemini",
        "missing_terminal",
        "stream ended before finishReason",
      );
    }
    this.#emitDelta("assistant_turn_completed", {
      turn_id: this.#turnId,
      stop_reason: this.#stop,
      usage: this.#usage,
    });
    return [
      {
        type: "assistant_message",
        payload: {
          text: this.#text.join(""),
          stop_reason: this.#stop,
          usage: normalizeUsage(this.#usage),
        },
      },
      ...this.#tools.map((tool) => ({
        type: "tool_use",
        payload: { id: tool.id, name: tool.name, arguments: tool.arguments },
      })),
    ];
  }

  #emitDelta(
    type: StreamDeltaEventType,
    payload: Record<string, unknown>,
  ): void {
    this.#emit({ type, payload });
  }
}

function mapGeminiStop(value: string): string {
  switch (value) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "RECITATION":
      return "refusal";
    default:
      return "other";
  }
}
