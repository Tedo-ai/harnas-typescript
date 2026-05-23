import type { EventPayload } from "../core/events.js";
import { normalizeUsage } from "../core/usage.js";

export interface OpenAIResponse {
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly {
        readonly id?: string;
        readonly function?: {
          readonly name?: string;
          readonly arguments?: string;
        };
      }[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: Record<string, unknown>;
}

export function ingestOpenAIResponse(response: OpenAIResponse): EventPayload<"assistant_message"> {
  return ingestOpenAIResponseEvents(response)[0]?.payload as EventPayload<"assistant_message">;
}

export function ingestOpenAIResponseEvents(
  response: OpenAIResponse,
): Array<
  | { readonly type: "assistant_message"; readonly payload: EventPayload<"assistant_message"> }
  | { readonly type: "tool_use"; readonly payload: EventPayload<"tool_use"> }
> {
  const choice = response.choices?.[0];
  const message = choice?.message;
  const text = choice?.message?.content ?? "";
  const events: Array<
    | { readonly type: "assistant_message"; readonly payload: EventPayload<"assistant_message"> }
    | { readonly type: "tool_use"; readonly payload: EventPayload<"tool_use"> }
  > = [
    {
      type: "assistant_message",
      payload: {
        content: [{ type: "text", text }],
        text,
        stop_reason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
        usage: normalizeUsage(response.usage),
        provider: "openai",
        ...(response.model !== undefined ? { model: response.model } : {}),
      },
    },
  ];
  for (const toolCall of message?.tool_calls ?? []) {
    if (toolCall.id === undefined || toolCall.function?.name === undefined) {
      continue;
    }
    events.push({
      type: "tool_use",
      payload: {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parseArguments(toolCall.function.arguments),
      },
    });
  }
  return events;
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
