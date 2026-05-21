import type { Session } from "../core/session.js";

export interface LogStore {
  save(session: Session): Promise<void>;
  load(sessionId: string): Promise<Session>;
}
