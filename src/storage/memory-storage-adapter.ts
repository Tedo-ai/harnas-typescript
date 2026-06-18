import type { EventDraft, EventType, LogEvent, SessionHeader } from "../core/events.js";
import { newSessionId } from "../core/ids.js";
import { createLogEventFromDraft } from "../core/log.js";
import { StorageConflictError, type HeaderWritableStorageAdapter, type SessionSnapshot } from "./storage-adapter.js";

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
    draft: EventDraft<TType>,
    expectedNextSeq?: number,
  ): Promise<Extract<LogEvent, { event_type: TType }>> {
    if (expectedNextSeq !== undefined && expectedNextSeq !== this.#events.length) {
      throw new StorageConflictError(this.#events.length);
    }
    const event = createLogEventFromDraft(this.#events.length, draft);
    this.#events.push(event);
    return event;
  }

  async eventsSince(cursor: number | null): Promise<readonly LogEvent[]> {
    if (cursor === null) {
      return [...this.#events];
    }
    return this.#events.filter((event) => event.seq > cursor);
  }

  async saveHeader(header: SessionHeader): Promise<void> {
    this.#header = header;
  }
}
