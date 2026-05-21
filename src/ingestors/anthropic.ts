import type { EventPayload } from "../core/events.js";

export interface AnthropicResponse {
  readonly content?: readonly { readonly type?: string; readonly text?: string }[];
  readonly stop_reason?: string | null;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
  };
}

export function ingestAnthropicResponse(response: AnthropicResponse): EventPayload<"assistant_message"> {
  const text = (response.content ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
  return {
    content: [{ type: "text", text }],
    text,
    stop_reason: response.stop_reason === "tool_use" ? "tool_use" : "end_turn",
    ...(response.usage !== undefined ? { usage: response.usage } : {}),
  };
}
