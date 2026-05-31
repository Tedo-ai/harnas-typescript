export type { StorageAdapter, SessionSnapshot } from "../storage/storage-adapter.js";
export { FileStorageAdapter } from "../storage/file-storage-adapter.js";
export { MemoryStorageAdapter } from "../storage/memory-storage-adapter.js";

/**
 * @deprecated Use StorageAdapter for new integrations. LogStore remains as a
 * compatibility wrapper for early harnas-typescript milestones.
 */
export interface LogStore {
  save(session: import("../core/session.js").Session): Promise<void>;
  load(sessionId: string): Promise<import("../core/session.js").Session>;
}
