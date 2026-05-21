import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogEvent, SessionHeader } from "./events.js";
import { normalizeMessagePayload } from "./events.js";
import { newSessionId } from "./ids.js";
import { Log } from "./log.js";
import { jsonlString } from "./json.js";

export class Session {
  readonly header: SessionHeader;
  readonly log: Log;

  constructor(header: SessionHeader = { session_id: newSessionId() }, log: Log = new Log()) {
    this.header = header;
    this.log = log;
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const lines = [{ session: this.header }, ...this.log.serializableEvents()];
    await writeFile(path, jsonlString(lines), "utf8");
  }

  static async load(path: string): Promise<Session> {
    const text = await readFile(path, "utf8");
    const rows = text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const headerRow = rows.shift();
    const header = (headerRow?.session ?? { session_id: newSessionId() }) as SessionHeader;
    const events = rows.map((row) => {
      const event = row as unknown as LogEvent;
      if (event.event_type === "user_message" || event.event_type === "assistant_message") {
        return { ...event, payload: normalizeMessagePayload(event.payload) } as LogEvent;
      }
      return event;
    });
    return new Session(header, new Log(events));
  }
}
