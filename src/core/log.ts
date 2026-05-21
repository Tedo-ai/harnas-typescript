import { eventIdForSeq } from "./ids.js";
import type { EventPayload, EventType, LogEvent, SerializableLogEvent } from "./events.js";
import { normalizeMessagePayload } from "./events.js";

export class Log {
  readonly #events: LogEvent[];

  constructor(events: readonly LogEvent[] = []) {
    this.#events = [...events];
  }

  append<TType extends EventType>(eventType: TType, payload: EventPayload<TType>): Extract<LogEvent, { event_type: TType }> {
    const normalizedPayload =
      eventType === "user_message" || eventType === "assistant_message"
        ? normalizeMessagePayload(payload)
        : payload;
    const event = {
      seq: this.#events.length,
      id: eventIdForSeq(this.#events.length),
      event_type: eventType,
      payload: normalizedPayload,
    } as Extract<LogEvent, { event_type: TType }>;
    this.#events.push(event);
    return event;
  }

  events(): readonly LogEvent[] {
    return [...this.#events];
  }

  serializableEvents(): readonly SerializableLogEvent[] {
    return this.#events.map((event) => ({
      seq: event.seq,
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

function serializePayload(payload: LogEvent["payload"]): LogEvent["payload"] {
  if ("content" in payload && typeof payload.text === "string") {
    const serialized: Record<string, unknown> = { text: payload.text };
    if (payload.stop_reason !== undefined) {
      serialized.stop_reason = payload.stop_reason;
    }
    if (payload.usage !== undefined) {
      serialized.usage = payload.usage;
    }
    return serialized as LogEvent["payload"];
  }
  return payload;
}
