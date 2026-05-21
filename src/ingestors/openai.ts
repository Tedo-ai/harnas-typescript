import type { EventPayload } from "../core/events.js";

export interface OpenAIResponse {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

export function ingestOpenAIResponse(response: OpenAIResponse): EventPayload<"assistant_message"> {
  const choice = response.choices?.[0];
  const text = choice?.message?.content ?? "";
  const usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } = {};
  if (response.usage?.prompt_tokens !== undefined) {
    usage.input_tokens = response.usage.prompt_tokens;
  }
  if (response.usage?.completion_tokens !== undefined) {
    usage.output_tokens = response.usage.completion_tokens;
  }
  if (response.usage?.total_tokens !== undefined) {
    usage.total_tokens = response.usage.total_tokens;
  }
  return {
    content: [{ type: "text", text }],
    text,
    stop_reason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
  };
}
