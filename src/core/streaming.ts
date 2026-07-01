// §15 streaming transport (delta) events.
//
// These are the token-by-token deltas a live streaming provider emits. Per spec
// §15 (and §13) they are Observation-only — they are NEVER appended to the Log.
// The durable Log receives only the consolidated `assistant_message` / `tool_use`
// events after the stream completes, so Projections are unaffected by streaming.
//
// Ordering within a turn (§15 S2): exactly one `assistant_turn_started`, then
// zero or more text/tool deltas in arrival order, then exactly one of
// `assistant_turn_completed` or `assistant_turn_failed`.

export const STREAM_DELTA_EVENT_TYPES = [
  "assistant_turn_started",
  "assistant_text_delta",
  "tool_use_begin",
  "tool_use_argument_delta",
  "tool_use_end",
  "assistant_turn_completed",
  "assistant_turn_failed",
] as const;

export type StreamDeltaEventType = (typeof STREAM_DELTA_EVENT_TYPES)[number];

const DELTA_SET = new Set<string>(STREAM_DELTA_EVENT_TYPES);

/** True for the §15 transport delta/turn event types (Observation-only). */
export function isStreamDeltaEvent(type: string): type is StreamDeltaEventType {
  return DELTA_SET.has(type);
}

export interface StreamEvent {
  readonly type: StreamDeltaEventType;
  readonly payload: Record<string, unknown>;
}

/** A sink for live delta events — e.g. a chat UI rendering tokens as they arrive. */
export type StreamEventSink = (event: StreamEvent) => void;
