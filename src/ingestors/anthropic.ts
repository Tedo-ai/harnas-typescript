import type { EventPayload, StopReason } from "../core/events.js";
import { normalizeUsage } from "../core/usage.js";
import { providerCarrier } from "../provider-carriers.js";

export interface AnthropicContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly signature?: string;
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
  const reasoning = (response.content ?? [])
    .filter((block) => block.type === "thinking" && typeof block.thinking === "string")
    .map((block) => ({
      type: "text",
      text: block.thinking ?? "",
      ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
      ...(typeof block.signature === "string"
        ? {
            provider_parts: [
              providerCarrier({
                destination: "anthropic.messages",
                index: 0,
                kind: "anthropic.content_block",
                wire: block,
                canonicalRefs: ["payload.reasoning[0]"],
              }),
            ],
          }
        : {}),
    }));
  const hasCarrierData = (response.content ?? []).some((block) => block.type === "thinking" && typeof block.signature === "string");
  const carrierContent = (response.content ?? []).filter((block) => block.type !== "tool_use");
  const events: Array<
    | { readonly type: "assistant_message"; readonly payload: EventPayload<"assistant_message"> }
    | { readonly type: "tool_use"; readonly payload: EventPayload<"tool_use"> }
  > = [
    {
      type: "assistant_message",
      payload: ({
        ...(!hasCarrierData || text.length > 0 ? { content: [{ type: "text" as const, text }] } : {}),
        text,
        stop_reason: anthropicStopReason(response.stop_reason),
        usage: normalizeUsage(response.usage),
        provider: "anthropic",
        ...(response.model !== undefined ? { model: response.model } : {}),
        ...(reasoning.length > 0 ? { reasoning } : {}),
        ...(hasCarrierData && text.length > 0
          ? {
              content: [{
                type: "text",
                text,
                provider_parts: [
                  providerCarrier({
                    destination: "anthropic.messages",
                    index: 0,
                    kind: "anthropic.content_block",
                    wire: { type: "text", text },
                    canonicalRefs: ["payload.content[0]"],
                  }),
                ],
              }],
            }
          : {}),
        ...(hasCarrierData && carrierContent.length > 0
          ? {
              provider_items: [
                providerCarrier({
                  destination: "anthropic.messages",
                  index: 0,
                  kind: "anthropic.content",
                  wire: carrierContent,
                  canonicalRefs: [
                    "payload.reasoning[0]",
                    ...(text.length > 0 ? ["payload.content[0]"] : []),
                  ],
                }),
              ],
            }
          : {}),
      }) as EventPayload<"assistant_message">,
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

function anthropicStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "end_turn" || reason === undefined || reason === null) return "end_turn";
  return "other";
}
