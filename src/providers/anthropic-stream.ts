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
  parseToolArguments,
  providerBodyExcerpt,
  readSSEBody,
} from "./provider-stream-common.js";

export interface AnthropicStreamProviderOptions {
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly apiVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly turnId?: () => string;
}

export class AnthropicStreamProvider implements StreamProvider {
  readonly #apiKey: string | undefined;
  readonly #endpoint: string;
  readonly #apiVersion: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #turnId: () => string;
  #counter = 0;

  constructor(options: AnthropicStreamProviderOptions = {}) {
    this.#apiKey = options.apiKey;
    this.#endpoint =
      options.endpoint ?? "https://api.anthropic.com/v1/messages";
    this.#apiVersion = options.apiVersion ?? "2023-06-01";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#turnId = options.turnId ?? (() => `turn_${(this.#counter += 1)}`);
  }

  async stream(
    request: unknown,
    emit: StreamEventSink,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly unknown[]> {
    const state = new AnthropicStreamState(this.#turnId(), emit);
    state.start();
    try {
      let response: Response;
      try {
        response = await this.#fetch(this.#endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            "anthropic-version": this.#apiVersion,
            ...(this.#apiKey === undefined
              ? {}
              : { "x-api-key": this.#apiKey }),
          },
          body: JSON.stringify({
            ...(request as Record<string, unknown>),
            stream: true,
          }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        throw new ProviderError(
          `Anthropic stream request failed: ${String(error)}`,
          { errorClass: "network" },
        );
      }
      if (!response.ok) {
        const detail = await providerBodyExcerpt(response);
        throw new ProviderError(
          `Anthropic stream returned HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
          {
            status: response.status,
            ...(detail === undefined ? {} : { detail }),
            errorClass: classifyProviderStatus(response.status),
          },
        );
      }
      await readSSEBody(response, "anthropic", (data) => state.data(data));
      return state.finish();
    } catch (error) {
      state.fail(error);
      throw error;
    }
  }
}

interface AnthropicTool {
  readonly id: string;
  readonly name: string;
  args: string;
  arguments?: Record<string, unknown>;
}

class AnthropicStreamState {
  readonly #turnId: string;
  readonly #emit: StreamEventSink;
  readonly #text: string[] = [];
  readonly #tools = new Map<number, AnthropicTool>();
  readonly #openBlocks = new Map<number, string>();
  #messageStarted = false;
  #messageStopped = false;
  #stopSeen = false;
  #stop = "other";
  readonly #usage: Record<string, unknown> = {
    input_tokens: 0,
    output_tokens: 0,
  };

  constructor(turnId: string, emit: StreamEventSink) {
    this.#turnId = turnId;
    this.#emit = emit;
  }

  start(): void {
    this.#emitDelta("assistant_turn_started", { turn_id: this.#turnId });
  }

  data(raw: string): void {
    const payload = parseObjectJSON("anthropic", raw);
    const eventType = typeof payload.type === "string" ? payload.type : "";
    if (eventType === "") {
      throw new ProviderProtocolError(
        "anthropic",
        "invalid_frame",
        "SSE event is missing type",
      );
    }
    if (eventType === "error") {
      const error = isRecord(payload.error) ? payload.error : {};
      const errorType = typeof error.type === "string" ? error.type : "";
      throw new ProviderStreamError(
        "anthropic",
        errorType,
        typeof error.message === "string" ? error.message : "",
        {
          requestId:
            typeof payload.request_id === "string" ? payload.request_id : "",
          status: anthropicErrorStatus(errorType),
        },
      );
    }
    if (eventType === "ping") {
      return;
    }
    switch (eventType) {
      case "message_start": {
        if (this.#messageStarted) {
          throw new ProviderProtocolError(
            "anthropic",
            "duplicate_start",
            "duplicate message_start event",
          );
        }
        if (this.#messageStopped) {
          throw new ProviderProtocolError(
            "anthropic",
            "invalid_order",
            "message_start arrived after message_stop",
          );
        }
        this.#messageStarted = true;
        const message = isRecord(payload.message) ? payload.message : {};
        this.#mergeUsage(isRecord(message.usage) ? message.usage : {});
        break;
      }
      case "content_block_start": {
        this.#requireActive(eventType);
        const index = numericIndex(payload.index);
        if (this.#openBlocks.has(index)) {
          throw new ProviderProtocolError(
            "anthropic",
            "duplicate_block_start",
            "duplicate content block index",
          );
        }
        const block = isRecord(payload.content_block)
          ? payload.content_block
          : {};
        const blockType = typeof block.type === "string" ? block.type : "";
        if (blockType === "") {
          throw new ProviderProtocolError(
            "anthropic",
            "invalid_frame",
            "content block is missing type",
          );
        }
        this.#openBlocks.set(index, blockType);
        if (blockType === "tool_use") {
          const id = typeof block.id === "string" ? block.id : "";
          const name = typeof block.name === "string" ? block.name : "";
          if (id === "" || name === "") {
            throw new ProviderProtocolError(
              "anthropic",
              "invalid_tool",
              "tool_use block requires id and name",
            );
          }
          this.#tools.set(index, { id, name, args: "" });
          this.#emitDelta("tool_use_begin", {
            turn_id: this.#turnId,
            tool_use_id: id,
            name,
          });
        }
        break;
      }
      case "content_block_delta": {
        this.#requireActive(eventType);
        const index = numericIndex(payload.index);
        const blockType = this.#openBlocks.get(index);
        if (blockType === undefined) {
          throw new ProviderProtocolError(
            "anthropic",
            "invalid_order",
            "content block delta has no open block",
          );
        }
        const delta = isRecord(payload.delta) ? payload.delta : {};
        if (delta.type === "text_delta") {
          if (blockType === "tool_use") {
            throw new ProviderProtocolError(
              "anthropic",
              "invalid_frame",
              "text delta arrived for tool block",
            );
          }
          const chunk = typeof delta.text === "string" ? delta.text : "";
          if (chunk !== "") {
            this.#text.push(chunk);
            this.#emitDelta("assistant_text_delta", {
              turn_id: this.#turnId,
              chunk,
            });
          }
        } else if (delta.type === "input_json_delta") {
          const tool = this.#tools.get(index);
          if (tool === undefined) {
            throw new ProviderProtocolError(
              "anthropic",
              "invalid_frame",
              "input_json_delta arrived outside tool_use block",
            );
          }
          const chunk =
            typeof delta.partial_json === "string" ? delta.partial_json : "";
          tool.args += chunk;
          this.#emitDelta("tool_use_argument_delta", {
            turn_id: this.#turnId,
            tool_use_id: tool.id,
            chunk,
          });
        } else {
          throw new ProviderProtocolError(
            "anthropic",
            "invalid_frame",
            "unknown content block delta type",
          );
        }
        break;
      }
      case "content_block_stop": {
        this.#requireActive(eventType);
        const index = numericIndex(payload.index);
        if (!this.#openBlocks.delete(index)) {
          throw new ProviderProtocolError(
            "anthropic",
            "invalid_order",
            "content block stop has no open block",
          );
        }
        const tool = this.#tools.get(index);
        if (tool !== undefined) {
          tool.arguments = parseToolArguments("anthropic", tool.args);
          this.#emitDelta("tool_use_end", {
            turn_id: this.#turnId,
            tool_use_id: tool.id,
            arguments: tool.arguments,
          });
        }
        break;
      }
      case "message_delta": {
        this.#requireActive(eventType);
        const delta = isRecord(payload.delta) ? payload.delta : {};
        if (typeof delta.stop_reason === "string" && delta.stop_reason !== "") {
          if (this.#stopSeen) {
            throw new ProviderProtocolError(
              "anthropic",
              "duplicate_terminal",
              "duplicate stop_reason",
            );
          }
          this.#stopSeen = true;
          this.#stop = mapAnthropicStop(delta.stop_reason);
        }
        this.#mergeUsage(isRecord(payload.usage) ? payload.usage : {});
        break;
      }
      case "message_stop":
        if (!this.#messageStarted) {
          throw new ProviderProtocolError(
            "anthropic",
            "invalid_order",
            "message_stop before message_start",
          );
        }
        if (this.#messageStopped) {
          throw new ProviderProtocolError(
            "anthropic",
            "duplicate_terminal",
            "duplicate message_stop",
          );
        }
        if (this.#openBlocks.size > 0) {
          throw new ProviderProtocolError(
            "anthropic",
            "incomplete_block",
            "message_stop with open content block",
          );
        }
        if (!this.#stopSeen) {
          throw new ProviderProtocolError(
            "anthropic",
            "missing_stop_reason",
            "message_stop without stop_reason",
          );
        }
        this.#messageStopped = true;
        break;
      default:
        // Unknown future events are legal no-ops; they do not advance lifecycle.
        break;
    }
  }

  fail(error: unknown): void {
    this.#emitDelta("assistant_turn_failed", {
      turn_id: this.#turnId,
      error: String(error),
    });
  }

  finish(): readonly unknown[] {
    if (!this.#messageStarted) {
      throw new ProviderProtocolError(
        "anthropic",
        "missing_start",
        "stream ended before message_start",
      );
    }
    if (!this.#messageStopped) {
      throw new ProviderProtocolError(
        "anthropic",
        "missing_terminal",
        "stream ended before message_stop",
      );
    }
    this.#emitDelta("assistant_turn_completed", {
      turn_id: this.#turnId,
      stop_reason: this.#stop,
      usage: this.#usage,
    });
    const consolidated: unknown[] = [
      {
        type: "assistant_message",
        payload: {
          text: this.#text.join(""),
          stop_reason: this.#stop,
          usage: normalizeUsage(this.#usage),
        },
      },
    ];
    for (const [, tool] of [...this.#tools.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      consolidated.push({
        type: "tool_use",
        payload: {
          id: tool.id,
          name: tool.name,
          arguments: tool.arguments ?? {},
        },
      });
    }
    return consolidated;
  }

  #requireActive(eventType: string): void {
    if (!this.#messageStarted) {
      throw new ProviderProtocolError(
        "anthropic",
        "invalid_order",
        `${eventType} before message_start`,
      );
    }
    if (this.#messageStopped) {
      throw new ProviderProtocolError(
        "anthropic",
        "invalid_order",
        `${eventType} after message_stop`,
      );
    }
  }

  #mergeUsage(usage: Record<string, unknown>): void {
    if (usage.input_tokens !== undefined)
      this.#usage.input_tokens = usage.input_tokens;
    if (usage.output_tokens !== undefined)
      this.#usage.output_tokens = usage.output_tokens;
  }

  #emitDelta(
    type: StreamDeltaEventType,
    payload: Record<string, unknown>,
  ): void {
    this.#emit({ type, payload });
  }
}

function numericIndex(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function mapAnthropicStop(value: string): string {
  return [
    "end_turn",
    "max_tokens",
    "tool_use",
    "stop_sequence",
    "refusal",
  ].includes(value)
    ? value
    : "other";
}

function anthropicErrorStatus(type: string): number {
  return (
    {
      invalid_request_error: 400,
      authentication_error: 401,
      billing_error: 402,
      permission_error: 403,
      not_found_error: 404,
      request_too_large: 413,
      rate_limit_error: 429,
      api_error: 500,
      timeout_error: 504,
      overloaded_error: 529,
    }[type] ?? 0
  );
}
