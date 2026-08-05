import type { EventPayload, StopReason } from "../core/events.js";
import { normalizeUsage } from "../core/usage.js";
import { providerCarrier } from "../provider-carriers.js";

interface GeminiPart {
  readonly text?: string;
  readonly thoughtSignature?: string;
  readonly functionCall?: {
    readonly name?: string;
    readonly args?: Record<string, unknown>;
  };
}

export interface GeminiResponse {
  readonly candidates?: readonly {
    readonly finishReason?: string;
    readonly content?: {
      readonly parts?: readonly GeminiPart[];
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
  const hasCarrierData = parts.some((part) => part.text !== undefined && (part.thoughtSignature !== undefined || hasExtraTextPartFields(part)));
  const events: Array<
    | { readonly type: "assistant_message"; readonly payload: EventPayload<"assistant_message"> }
    | { readonly type: "tool_use"; readonly payload: EventPayload<"tool_use"> }
  > = [
    {
      type: "assistant_message",
      payload: {
        content: [{ type: "text", text }],
        text,
        stop_reason: geminiStopReason(response.candidates?.[0]?.finishReason, toolCalls.length > 0),
        usage: normalizeUsage(response.usageMetadata),
        provider: "gemini",
        ...(hasCarrierData
          ? {
              content: contentBlocksWithCarriers(parts),
            }
          : {}),
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

function geminiStopReason(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (reason === "MAX_TOKENS") return "max_tokens";
  if (hasToolCalls) return "tool_use";
  if (reason === "STOP" || reason === undefined) return "end_turn";
  return "other";
}

function contentBlocksWithCarriers(parts: readonly GeminiPart[]): EventPayload<"assistant_message">["content"] {
  const blocks: Array<EventPayload<"assistant_message">["content"][number]> = [];
  for (const part of parts) {
    if (part.text === undefined) {
      continue;
    }
    const block = {
      type: "text" as const,
      text: part.text,
      ...(part.thoughtSignature !== undefined || hasExtraTextPartFields(part)
        ? {
            provider_parts: [
              providerCarrier({
                destination: "gemini.generateContent",
                index: 0,
                kind: "gemini.part",
                wire: part,
                canonicalRefs: [`payload.content[${blocks.length}]`],
              }),
            ],
          }
        : {}),
    };
    blocks.push(block);
  }
  return blocks;
}

function hasExtraTextPartFields(part: object): boolean {
  return Object.keys(part).some((key) => key !== "text");
}
