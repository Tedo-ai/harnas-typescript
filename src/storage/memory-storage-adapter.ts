import type { EventPayload, EventType, LogEvent, SessionHeader } from "../core/events.js";
import { newSessionId } from "../core/ids.js";
import { createLogEvent } from "../core/log.js";
import type { HeaderWritableStorageAdapter, SessionSnapshot } from "./storage-adapter.js";

export class MemoryStorageAdapter implements HeaderWritableStorageAdapter {
  #header: SessionHeader;
  readonly #events: LogEvent[];

  constructor(snapshot: Partial<SessionSnapshot> = {}) {
    this.#header = snapshot.header ?? { session_id: newSessionId() };
    this.#events = [...(snapshot.events ?? [])];
  }

  async loadSession(): Promise<SessionSnapshot> {
    return { header: this.#header, events: [...this.#events] };
  }

  async appendEvent<TType extends EventType>(
    eventType: TType,
    payload: EventPayload<TType>,
  ): Promise<Extract<LogEvent, { event_type: TType }>> {
    const event = createLogEvent(this.#events.length, eventType, payload);
    this.#events.push(event);
    return event;
  }

  async eventsSince(cursor: number): Promise<readonly LogEvent[]> {
    return this.#events.filter((event) => event.seq > cursor);
  }

  async saveHeader(header: SessionHeader): Promise<void> {
    this.#header = header;
  }
}
