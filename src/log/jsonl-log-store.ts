import { join } from "node:path";
import type { LogStore } from "./log-store.js";
import type { Session } from "../core/session.js";
import { Session as HarnasSession } from "../core/session.js";

export class JsonlLogStore implements LogStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async save(session: Session): Promise<void> {
    await session.save(this.pathFor(String(session.header.session_id)));
  }

  async load(sessionId: string): Promise<Session> {
    return HarnasSession.load(this.pathFor(sessionId));
  }

  pathFor(sessionId: string): string {
    return join(this.#root, `${sessionId}.jsonl`);
  }
}
