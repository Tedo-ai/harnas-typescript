import { newEventId } from "./ids.js";
import type { EventId } from "./ids.js";
import type { EventDraft, EventPayload, EventType, LogEvent, SerializableLogEvent } from "./events.js";
import { normalizeMessagePayload } from "./events.js";

export class Log {
  readonly #events: LogEvent[];

  constructor(events: readonly LogEvent[] = []) {
    this.#events = [...events];
  }

  append<TType extends EventType>(eventType: TType, payload: EventPayload<TType>): Extract<LogEvent, { event_type: TType }> {
    const event = createLogEventFromDraft(this.#events.length, createLogEventDraft(eventType, payload));
    this.#events.push(event);
    return event;
  }

  appendExisting(event: LogEvent): void {
    this.#events.push(event);
  }

  events(): readonly LogEvent[] {
    return [...this.#events];
  }

  serializableEvents(): readonly SerializableLogEvent[] {
    return this.#events.map((event) => ({
      seq: event.seq,
      timestamp: event.timestamp,
      type: event.event_type,
      payload: serializePayload(event.payload),
    })) as readonly SerializableLogEvent[];
  }

  [Symbol.iterator](): Iterator<LogEvent> {
    return this.#events[Symbol.iterator]();
  }
}

export function appendUserMessage(log: Log, text: string): void {
  log.append("user_message", { content: [{ type: "text", text }], text });
}

export function createLogEvent<TType extends EventType>(
  seq: number,
  eventType: TType,
  payload: EventPayload<TType>,
  options: { readonly id?: EventId; readonly timestamp?: string } = {},
): Extract<LogEvent, { event_type: TType }> {
  return createLogEventFromDraft(seq, createLogEventDraft(eventType, payload, options));
}

export function createLogEventDraft<TType extends EventType>(
  eventType: TType,
  payload: EventPayload<TType>,
  options: { readonly id?: EventId; readonly timestamp?: string } = {},
): EventDraft<TType> {
  const normalizedPayload =
    eventType === "user_message" || eventType === "assistant_message"
      ? normalizeMessagePayload(payload)
      : payload;
  return {
    id: options.id ?? newEventId(),
    timestamp: options.timestamp ?? new Date().toISOString(),
    type: eventType,
    payload: normalizedPayload as EventPayload<TType>,
  };
}

export function createLogEventFromDraft<TType extends EventType>(
  seq: number,
  draft: EventDraft<TType>,
): Extract<LogEvent, { event_type: TType }> {
  return {
    seq,
    id: draft.id,
    timestamp: draft.timestamp,
    event_type: draft.type,
    payload: draft.payload,
  } as Extract<LogEvent, { event_type: TType }>;
}

function serializePayload(payload: LogEvent["payload"]): LogEvent["payload"] {
  if ("content" in payload && typeof payload.text === "string") {
    const serialized: Record<string, unknown> = { text: payload.text };
    if (payload.stop_reason !== undefined) {
      serialized.stop_reason = payload.stop_reason;
    }
    if (payload.usage !== undefined) {
      serialized.usage = payload.usage;
    }
    if (payload.provider !== undefined) {
      serialized.provider = payload.provider;
    }
    if (payload.model !== undefined) {
      serialized.model = payload.model;
    }
    if (payload.reasoning !== undefined) {
      serialized.reasoning = payload.reasoning;
    }
    return serialized as LogEvent["payload"];
  }
  return payload;
}
