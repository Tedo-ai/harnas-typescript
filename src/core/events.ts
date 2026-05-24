import type { EventId, SessionId } from "./ids.js";
import type { CanonicalUsage } from "./usage.js";

export type StopReason = "end_turn" | "tool_use" | "runtime_error";

export type TokenUsage = CanonicalUsage;

export interface TextContentBlock {
  readonly type: "text";
  readonly text: string;
}

export interface AttachmentSourceBase64 {
  readonly kind: "base64";
  readonly data: string;
}

export interface AttachmentSourceRef {
  readonly kind: "ref";
  readonly uri: string;
}

export interface AttachmentSourceUrl {
  readonly kind: "url";
  readonly url: string;
}

export type AttachmentSource = AttachmentSourceBase64 | AttachmentSourceRef | AttachmentSourceUrl;

export interface ImageContentBlock {
  readonly type: "image";
  readonly media_type: string;
  readonly source: AttachmentSource;
  readonly name?: string;
}

export interface DocumentContentBlock {
  readonly type: "document";
  readonly media_type: string;
  readonly source: AttachmentSource;
  readonly name?: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock | DocumentContentBlock;

export interface MessagePayload {
  readonly content: readonly ContentBlock[];
  readonly text?: string;
  readonly stop_reason?: StopReason;
  readonly usage?: TokenUsage;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: readonly Record<string, unknown>[];
}

export interface UserMessageEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "user_message";
  readonly payload: MessagePayload;
}

export interface AssistantMessageEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "assistant_message";
  readonly payload: MessagePayload;
}

export interface ToolUsePayload {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolUseEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "tool_use";
  readonly payload: ToolUsePayload;
}

export type ApprovalDecision = "accepted" | "rejected" | "auto_accepted" | "yolo" | "edited_then_accepted";

export interface ApprovalMetadata {
  readonly decision: ApprovalDecision;
  readonly rule_matched: string | null;
  readonly applied_diff: string | null;
}

export interface ToolResultPayload {
  readonly name?: string;
  readonly tool_use_id: string;
  readonly output: string | null;
  readonly error: string | null;
  readonly approval?: ApprovalMetadata;
}

export interface ToolResultEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "tool_result";
  readonly payload: ToolResultPayload;
}

export interface RuntimeErrorEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "runtime_error";
  readonly payload: Record<string, unknown>;
}

export interface ProviderErrorEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "provider_error";
  readonly payload: Record<string, unknown>;
}

export interface AnnotationEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "annotation";
  readonly payload: Record<string, unknown>;
}

export interface CompactEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "compact";
  readonly payload: Record<string, unknown>;
}

export interface RevertEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "revert";
  readonly payload: Record<string, unknown>;
}

export interface AgentSpawnEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "agent_spawn";
  readonly payload: Record<string, unknown>;
}

export interface AgentStatusEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "agent_status";
  readonly payload: Record<string, unknown>;
}

export interface AgentResultEvent {
  readonly seq: number;
  readonly id: EventId;
  readonly timestamp: string;
  readonly event_type: "agent_result";
  readonly payload: Record<string, unknown>;
}

export type LogEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ToolUseEvent
  | ToolResultEvent
  | RuntimeErrorEvent
  | ProviderErrorEvent
  | AnnotationEvent
  | CompactEvent
  | RevertEvent
  | AgentSpawnEvent
  | AgentStatusEvent
  | AgentResultEvent;

export type EventType = LogEvent["event_type"];

export type EventPayload<TType extends EventType> = Extract<LogEvent, { event_type: TType }>["payload"];

export interface SerializableLogEvent<TType extends EventType = EventType> {
  readonly seq: number;
  readonly timestamp?: string;
  readonly type: TType;
  readonly payload: EventPayload<TType>;
}

export function normalizeMessagePayload(payload: unknown): MessagePayload {
  if (typeof payload !== "object" || payload === null) {
    return { content: [] };
  }

  const raw = payload as { readonly text?: unknown; readonly content?: unknown };
  if (Array.isArray(raw.content)) {
    return payload as MessagePayload;
  }

  if (typeof raw.text === "string") {
    return { ...(payload as Record<string, unknown>), content: [{ type: "text", text: raw.text }] } as MessagePayload;
  }

  return { ...(payload as Record<string, unknown>), content: [] } as MessagePayload;
}

export function messageText(payload: MessagePayload): string {
  if (payload.text !== undefined) {
    return payload.text;
  }

  return payload.content
    .filter((block): block is TextContentBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export interface SessionHeader {
  readonly session_id: SessionId;
  readonly harnas_version?: string;
  readonly manifest?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly parent_session_id?: SessionId | null;
  readonly root_session_id?: SessionId | null;
  readonly spawn_id?: string | null;
  readonly spawned_by_event_id?: string | null;
  readonly delegation_chain?: readonly Record<string, unknown>[];
}
