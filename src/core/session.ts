import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventPayload, EventType, LogEvent, SessionHeader } from "./events.js";
import { newSessionId } from "./ids.js";
import { Log } from "./log.js";
import { FileStorageAdapter } from "../storage/file-storage-adapter.js";
import { canSaveHeader } from "../storage/storage-adapter.js";
import type { StorageAdapter } from "../storage/storage-adapter.js";
import { parseSessionJsonl, sessionJsonl } from "../storage/jsonl.js";

export interface SessionOpenOptions {
  readonly path?: string;
  readonly storage?: StorageAdapter;
  readonly header?: SessionHeader;
}

export class Session {
  header: SessionHeader;
  readonly log: Log;
  readonly storage: StorageAdapter | undefined;

  constructor(header: SessionHeader = { session_id: newSessionId() }, log: Log = new Log(), storage?: StorageAdapter) {
    this.header = header;
    this.log = log;
    this.storage = storage;
  }

  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, sessionJsonl({ header: this.header, events: this.log.events() }), "utf8");
  }

  async appendEvent<TType extends EventType>(
    eventType: TType,
    payload: EventPayload<TType>,
  ): Promise<Extract<LogEvent, { event_type: TType }>> {
    if (this.storage === undefined) {
      return this.log.append(eventType, payload);
    }
    const event = await this.storage.appendEvent(eventType, payload);
    this.log.appendExisting(event);
    return event;
  }

  async eventsSince(cursor: number): Promise<readonly LogEvent[]> {
    if (this.storage !== undefined) {
      return this.storage.eventsSince(cursor);
    }
    return this.log.events().filter((event) => event.seq > cursor);
  }

  async updateHeader(header: SessionHeader): Promise<void> {
    this.header = header;
    if (this.storage !== undefined && canSaveHeader(this.storage)) {
      await this.storage.saveHeader(header);
    }
  }

  static async load(path: string): Promise<Session> {
    const adapter = new FileStorageAdapter(path);
    return await Session.open({ storage: adapter });
  }

  static async open(options: SessionOpenOptions = {}): Promise<Session> {
    const storage = options.storage ?? (options.path === undefined ? undefined : new FileStorageAdapter(options.path, options.header));
    if (storage === undefined) {
      return new Session(options.header);
    }
    const snapshot = await storage.loadSession();
    return new Session(snapshot.header, new Log(snapshot.events), storage);
  }

  static fromJsonl(text: string): Session {
    const snapshot = parseSessionJsonl(text);
    return new Session(snapshot.header, new Log(snapshot.events));
  }
}
