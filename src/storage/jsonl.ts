import { eventIdForSeq } from "../core/ids.js";
import type { EventPayload, EventType, LogEvent, SessionHeader } from "../core/events.js";
import { normalizeMessagePayload } from "../core/events.js";
import { jsonlString } from "../core/json.js";
import type { SessionSnapshot } from "./storage-adapter.js";

export function parseSessionJsonl(text: string): SessionSnapshot {
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const headerRow = rows.shift();
  const header = parseHeader(headerRow);
  const events = rows.map((row, index) => parseEventRow(row, index));
  return { header, events };
}

export function sessionJsonl(snapshot: SessionSnapshot): string {
  const { session_id, ...headerRest } = snapshot.header;
  return jsonlString([
    { __session__: true, id: session_id, ...headerRest },
    ...snapshot.events.map((event) => ({
      seq: event.seq,
      id: event.id,
      timestamp: event.timestamp,
      type: event.event_type,
      payload: event.payload,
    })),
  ]);
}

function parseHeader(row: Record<string, unknown> | undefined): SessionHeader {
  if (row === undefined) {
    throw new Error("session JSONL is missing a header row");
  }
  if (row.__session__ === true) {
    const { __session__, id, ...rest } = row;
    return { session_id: String(id), ...rest } as SessionHeader;
  }
  if (typeof row.session === "object" && row.session !== null) {
    return row.session as SessionHeader;
  }
  throw new Error("session JSONL header row must contain a session object");
}

function parseEventRow(row: Record<string, unknown>, index: number): LogEvent {
  const seq = Number(row.seq);
  if (seq !== index) {
    throw new Error(`invalid event seq at row ${index}: got ${String(row.seq)}, want ${index}`);
  }
  const eventType = String(row.event_type ?? row.type) as EventType;
  const payload = normalizePayload(eventType, row.payload) as EventPayload<EventType>;
  return {
    seq,
    id: typeof row.id === "string" ? row.id : eventIdForSeq(seq),
    timestamp: typeof row.timestamp === "string" ? row.timestamp : new Date(0).toISOString(),
    event_type: eventType,
    payload,
  } as LogEvent;
}

function normalizePayload(eventType: EventType, payload: unknown): unknown {
  if (eventType === "user_message" || eventType === "assistant_message") {
    return normalizeMessagePayload(payload);
  }
  return payload;
}
