import { describe, expect, it } from "vitest";
import { Log, appendUserMessage, messageText } from "../../src/index.js";

describe("Log", () => {
  it("appends legacy-compatible text messages as content blocks", () => {
    const log = new Log();
    appendUserMessage(log, "hello");
    const [event] = log.events();

    expect(event?.event_type).toBe("user_message");
    expect(event?.payload).toEqual({
      content: [{ type: "text", text: "hello" }],
      text: "hello",
    });
    expect(event?.event_type === "user_message" ? messageText(event.payload) : "").toBe("hello");
  });
});
