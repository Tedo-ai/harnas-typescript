import { describe, it, expect } from "vitest";

import { ObservationBus } from "../../src/core/observation-bus.js";
import type { Observation } from "../../src/core/observation-bus.js";
import { isStreamDeltaEvent, STREAM_DELTA_EVENT_TYPES } from "../../src/core/streaming.js";
import { runScriptedSession } from "../../src/testing/conformance-runner.js";
import type { ProviderManifest } from "../../src/projections/provider/common.js";

const SPEC = process.env.HARNAS_SPEC ?? "../harnas";
const NO_TOOLS_FIXTURE = `${SPEC}/conformance/agents/with-delta-logger-sidecar`;

describe("§15 stream delta classifier", () => {
  it("classifies exactly the seven transport delta/turn types", () => {
    for (const type of STREAM_DELTA_EVENT_TYPES) {
      expect(isStreamDeltaEvent(type)).toBe(true);
    }
    for (const notDelta of ["assistant_message", "tool_use", "user_message", "tool_result"]) {
      expect(isStreamDeltaEvent(notDelta)).toBe(false);
    }
  });
});

describe("streaming: deltas are Observation-only, consolidated goes to the Log", () => {
  it("routes §15 deltas to the Observation bus + sink, and only the consolidated event to the Log", async () => {
    const manifest = {
      harnas_version: "0.1",
      name: "streaming-unit",
      provider: { kind: "anthropic", model: "m", max_tokens: 1024 },
      tools: [],
      strategies: [],
    } as unknown as ProviderManifest;
    const script = [
      {
        response: [
          { type: "assistant_turn_started", payload: { turn_id: "t1" } },
          { type: "assistant_text_delta", payload: { turn_id: "t1", chunk: "hel" } },
          { type: "assistant_text_delta", payload: { turn_id: "t1", chunk: "lo" } },
          { type: "assistant_turn_completed", payload: { turn_id: "t1", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } } },
          { type: "assistant_message", payload: { text: "hello", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } } },
        ],
      },
    ];

    const bus = new ObservationBus();
    const busDeltas: Observation[] = [];
    bus.subscribe((o) => {
      if (o.type === "stream_event") {
        busDeltas.push(o);
      }
    });
    const sinkDeltas: string[] = [];

    const session = await runScriptedSession(manifest, script, ["hi"], {
      fixturePath: NO_TOOLS_FIXTURE,
      streaming: true,
      observation: bus,
      onStreamEvent: (event) => sinkDeltas.push(event.type),
    });

    // Deltas reached both the Observation bus and the direct sink.
    expect(busDeltas).toHaveLength(4);
    expect(sinkDeltas).toEqual([
      "assistant_turn_started",
      "assistant_text_delta",
      "assistant_text_delta",
      "assistant_turn_completed",
    ]);

    // The Log holds only durable events — no §15 transport deltas.
    const logTypes = session.log.serializableEvents().map((e) => e.type);
    expect(logTypes).toContain("assistant_message");
    for (const deltaType of STREAM_DELTA_EVENT_TYPES) {
      expect(logTypes).not.toContain(deltaType);
    }
  });
});
