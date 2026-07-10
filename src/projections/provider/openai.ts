import type { Log } from "../../core/log.js";
import type { ProjectionOptions, ProviderManifest } from "./common.js";
import { messageText } from "../../core/events.js";
import { applyTrailingAssistantPolicy, contentBlocksForOpenAI, hasOnlyText, projectionEvents } from "./common.js";
import { canonicalJson } from "../../core/json.js";
import { carrierWire } from "../../provider-carriers.js";

export interface OpenAIMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: unknown;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: {
      readonly name: string;
      readonly arguments: string;
    };
  }[];
}

export interface OpenAIRequest {
  readonly model: string;
  readonly messages: readonly OpenAIMessage[];
  readonly tools?: readonly {
    readonly type: "function";
    readonly function: {
      readonly name: string;
      readonly description: string;
      readonly parameters: unknown;
    };
  }[];
}

export function projectOpenAIRequest(manifest: ProviderManifest, log: Log, options: ProjectionOptions = {}): OpenAIRequest {
  const messages: OpenAIMessage[] = [];
  if (manifest.system !== undefined && manifest.system.length > 0) {
    messages.push({ role: "system", content: manifest.system });
  }
  const events = projectionEvents(log);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    if (event.event_type === "user_message") {
      messages.push({
        role: "user",
        content: hasOnlyText(event.payload) ? messageText(event.payload) : contentBlocksForOpenAI(event.payload, options),
      });
    } else if (event.event_type === "assistant_message") {
      const carried = carrierWire(event.payload.provider_items, "openai.chat_completions");
      const toolCalls: Array<NonNullable<OpenAIMessage["tool_calls"]>[number]> = [];
      let scan = index + 1;
      while (events[scan]?.event_type === "tool_use") {
        const toolUse = events[scan];
        if (toolUse?.event_type === "tool_use") {
          toolCalls.push({
            id: toolUse.payload.id,
            type: "function",
            function: {
              name: toolUse.payload.name,
              arguments: canonicalJson(toolUse.payload.arguments),
            },
          });
        }
        scan += 1;
      }
      if (toolCalls.length > 0) {
        const text = messageText(event.payload);
        messages.push({
          ...(isOpenAIMessage(carried) ? carried : { role: "assistant", content: text.length > 0 ? text : null }),
          role: "assistant",
          tool_calls: toolCalls,
        });
      } else {
        messages.push(isOpenAIMessage(carried) ? carried : { role: "assistant", content: messageText(event.payload) });
      }
    } else if (event.event_type === "tool_result") {
      messages.push({
        role: "tool",
        tool_call_id: event.payload.tool_use_id,
        content: event.payload.output ?? event.payload.error ?? "",
      });
    }
  }

  applyTrailingAssistantPolicy(
    messages,
    options.onTrailingAssistant,
    (message) => message.role === "assistant",
    (text): OpenAIMessage => ({ role: "user", content: text }),
  );
  const request: OpenAIRequest = {
    model: manifest.provider.model,
    messages,
  };
  const tools = openAITools(manifest);
  if (tools.length > 0) {
    return { ...request, tools };
  }
  return request;
}

function isOpenAIMessage(value: unknown): value is OpenAIMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (value as { role?: unknown }).role === "assistant";
}

function openAITools(manifest: ProviderManifest): NonNullable<OpenAIRequest["tools"]> {
  return (manifest.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.input_schema ?? { type: "object", properties: {} },
    },
  }));
}
