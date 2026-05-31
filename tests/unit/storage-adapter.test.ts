import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileStorageAdapter, MemoryStorageAdapter, Session, messageText } from "../../src/index.js";

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
    await expect(readFile(path, "utf8")).resolves.toContain('"session"');
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
});
