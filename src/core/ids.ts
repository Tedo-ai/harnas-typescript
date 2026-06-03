export type Brand<TName extends string> = string & { readonly __brand: TName };

export type EventId = Brand<"EventId">;
export type SessionId = Brand<"SessionId">;
export type ToolCallId = Brand<"ToolCallId">;

export function brand<TName extends string>(value: string): Brand<TName> {
  return value as Brand<TName>;
}

export function eventIdForSeq(seq: number): EventId {
  return brand<"EventId">(`evt_${String(seq).padStart(6, "0")}`);
}

export function newEventId(): EventId {
  return brand<"EventId">(`evt_${globalThis.crypto.randomUUID().replaceAll("-", "")}`);
}

export function newSessionId(): SessionId {
  return brand<"SessionId">(`ses_${globalThis.crypto.randomUUID().replaceAll("-", "")}`);
}
