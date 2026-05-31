import { ConformanceError } from "../core/errors.js";
import type { LogEvent } from "../core/events.js";
import type { Session } from "../core/session.js";

export type SessionResolver = ReadonlyMap<string, Session> | ((sessionId: string) => Session | undefined);

export interface DelegationTreeNode {
  readonly session_id: string;
  readonly children: readonly DelegationTreeChild[];
}

export interface DelegationTreeChild {
  readonly spawn_id: string;
  readonly child_session_id: string;
  readonly task: string;
  readonly join_policy: string;
  readonly metadata: Record<string, unknown>;
  readonly status: string;
  readonly result: unknown;
  readonly error: unknown;
  readonly children: readonly DelegationTreeChild[];
}

export interface DescendantTimelineEvent {
  readonly session_id: string;
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp: string;
}

export interface DescendantUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export function delegationTree(sessionId: string, resolver: SessionResolver): DelegationTreeNode {
  const sessions = normalizeResolver(resolver);
  assertAcyclic(sessions, sessionId);
  const session = requireSession(sessions, sessionId);
  return {
    session_id: sessionId,
    children: session.log.events()
      .filter((event) => event.event_type === "agent_spawn")
      .map((event) => delegationTreeChild(sessions, event.payload)),
  };
}

export function openChildren(sessionId: string, resolver: SessionResolver): readonly string[] {
  const sessions = normalizeResolver(resolver);
  const session = requireSession(sessions, sessionId);
  const completed = new Set(
    session.log.events()
      .filter((event) => event.event_type === "agent_result")
      .map((event) => String(event.payload.spawn_id ?? "")),
  );
  return session.log.events()
    .filter((event) => event.event_type === "agent_spawn")
    .map((event) => String(event.payload.spawn_id ?? ""))
    .filter((spawnId) => !completed.has(spawnId));
}

export function descendantTimeline(sessionId: string, resolver: SessionResolver): readonly DescendantTimelineEvent[] {
  const sessions = normalizeResolver(resolver);
  assertAcyclic(sessions, sessionId);
  const rows: DescendantTimelineEvent[] = [];
  for (const id of descendantSessionIds(sessions, sessionId)) {
    for (const event of requireSession(sessions, id).log.events()) {
      const payload = event.payload as Record<string, unknown>;
      rows.push({
        session_id: id,
        seq: event.seq,
        id: event.id,
        type: event.event_type,
        payload,
        timestamp: typeof payload.timestamp === "string" ? payload.timestamp : event.timestamp,
      });
    }
  }
  return rows.sort((left, right) => {
    const byTimestamp = left.timestamp.localeCompare(right.timestamp);
    if (byTimestamp !== 0) {
      return byTimestamp;
    }
    const bySession = left.session_id.localeCompare(right.session_id);
    if (bySession !== 0) {
      return bySession;
    }
    return left.seq - right.seq;
  });
}

export function descendantUsage(sessionId: string, resolver: SessionResolver): DescendantUsage {
  const sessions = normalizeResolver(resolver);
  assertAcyclic(sessions, sessionId);
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const id of descendantSessionIds(sessions, sessionId)) {
    for (const event of requireSession(sessions, id).log.events()) {
      const payload = event.payload as Record<string, unknown>;
      if (!isRecord(payload.usage)) {
        continue;
      }
      usage.prompt_tokens += numericUsage(payload.usage, "prompt_tokens", "input_tokens");
      usage.completion_tokens += numericUsage(payload.usage, "completion_tokens", "output_tokens");
      usage.total_tokens += numericUsage(payload.usage, "total_tokens");
    }
  }
  return usage;
}

function delegationTreeChild(sessions: (sessionId: string) => Session | undefined, spawn: Record<string, unknown>): DelegationTreeChild {
  const spawnId = String(spawn.spawn_id ?? "");
  const childSessionId = String(spawn.child_session_id ?? "");
  const result = findAgentResult(sessions, spawnId);
  const resultPayload = result?.payload as Record<string, unknown> | undefined;
  return {
    spawn_id: spawnId,
    child_session_id: childSessionId,
    task: String(spawn.task ?? ""),
    join_policy: String(spawn.join_policy ?? "async"),
    metadata: isRecord(spawn.metadata) ? spawn.metadata : {},
    status: String(resultPayload?.status ?? "open"),
    result: resultPayload?.result ?? null,
    error: resultPayload?.error ?? null,
    children: delegationTree(childSessionId, sessions).children,
  };
}

function descendantSessionIds(sessions: (sessionId: string) => Session | undefined, sessionId: string): readonly string[] {
  const ids: string[] = [];
  const visit = (id: string): void => {
    ids.push(id);
    for (const event of requireSession(sessions, id).log.events()) {
      if (event.event_type === "agent_spawn" && typeof event.payload.child_session_id === "string") {
        visit(event.payload.child_session_id);
      }
    }
  };
  visit(sessionId);
  return ids;
}

function findAgentResult(sessions: (sessionId: string) => Session | undefined, spawnId: string): LogEvent | undefined {
  const all = sessions as ((sessionId: string) => Session | undefined) & { readonly all?: () => Iterable<Session> };
  const iterable = all.all?.();
  if (iterable === undefined) {
    return undefined;
  }
  for (const session of iterable) {
    const found = session.log.events().find((event) => event.event_type === "agent_result" && event.payload.spawn_id === spawnId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function assertAcyclic(sessions: (sessionId: string) => Session | undefined, rootSessionId: string): void {
  const active = new Set<string>();
  const seen = new Set<string>();
  const visit = (sessionId: string): void => {
    if (active.has(sessionId)) {
      throw new ConformanceError(`cyclic subagent delegation at session ${sessionId}`);
    }
    if (seen.has(sessionId)) {
      return;
    }
    active.add(sessionId);
    seen.add(sessionId);
    for (const event of requireSession(sessions, sessionId).log.events()) {
      if (event.event_type === "agent_spawn" && typeof event.payload.child_session_id === "string") {
        visit(event.payload.child_session_id);
      }
    }
    active.delete(sessionId);
  };
  visit(rootSessionId);
}

function normalizeResolver(resolver: SessionResolver): ((sessionId: string) => Session | undefined) & { readonly all?: () => Iterable<Session> } {
  if (resolver instanceof Map) {
    const lookup = ((sessionId: string): Session | undefined => resolver.get(sessionId)) as ((sessionId: string) => Session | undefined) & {
      all?: () => Iterable<Session>;
    };
    lookup.all = () => resolver.values();
    return lookup;
  }
  return resolver as ((sessionId: string) => Session | undefined) & { readonly all?: () => Iterable<Session> };
}

function numericUsage(usage: Record<string, unknown>, primary: string, fallback?: string): number {
  const value = usage[primary] ?? (fallback === undefined ? undefined : usage[fallback]);
  return typeof value === "number" ? value : 0;
}

function requireSession(sessions: (sessionId: string) => Session | undefined, sessionId: string): Session {
  const session = sessions(sessionId);
  if (session === undefined) {
    throw new ConformanceError(`projection references missing session ${sessionId}`);
  }
  return session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
