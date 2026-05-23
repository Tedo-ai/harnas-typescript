import type { EventPayload } from "../core/events.js";
import { normalizeUsage } from "../core/usage.js";

export interface AnthropicContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

export interface AnthropicResponse {
  readonly model?: string;
  readonly content?: readonly AnthropicContentBlock[];
  readonly stop_reason?: string | null;
  readonly usage?: Record<string, unknown>;
}

export function ingestAnthropicResponse(response: AnthropicResponse): EventPayload<"assistant_message"> {
  return ingestAnthropicResponseEvents(response)[0]?.payload as EventPayload<"assistant_message">;
}

export function ingestAnthropicResponseEvents(
  response: AnthropicResponse,
): Array<
  | { readonly type: "assistant_message"; readonly payload: EventPayload<"assistant_message"> }
  | { readonly type: "tool_use"; readonly payload: EventPayload<"tool_use"> }
> {
  const text = (response.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
  const events: Array<
    | { readonly type: "assistant_message"; readonly payload: EventPayload<"assistant_message"> }
    | { readonly type: "tool_use"; readonly payload: EventPayload<"tool_use"> }
  > = [
    {
      type: "assistant_message",
      payload: {
        content: [{ type: "text", text }],
        text,
        stop_reason: response.stop_reason === "tool_use" ? "tool_use" : "end_turn",
        usage: normalizeUsage(response.usage),
        provider: "anthropic",
        ...(response.model !== undefined ? { model: response.model } : {}),
      },
    },
  ];
  for (const block of response.content ?? []) {
    if (block.type !== "tool_use" || block.id === undefined || block.name === undefined) {
      continue;
    }
    events.push({
      type: "tool_use",
      payload: {
        id: block.id,
        name: block.name,
        arguments: block.input ?? {},
      },
    });
  }
  return events;
}
