import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileStorageAdapter, MemoryStorageAdapter, Session, createLogEventDraft, messageText } from "../../src/index.js";

describe("StorageAdapter", () => {
  it("persists appended events and supports seq cursors", async () => {
    const storage = new MemoryStorageAdapter();
    const session = await Session.open({ storage });

    await session.appendEvent("user_message", { content: [{ type: "text", text: "hello" }] });
    await session.appendEvent("assistant_message", {
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
    });

    const recent = await session.eventsSince(0);
    expect(recent.map((event) => event.seq)).toEqual([1]);
    expect(recent[0]?.event_type).toBe("assistant_message");
  });

  it("keeps file-backed storage as the default adapter path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harnas-typescript-storage-"));
    const path = join(dir, "session.jsonl");
    const session = await Session.open({ path });

    await session.appendEvent("user_message", { content: [{ type: "text", text: "from disk" }] });
    const loaded = await Session.load(path);
    const [event] = loaded.log.events();

    expect(event?.event_type).toBe("user_message");
    expect(event?.event_type === "user_message" ? messageText(event.payload) : "").toBe("from disk");
    await expect(readFile(path, "utf8")).resolves.toContain('"__session__"');
  });

  it("persists header updates through adapters", async () => {
    const storage = new FileStorageAdapter(join(await mkdtemp(join(tmpdir(), "harnas-typescript-header-")), "session.jsonl"));
    const session = await Session.open({ storage });

    await session.updateHeader({
      ...session.header,
      metadata: { story_uid: "story-123" },
    });

    const reloaded = await Session.open({ storage });
    expect(reloaded.header.metadata).toEqual({ story_uid: "story-123" });
  });

  it("preserves EventDraft id and timestamp while assigning seq", async () => {
    const storage = new MemoryStorageAdapter();
    const draft = createLogEventDraft(
      "user_message",
      { content: [{ type: "text", text: "known" }] },
      { timestamp: "2026-06-01T00:00:00.000Z" },
    );

    const event = await storage.appendEvent(draft);
    const [loaded] = await storage.eventsSince(-1);

    expect(event.seq).toBe(0);
    expect(event.id).toBe(draft.id);
    expect(event.timestamp).toBe("2026-06-01T00:00:00.000Z");
    expect(loaded?.id).toBe(draft.id);
    expect(loaded?.timestamp).toBe("2026-06-01T00:00:00.000Z");
  });

  it("fails loudly on a torn final event row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harnas-typescript-torn-"));
    const path = join(dir, "session.jsonl");
    await writeFile(
      path,
      [
        '{"__session__":true,"id":"ses_test","metadata":{}}',
        '{"seq":0,"id":"evt_0","timestamp":"2026-06-01T00:00:00Z","type":"user_message","payload":{"text":"a"}}',
        '{"seq":1,"id":"evt_1","timestamp":"2026-06-01T00:00:01Z","type":"user_message","payload":{"text":"b"}',
      ].join("\n"),
      "utf8",
    );

    await expect(Session.load(path)).rejects.toThrow();
  });

  it("rejects duplicate, gapped, and reordered seq rows", async () => {
    const cases = [
      [
        '{"seq":0,"id":"evt_0","timestamp":"2026-06-01T00:00:00Z","type":"user_message","payload":{"text":"a"}}',
        '{"seq":0,"id":"evt_dup","timestamp":"2026-06-01T00:00:01Z","type":"user_message","payload":{"text":"b"}}',
      ],
      [
        '{"seq":0,"id":"evt_0","timestamp":"2026-06-01T00:00:00Z","type":"user_message","payload":{"text":"a"}}',
        '{"seq":2,"id":"evt_2","timestamp":"2026-06-01T00:00:01Z","type":"user_message","payload":{"text":"b"}}',
      ],
      [
        '{"seq":1,"id":"evt_1","timestamp":"2026-06-01T00:00:00Z","type":"user_message","payload":{"text":"a"}}',
        '{"seq":0,"id":"evt_0","timestamp":"2026-06-01T00:00:01Z","type":"user_message","payload":{"text":"b"}}',
      ],
    ];

    for (const rows of cases) {
      const dir = await mkdtemp(join(tmpdir(), "harnas-typescript-seq-"));
      const path = join(dir, "session.jsonl");
      await writeFile(
        path,
        ['{"__session__":true,"id":"ses_test","metadata":{}}', ...rows].join("\n") + "\n",
        "utf8",
      );

      await expect(Session.load(path)).rejects.toThrow(/invalid event seq/);
    }
  });
});
