import type { LogStore } from "./log-store.js";
import type { Session } from "../core/session.js";

export class MemoryLogStore implements LogStore {
  readonly #sessions = new Map<string, Session>();

  async save(session: Session): Promise<void> {
    this.#sessions.set(String(session.header.session_id), session);
  }

  async load(sessionId: string): Promise<Session> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`session not found: ${sessionId}`);
    }
    return session;
  }
}
