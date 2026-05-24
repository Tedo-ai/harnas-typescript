import type { Log } from "../../core/log.js";
import type { ProjectionOptions, ProviderManifest } from "./common.js";
import { hasOnlyText } from "./common.js";
import { messageText } from "../../core/events.js";

export interface GeminiRequest {
  readonly model: string;
  readonly contents: readonly {
    readonly role: "user" | "model";
    readonly parts: readonly unknown[];
  }[];
  readonly systemInstruction?: { readonly parts: readonly { readonly text: string }[] };
  readonly generationConfig: { readonly thinkingConfig: { readonly thinkingBudget: 0 } };
  readonly tools?: readonly {
    readonly functionDeclarations: readonly {
      readonly name: string;
      readonly description: string;
      readonly parameters: unknown;
    }[];
  }[];
}

export function projectGeminiRequest(manifest: ProviderManifest, log: Log, options: ProjectionOptions = {}): GeminiRequest {
  const contents: GeminiRequest["contents"][number][] = [];
  for (const event of log.events()) {
    if (event.event_type === "user_message") {
      contents.push({ role: "user", parts: geminiParts(event.payload, options) });
    } else if (event.event_type === "assistant_message") {
      contents.push({ role: "model", parts: messageText(event.payload).length > 0 ? [{ text: messageText(event.payload) }] : [] });
    } else if (event.event_type === "tool_result") {
      const toolUse = log.events().find((candidate) => candidate.event_type === "tool_use" && candidate.payload.id === event.payload.tool_use_id);
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: toolUse?.event_type === "tool_use" ? toolUse.payload.name : event.payload.tool_use_id,
              response: { result: event.payload.output ?? event.payload.error ?? "" },
            },
          },
        ],
      });
    }
  }
  return {
    model: manifest.provider.model,
    contents,
    ...(manifest.system !== undefined && manifest.system.length > 0
      ? { systemInstruction: { parts: [{ text: manifest.system }] } }
      : {}),
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    ...((manifest.tools ?? []).length > 0
      ? {
          tools: [
            {
              functionDeclarations: (manifest.tools ?? []).map((tool) => ({
                name: tool.name,
                description: tool.description ?? "",
                parameters: tool.input_schema ?? { type: "object", properties: {} },
              })),
            },
          ],
        }
      : {}),
  };
}

function geminiParts(payload: Parameters<typeof hasOnlyText>[0], _options: ProjectionOptions): unknown[] {
  if (hasOnlyText(payload)) {
    return [{ text: messageText(payload) }];
  }
  return payload.content.map((block) => {
    if (block.type === "text") {
      return { text: block.text };
    }
    if (block.type === "image" || block.type === "document") {
      return {
        inline_data: {
          mime_type: block.media_type,
          data: block.source.kind === "base64" ? block.source.data : "",
        },
      };
    }
    return {};
  });
}
