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
import {
  isRecord,
  parseObjectJSON,
  parseToolArguments,
  providerBodyExcerpt,
  readSSEBody,
} from "./provider-stream-common.js";

/**
 * A live streaming provider. `stream` opens a real SSE connection, emits §15
 * transport deltas via `emit` **as tokens arrive** (Observation-only), and
 * resolves to the consolidated events (`assistant_message` + `tool_use`) that
 * the AgentLoop appends to the Log. Mirrors harnas-go's `StreamProvider.Call`.
 */
export interface StreamProvider {
  stream(
    request: unknown,
    emit: StreamEventSink,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly unknown[]>;
}

export interface OpenAIStreamProviderOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Override the turn id generator (deterministic ids in tests). */
  readonly turnId?: () => string;
}

/** Live SSE streaming against OpenAI chat/completions. */
export class OpenAIStreamProvider implements StreamProvider {
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #turnId: () => string;
  #counter = 0;

  constructor(options: OpenAIStreamProviderOptions = {}) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#turnId = options.turnId ?? (() => `turn_${(this.#counter += 1)}`);
  }

  async stream(
    request: unknown,
    emit: StreamEventSink,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly unknown[]> {
    const body = {
      ...(request as Record<string, unknown>),
      stream: true,
      stream_options: { include_usage: true },
    };
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (this.#apiKey !== undefined) {
      headers.authorization = `Bearer ${this.#apiKey}`;
    }

    const state = new OpenAIStreamState(this.#turnId(), emit);
    state.start();
    try {
      let response: Response;
      try {
        response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
      } catch (error) {
        throw new ProviderError(
          `OpenAI stream request failed: ${String(error)}`,
          {
            errorClass: "network",
          },
        );
      }
      if (!response.ok) {
        const detail = await providerBodyExcerpt(response);
        throw new ProviderError(
          `OpenAI stream returned HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
          {
            status: response.status,
            ...(detail === undefined ? {} : { detail }),
            errorClass: classifyProviderStatus(response.status),
          },
        );
      }
      await readSSEBody(response, "openai", (data) => state.data(data));
      return state.finish();
    } catch (error) {
      state.fail(error);
      throw error;
    }
  }
}

interface ToolAccumulator {
  id: string;
  name: string;
  args: string;
  begun: boolean;
}

/** Parses OpenAI streaming chunks into §15 deltas + a consolidated turn. */
class OpenAIStreamState {
  readonly #turnId: string;
  readonly #emit: StreamEventSink;
  #started = false;
  #text = "";
  #reasoning = "";
  readonly #tools = new Map<number, ToolAccumulator>();
  #finishReason = "stop";
  #usage: Record<string, unknown> | undefined;
  #finishSeen = false;
  #doneSeen = false;

  constructor(turnId: string, emit: StreamEventSink) {
    this.#turnId = turnId;
    this.#emit = emit;
  }

  data(raw: string): void {
    if (raw === "[DONE]") {
      if (this.#doneSeen) {
        throw new ProviderProtocolError(
          "openai",
          "duplicate_terminal",
          "duplicate [DONE] sentinel",
        );
      }
      this.#doneSeen = true;
      return;
    }
    if (this.#doneSeen) {
      throw new ProviderProtocolError(
        "openai",
        "invalid_order",
        "data arrived after [DONE]",
      );
    }
    const payload = parseObjectJSON("openai", raw);
    if (isRecord(payload.error)) {
      const errorType =
        typeof payload.error.type === "string"
          ? payload.error.type
          : typeof payload.error.code === "string"
            ? payload.error.code
            : "";
      throw new ProviderStreamError(
        "openai",
        errorType,
        typeof payload.error.message === "string" ? payload.error.message : "",
        {
          requestId:
            typeof payload.request_id === "string" ? payload.request_id : "",
          status:
            typeof payload.error.status === "number" ? payload.error.status : 0,
        },
      );
    }
    if (isRecord(payload.usage)) {
      this.#usage = payload.usage;
    }
    const choices = payload.choices;
    const choice =
      Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : undefined;
    if (choice === undefined) {
      return;
    }
    if (isRecord(choice.delta)) {
      if (this.#finishSeen) {
        throw new ProviderProtocolError(
          "openai",
          "invalid_order",
          "delta arrived after finish_reason",
        );
      }
      this.#handleDelta(choice.delta);
    }
    if (
      typeof choice.finish_reason === "string" &&
      choice.finish_reason !== ""
    ) {
      if (this.#finishSeen) {
        throw new ProviderProtocolError(
          "openai",
          "duplicate_terminal",
          "duplicate finish_reason",
        );
      }
      this.#finishSeen = true;
      this.#finishReason = choice.finish_reason;
    }
  }

  start(): void {
    this.#ensureStarted();
  }

  fail(error: unknown): void {
    this.#emitDelta("assistant_turn_failed", {
      turn_id: this.#turnId,
      error: String(error),
    });
  }

  finish(): readonly unknown[] {
    if (!this.#doneSeen) {
      throw new ProviderProtocolError(
        "openai",
        "missing_terminal",
        "stream ended before [DONE]",
      );
    }
    if (!this.#finishSeen) {
      throw new ProviderProtocolError(
        "openai",
        "missing_finish_reason",
        "stream ended without finish_reason",
      );
    }
    for (const tool of this.#tools.values()) {
      if (tool.id === "" || tool.name === "") {
        throw new ProviderProtocolError(
          "openai",
          "invalid_tool",
          "tool call completed without id and name",
        );
      }
      this.#emitDelta("tool_use_end", {
        turn_id: this.#turnId,
        tool_use_id: tool.id,
        arguments: parseToolArguments("openai", tool.args),
      });
    }
    const usage = normalizeStreamUsage(this.#usage);
    const stopReason =
      this.#tools.size > 0 ? "tool_use" : mapFinishReason(this.#finishReason);
    this.#emitDelta("assistant_turn_completed", {
      turn_id: this.#turnId,
      stop_reason: stopReason,
      usage,
    });

    const consolidated: unknown[] = [
      {
        type: "assistant_message",
        payload: {
          text: this.#text,
          stop_reason: stopReason,
          usage: normalizeUsage(usage),
          // Reasoning capture over the OpenAI-compatible wire: mirror the
          // buffered ingestor's shape so reasoning round-trips instead of
          // being dropped mid-stream. (Tedo-ai/harnas-typescript#16)
          ...(this.#reasoning.length > 0
            ? { reasoning: [{ type: "text", text: this.#reasoning }] }
            : {}),
        },
      },
    ];
    for (const tool of this.#tools.values()) {
      consolidated.push({
        type: "tool_use",
        payload: {
          id: tool.id,
          name: tool.name,
          arguments: parseToolArguments("openai", tool.args),
        },
      });
    }
    return consolidated;
  }

  #ensureStarted(): void {
    if (!this.#started) {
      this.#started = true;
      this.#emitDelta("assistant_turn_started", { turn_id: this.#turnId });
    }
  }

  #handleDelta(delta: Record<string, unknown>): void {
    this.#ensureStarted();
    if (typeof delta.content === "string" && delta.content.length > 0) {
      this.#text += delta.content;
      this.#emitDelta("assistant_text_delta", {
        turn_id: this.#turnId,
        chunk: delta.content,
      });
    }
    // Reasoning models over the OpenAI-compatible wire (e.g. via OpenRouter)
    // stream reasoning as delta.reasoning; accumulate rather than drop it.
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
      this.#reasoning += delta.reasoning;
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const rawCall of delta.tool_calls) {
        if (!isRecord(rawCall)) {
          continue;
        }
        const index = typeof rawCall.index === "number" ? rawCall.index : 0;
        const fn = isRecord(rawCall.function) ? rawCall.function : {};
        let tool = this.#tools.get(index);
        if (tool === undefined) {
          tool = {
            id: typeof rawCall.id === "string" ? rawCall.id : "",
            name: typeof fn.name === "string" ? fn.name : "",
            args: "",
            begun: false,
          };
          this.#tools.set(index, tool);
        }
        if (typeof rawCall.id === "string" && rawCall.id !== "") {
          tool.id = rawCall.id;
        }
        if (typeof fn.name === "string" && fn.name !== "") {
          tool.name = fn.name;
        }
        if (tool.id !== "" && tool.name !== "" && !tool.begun) {
          tool.begun = true;
          this.#emitDelta("tool_use_begin", {
            turn_id: this.#turnId,
            tool_use_id: tool.id,
            name: tool.name,
          });
        }
        if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
          if (tool.id === "" || tool.name === "") {
            throw new ProviderProtocolError(
              "openai",
              "invalid_tool",
              "tool arguments arrived before id and name",
            );
          }
          tool.args += fn.arguments;
          this.#emitDelta("tool_use_argument_delta", {
            turn_id: this.#turnId,
            tool_use_id: tool.id,
            chunk: fn.arguments,
          });
        }
      }
    }
  }

  #emitDelta(
    type: StreamDeltaEventType,
    payload: Record<string, unknown>,
  ): void {
    this.#emit({ type, payload });
  }
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return reason;
  }
}

function normalizeStreamUsage(
  usage: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (usage === undefined) {
    return {};
  }
  const out: Record<string, unknown> = {};
  if (typeof usage.prompt_tokens === "number") {
    out.input_tokens = usage.prompt_tokens;
  }
  if (typeof usage.completion_tokens === "number") {
    out.output_tokens = usage.completion_tokens;
  }
  // Preserve the detail objects so core normalizeUsage can lift
  // reasoning_tokens / cached_tokens — reasoning models can spend their whole
  // completion budget on reasoning, and "empty because it reasoned" must be
  // diagnosable from usage. (Tedo-ai/harnas-typescript#16)
  if (isRecord(usage.completion_tokens_details)) {
    out.completion_tokens_details = usage.completion_tokens_details;
  }
  if (isRecord(usage.prompt_tokens_details)) {
    out.prompt_tokens_details = usage.prompt_tokens_details;
  }
  return out;
}
