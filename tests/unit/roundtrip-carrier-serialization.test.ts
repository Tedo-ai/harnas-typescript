import { describe, it, expect } from "vitest";
import { ingestAnthropicResponseEvents } from "../../src/ingestors/anthropic.js";
import { Log } from "../../src/core/log.js";

// Regression guard for the cross-language round-trip bug where a TS-written
// session for a reasoning/carrier fixture dropped the assistant message's
// `content` field. The omission routed sibling loaders (Go/Ruby/Python) down
// their carrier-preservation path, surfacing the loaded integers as strings and
// failing the round-trip diff. The persisted carrier payload must keep `content`
// and emit integer fields as JSON numbers.
describe("carrier assistant message serialization", () => {
  const response = {
    model: "claude-test",
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "Consider the prompt carefully.", signature: "sig_roundtrip_reasoning" },
      { type: "text", text: "first answer" },
    ],
    usage: { input_tokens: 3, output_tokens: 4 },
  };

  it("retains content and numeric integers for a reasoning payload", () => {
    const [assistant] = ingestAnthropicResponseEvents(response);
    const log = new Log();
    log.append("assistant_message", assistant.payload);
    const [serialized] = log.serializableEvents();
    const payload = serialized.payload as Record<string, unknown>;

    expect(payload.content).toBeDefined();
    expect(payload.provider_items).toBeDefined();

    const usage = payload.usage as Record<string, unknown>;
    expect(typeof usage.input_tokens).toBe("number");
    const providerItems = payload.provider_items as Array<Record<string, unknown>>;
    expect(typeof providerItems[0]?.index).toBe("number");

    const json = JSON.stringify(payload);
    expect(json).toContain('"input_tokens":3');
    expect(json).toContain('"index":0');
    expect(json).not.toContain('"input_tokens":"3"');
    expect(json).not.toContain('"index":"0"');
  });
});
