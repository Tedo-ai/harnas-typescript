import type { EventPayload } from "../core/events.js";
import { normalizeUsage } from "../core/usage.js";

export interface GeminiResponse {
  readonly candidates?: readonly {
    readonly content?: {
      readonly parts?: readonly {
        readonly text?: string;
        readonly functionCall?: {
          readonly name?: string;
          readonly args?: Record<string, unknown>;
        };
      }[];
    };
  }[];
  readonly usageMetadata?: Record<string, unknown>;
}

export interface GeminiIngestOptions {
  readonly toolCallOffset?: number;
}

export function ingestGeminiResponseEvents(
  response: GeminiResponse,
  options: GeminiIngestOptions = {},
): Array<
  | { readonly type: "assistant_message"; readonly payload: EventPayload<"assistant_message"> }
  | { readonly type: "tool_use"; readonly payload: EventPayload<"tool_use"> }
> {
  let geminiToolCounter = options.toolCallOffset ?? 0;
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((part) => part.text ?? "").join("");
  const toolCalls = parts.flatMap((part) => part.functionCall === undefined ? [] : [part.functionCall]);
  const events: Array<
    | { readonly type: "assistant_message"; readonly payload: EventPayload<"assistant_message"> }
    | { readonly type: "tool_use"; readonly payload: EventPayload<"tool_use"> }
  > = [
    {
      type: "assistant_message",
      payload: {
        content: [{ type: "text", text }],
        text,
        stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        usage: normalizeUsage(response.usageMetadata),
        provider: "gemini",
      },
    },
  ];
  for (const call of toolCalls) {
    if (call.name === undefined) {
      continue;
    }
    events.push({
      type: "tool_use",
      payload: {
        id: `gemini.${call.name}.${geminiToolCounter}`,
        name: call.name,
        arguments: call.args ?? {},
      },
    });
    geminiToolCounter += 1;
  }
  return events;
}
