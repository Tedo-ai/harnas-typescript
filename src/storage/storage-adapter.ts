import type { EventPayload, EventType, LogEvent, SessionHeader } from "../core/events.js";

export interface SessionSnapshot {
  readonly header: SessionHeader;
  readonly events: readonly LogEvent[];
}

export interface StorageAdapter {
  loadSession(): Promise<SessionSnapshot>;
  appendEvent<TType extends EventType>(
    eventType: TType,
    payload: EventPayload<TType>,
  ): Promise<Extract<LogEvent, { event_type: TType }>>;
  eventsSince(cursor: number): Promise<readonly LogEvent[]>;
}

export interface HeaderWritableStorageAdapter extends StorageAdapter {
  saveHeader(header: SessionHeader): Promise<void>;
}

export function canSaveHeader(adapter: StorageAdapter): adapter is HeaderWritableStorageAdapter {
  return "saveHeader" in adapter && typeof adapter.saveHeader === "function";
}
