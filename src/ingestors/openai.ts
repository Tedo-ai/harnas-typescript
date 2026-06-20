import type { EventPayload } from "../core/events.js";
import { normalizeUsage } from "../core/usage.js";
import { providerCarrier } from "../provider-carriers.js";

export interface OpenAIResponse {
  readonly model?: string;
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly reasoning?: string;
      readonly reasoning_details?: readonly Record<string, unknown>[];
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

type OpenAIMessage = NonNullable<NonNullable<OpenAIResponse["choices"]>[number]["message"]>;

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
  const reasoning = openAIReasoning(message);
  const hasCarrierData = (message?.reasoning_details ?? []).some(reasoningDetailHasCarrierData);
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
        ...(reasoning.length > 0 ? { reasoning } : {}),
        ...(hasCarrierData && text.length > 0
          ? {
              content: [{
                type: "text",
                text,
                provider_parts: [
                  providerCarrier({
                    destination: "openai.chat_completions",
                    index: 0,
                    kind: "openai.message_content",
                    wire: { content: text },
                    canonicalRefs: ["payload.content[0]"],
                  }),
                ],
              }],
            }
          : {}),
        ...(hasCarrierData && message !== undefined
          ? {
              provider_items: [
                providerCarrier({
                  destination: "openai.chat_completions",
                  index: 0,
                  kind: "openai.chat_message",
                  wire: message,
                  canonicalRefs: [
                    ...(text.length > 0 ? ["payload.content[0]"] : []),
                    "payload.reasoning[0]",
                  ],
                }),
              ],
            }
          : {}),
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

function openAIReasoning(message: OpenAIMessage | undefined): readonly Record<string, unknown>[] {
  if (typeof message?.reasoning === "string") {
    return [{ type: "text", text: message.reasoning }];
  }
  const details = message?.reasoning_details ?? [];
  return details
    .filter((item) => typeof item.text === "string")
    .map((item, index) => ({
      type: "text",
      text: item.text ?? "",
      ...(reasoningDetailHasCarrierData(item)
        ? {
            provider_parts: [
              providerCarrier({
                destination: "openai.chat_completions",
                index,
                kind: "openai.reasoning_detail",
                wire: item,
                canonicalRefs: [`payload.reasoning[${index}]`],
              }),
            ],
          }
        : {}),
    }));
}

function reasoningDetailHasCarrierData(detail: Record<string, unknown>): boolean {
  return Object.keys(detail).some((key) => !["type", "text", "reasoning", "content"].includes(key));
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
