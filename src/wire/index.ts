/**
 * `@tedo-ai/harnas-typescript/wire` — the pure wire surface.
 *
 * A deliberately light entry point: payload/event/stream **types** and the
 * **pure functions** that construct or read them, with a transitive import
 * graph free of Node built-ins (no `node:fs`, no `child_process`) and no
 * side effects. Import it eagerly from anywhere — servers, edge runtimes,
 * browser code — so consumers never hand-copy Harnas payload shapes.
 *
 * (Tedo-ai/harnas-typescript#18. The root entry pulls in the runtime,
 * builtins, and providers, which touch Node built-ins; this subpath does
 * not.)
 */

// Payload construction + reading (pure).
export {
  messageText,
  normalizeMessagePayload,
  userMessagePayload,
} from "../core/events.js";

// Canonical event/payload types.
export type {
  ContentBlock,
  DocumentContentBlock,
  ImageContentBlock,
  TextContentBlock,
  MessagePayload,
  ToolUsePayload,
  ToolResultPayload,
  ApprovalMetadata,
  LogEvent,
  EventDraft,
  EventType,
  EventPayload,
  SerializableLogEvent,
  SessionHeader,
} from "../core/events.js";

export type { EventId, SessionId, ToolCallId } from "../core/ids.js";

// Usage shape + normalizer (pure).
export { normalizeUsage } from "../core/usage.js";
export type { CanonicalUsage, UsageProvenance } from "../core/usage.js";

// §15 streaming delta vocabulary (types only).
export type { StreamDeltaEventType, StreamEvent, StreamEventSink } from "../core/streaming.js";

// Provider failure taxonomy (pure; no transport).
export { classifyProviderStatus, ProviderError } from "../core/errors.js";
export type { ProviderErrorClass, ProviderErrorOptions } from "../core/errors.js";
