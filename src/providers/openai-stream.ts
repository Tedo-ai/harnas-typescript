import { classifyProviderStatus, ProviderError } from "../core/errors.js";
import type { StreamDeltaEventType, StreamEventSink } from "../core/streaming.js";

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
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error) {
      state.fail(error);
      throw new ProviderError(`OpenAI stream request failed: ${String(error)}`, {
        errorClass: "network",
      });
    }
    if (!response.ok || response.body === null) {
      const detail = await providerBodyExcerpt(response);
      state.fail(new Error(`HTTP ${response.status}`));
      throw new ProviderError(
        `OpenAI stream returned HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
        {
          status: response.status,
          ...(detail === undefined ? {} : { detail }),
          errorClass: classifyProviderStatus(response.status),
        },
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith("data:")) {
          continue; // SSE comments / event: lines are ignored for chat completions
        }
        const data = line.slice(5).trim();
        if (data === "" || data === "[DONE]") {
          continue;
        }
        state.data(data);
      }
    }
    return state.finish();
  }
}

interface ToolAccumulator {
  id: string;
  name: string;
  args: string;
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

  constructor(turnId: string, emit: StreamEventSink) {
    this.#turnId = turnId;
    this.#emit = emit;
  }

  data(raw: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return; // tolerate a malformed intermediate frame
    }
    if (isRecord(payload.usage)) {
      this.#usage = payload.usage;
    }
    const choices = payload.choices;
    const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : undefined;
    if (choice === undefined) {
      return;
    }
    if (isRecord(choice.delta)) {
      this.#handleDelta(choice.delta);
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
      this.#finishReason = choice.finish_reason;
    }
  }

  fail(error: unknown): void {
    this.#ensureStarted();
    this.#emitDelta("assistant_turn_failed", { turn_id: this.#turnId, error: String(error) });
  }

  finish(): readonly unknown[] {
    this.#ensureStarted();
    for (const tool of this.#tools.values()) {
      this.#emitDelta("tool_use_end", {
        turn_id: this.#turnId,
        tool_use_id: tool.id,
        arguments: parseArgs(tool.args),
      });
    }
    const usage = normalizeStreamUsage(this.#usage);
    const stopReason = this.#tools.size > 0 ? "tool_use" : mapFinishReason(this.#finishReason);
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
          usage,
          // Reasoning capture over the OpenAI-compatible wire: mirror the
          // buffered ingestor's shape so reasoning round-trips instead of
          // being dropped mid-stream. (Tedo-ai/harnas-typescript#16)
          ...(this.#reasoning.length > 0 ? { reasoning: [{ type: "text", text: this.#reasoning }] } : {}),
        },
      },
    ];
    for (const tool of this.#tools.values()) {
      consolidated.push({
        type: "tool_use",
        payload: { id: tool.id, name: tool.name, arguments: parseArgs(tool.args) },
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
      this.#emitDelta("assistant_text_delta", { turn_id: this.#turnId, chunk: delta.content });
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
            id: typeof rawCall.id === "string" ? rawCall.id : `call_${index}`,
            name: typeof fn.name === "string" ? fn.name : "",
            args: "",
          };
          this.#tools.set(index, tool);
          this.#emitDelta("tool_use_begin", { turn_id: this.#turnId, tool_use_id: tool.id, name: tool.name });
        }
        if (typeof rawCall.id === "string" && rawCall.id !== "") {
          tool.id = rawCall.id;
        }
        if (typeof fn.name === "string" && fn.name !== "") {
          tool.name = fn.name;
        }
        if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
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

  #emitDelta(type: StreamDeltaEventType, payload: Record<string, unknown>): void {
    this.#emit({ type, payload });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parseArgs(args: string): Record<string, unknown> {
  if (args === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(args) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeStreamUsage(usage: Record<string, unknown> | undefined): Record<string, unknown> {
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

/** Read a failed response's body for diagnostics, bounded and non-throwing. */
async function providerBodyExcerpt(response: Response): Promise<string | undefined> {
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
