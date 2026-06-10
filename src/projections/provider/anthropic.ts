import type { Log } from "../../core/log.js";
import type { ProjectionOptions, ProviderManifest } from "./common.js";
import { contentBlocksForAnthropic, hasOnlyText, projectionEvents, textTurns } from "./common.js";
import type { ProjectionEvent } from "./common.js";
import type { ToolUseEvent } from "../../core/events.js";
import { messageText } from "../../core/events.js";

export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: unknown;
}

export interface AnthropicRequest {
  readonly model: string;
  readonly messages: readonly AnthropicMessage[];
  readonly max_tokens?: number;
  readonly system?: string;
  readonly tools?: readonly {
    readonly name: string;
    readonly description: string;
    readonly input_schema: unknown;
  }[];
}

export function projectAnthropicRequest(manifest: ProviderManifest, log: Log, options: ProjectionOptions = {}): AnthropicRequest {
  return {
    model: manifest.provider.model,
    messages: anthropicTurns(log, options),
    ...(manifest.provider.max_tokens !== undefined ? { max_tokens: manifest.provider.max_tokens } : {}),
    ...(manifest.system !== undefined && manifest.system.length > 0 ? { system: manifest.system } : {}),
    ...((manifest.tools ?? []).length > 0 ? { tools: anthropicTools(manifest) } : {}),
  };
}

function anthropicTurns(log: Log, options: ProjectionOptions): AnthropicMessage[] {
  const turns: AnthropicMessage[] = [];
  const events = projectionEvents(log);
  for (const event of events) {
    if (event.event_type === "user_message") {
      pushAnthropicTurn(turns, {
        role: "user",
        content: hasOnlyText(event.payload) ? messageText(event.payload) : contentBlocksForAnthropic(event.payload, options),
      });
    } else if (event.event_type === "assistant_message") {
      const toolUses = followingToolUses(events, event.seq);
      if (event.payload.reasoning !== undefined || toolUses.length > 0) {
        const text = messageText(event.payload);
        pushAnthropicTurn(turns, {
          role: "assistant",
          content: [
            ...(event.payload.reasoning ?? []).map((item) => ({
              type: "thinking",
              thinking: typeof item.text === "string" ? item.text : "",
              ...(typeof item.signature === "string" ? { signature: item.signature } : {}),
            })),
            ...(text.length > 0 ? [{ type: "text", text }] : []),
            ...toolUses.map((toolUse) => ({
              type: "tool_use",
              id: toolUse.payload.id,
              name: toolUse.payload.name,
              input: toolUse.payload.arguments,
            })),
          ],
        });
      } else {
        const text = messageText(event.payload);
        if (text.length > 0) {
          pushAnthropicTurn(turns, { role: "assistant", content: text });
        }
      }
    } else if (event.event_type === "tool_result") {
      const content: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: event.payload.tool_use_id,
        content: event.payload.output ?? event.payload.error ?? "",
      };
      if (event.payload.error !== null && event.payload.error !== undefined) {
        content.is_error = true;
      }
      pushAnthropicTurn(turns, {
        role: "user",
        content: [content],
      });
    }
  }
  return turns.length > 0 ? turns : textTurns(log);
}

function pushAnthropicTurn(turns: AnthropicMessage[], next: AnthropicMessage): void {
  const previous = turns.at(-1);
  if (previous?.role !== next.role) {
    turns.push(next);
    return;
  }
  turns[turns.length - 1] = {
    role: previous.role,
    content: [...anthropicContentBlocks(previous.content), ...anthropicContentBlocks(next.content)],
  };
}

function anthropicContentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) {
    return content;
  }
  return [{ type: "text", text: String(content) }];
}

function followingToolUses(events: readonly ProjectionEvent[], seq: number): ToolUseEvent[] {
  return events.filter((event): event is ToolUseEvent => event.event_type === "tool_use" && event.seq === seq + 1);
}

function anthropicTools(manifest: ProviderManifest): NonNullable<AnthropicRequest["tools"]> {
  return (manifest.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    input_schema: tool.input_schema ?? { type: "object", properties: {} },
  }));
}
