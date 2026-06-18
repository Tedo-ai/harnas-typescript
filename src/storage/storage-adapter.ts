import type { EventDraft, EventType, LogEvent, SessionHeader } from "../core/events.js";

export interface SessionSnapshot {
  readonly header: SessionHeader;
  readonly events: readonly LogEvent[];
}

export interface StorageAdapter {
  loadSession(): Promise<SessionSnapshot>;
  appendEvent<TType extends EventType>(
    draft: EventDraft<TType>,
    expectedNextSeq?: number,
  ): Promise<Extract<LogEvent, { event_type: TType }>>;
  eventsSince(cursor: number | null): Promise<readonly LogEvent[]>;
}

export interface HeaderWritableStorageAdapter extends StorageAdapter {
  saveHeader(header: SessionHeader): Promise<void>;
}

export function canSaveHeader(adapter: StorageAdapter): adapter is HeaderWritableStorageAdapter {
  return "saveHeader" in adapter && typeof adapter.saveHeader === "function";
}

export class StorageConflictError extends Error {
  readonly reason = "storage_conflict";

  constructor(readonly current_next_seq: number) {
    super(`storage_conflict: current next seq ${current_next_seq}`);
  }
}
