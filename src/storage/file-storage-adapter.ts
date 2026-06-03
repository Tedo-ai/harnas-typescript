import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventDraft, EventType, LogEvent, SessionHeader } from "../core/events.js";
import { newSessionId } from "../core/ids.js";
import { createLogEventFromDraft } from "../core/log.js";
import { parseSessionJsonl, sessionJsonl } from "./jsonl.js";
import type { HeaderWritableStorageAdapter, SessionSnapshot } from "./storage-adapter.js";

export class FileStorageAdapter implements HeaderWritableStorageAdapter {
  readonly #path: string;
  readonly #initialHeader: SessionHeader;

  constructor(path: string, header: SessionHeader = { session_id: newSessionId() }) {
    this.#path = path;
    this.#initialHeader = header;
  }

  async loadSession(): Promise<SessionSnapshot> {
    try {
      return parseSessionJsonl(await readFile(this.#path, "utf8"));
    } catch (error) {
      if (isMissingFileError(error)) {
        const snapshot = { header: this.#initialHeader, events: [] };
        await this.#write(snapshot);
        return snapshot;
      }
      throw error;
    }
  }

  async appendEvent<TType extends EventType>(
    draft: EventDraft<TType>,
  ): Promise<Extract<LogEvent, { event_type: TType }>> {
    const snapshot = await this.loadSession();
    const event = createLogEventFromDraft(snapshot.events.length, draft);
    await this.#write({ header: snapshot.header, events: [...snapshot.events, event] });
    return event;
  }

  async eventsSince(cursor: number): Promise<readonly LogEvent[]> {
    const snapshot = await this.loadSession();
    return snapshot.events.filter((event) => event.seq > cursor);
  }

  async saveHeader(header: SessionHeader): Promise<void> {
    const snapshot = await this.loadSession();
    await this.#write({ header, events: snapshot.events });
  }

  async #write(snapshot: SessionSnapshot): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, sessionJsonl(snapshot), "utf8");
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
