import { describe, it, expect } from "vitest";

import { OpenAIStreamProvider } from "../../src/providers/openai-stream.js";
import type { StreamEvent } from "../../src/core/streaming.js";
import { ObservationBus } from "../../src/core/observation-bus.js";
import type { Observation } from "../../src/core/observation-bus.js";
import { runScriptedSession } from "../../src/testing/conformance-runner.js";
import type { ProviderManifest } from "../../src/projections/provider/common.js";

const NO_TOOLS_FIXTURE = `${process.env.HARNAS_SPEC ?? "../harnas"}/conformance/agents/with-delta-logger-sidecar`;

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function mockFetch(chunks: readonly string[]): { fetch: typeof globalThis.fetch; body: () => string } {
  let sentBody = "";
  const fetchImpl = (async (_url: unknown, init: { body?: string }) => {
    sentBody = init.body ?? "";
    return sseResponse(chunks);
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, body: () => sentBody };
}

describe("OpenAIStreamProvider — live SSE text streaming", () => {
  it("emits ordered §15 deltas live and returns the consolidated assistant_message", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: "Hel" }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    ];
    const mock = mockFetch(chunks);
    const provider = new OpenAIStreamProvider({ apiKey: "test", fetch: mock.fetch, turnId: () => "turn_test" });

    const deltas: StreamEvent[] = [];
    const consolidated = await provider.stream(
      { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      (event) => deltas.push(event),
    );

    // The request opted into streaming + usage.
    expect(mock.body()).toContain('"stream":true');
    expect(mock.body()).toContain('"include_usage":true');

    // Deltas arrived live, in §15 order.
    expect(deltas.map((d) => d.type)).toEqual([
      "assistant_turn_started",
      "assistant_text_delta",
      "assistant_text_delta",
      "assistant_turn_completed",
    ]);
    expect(deltas[1]?.payload).toMatchObject({ turn_id: "turn_test", chunk: "Hel" });
    expect(deltas[2]?.payload).toMatchObject({ chunk: "lo" });
    expect(deltas[3]?.payload).toMatchObject({ stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } });

    // The consolidated event for the Log has the full text — no deltas.
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]).toMatchObject({
      type: "assistant_message",
      payload: { text: "Hello", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } },
    });
  });
});

describe("OpenAIStreamProvider — live SSE tool-call streaming", () => {
  it("streams tool_use deltas and consolidates a tool_use with parsed arguments", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"NYC"}' } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    ];
    const provider = new OpenAIStreamProvider({ apiKey: "test", fetch: mockFetch(chunks).fetch, turnId: () => "turn_tool" });

    const deltas: StreamEvent[] = [];
    const consolidated = await provider.stream({ model: "gpt-4o", messages: [] }, (event) => deltas.push(event));

    expect(deltas.map((d) => d.type)).toEqual([
      "assistant_turn_started",
      "tool_use_begin",
      "tool_use_argument_delta",
      "tool_use_argument_delta",
      "tool_use_end",
      "assistant_turn_completed",
    ]);
    expect(deltas[1]?.payload).toMatchObject({ tool_use_id: "call_1", name: "get_weather" });
    expect(deltas[4]?.payload).toMatchObject({ tool_use_id: "call_1", arguments: { city: "NYC" } });

    // Consolidated: an assistant_message (tool_use stop) + the tool_use with parsed args.
    expect(consolidated).toHaveLength(2);
    expect(consolidated[0]).toMatchObject({ type: "assistant_message", payload: { stop_reason: "tool_use" } });
    expect(consolidated[1]).toMatchObject({
      type: "tool_use",
      payload: { id: "call_1", name: "get_weather", arguments: { city: "NYC" } },
    });
  });
});

describe("AgentLoop drives the live OpenAIStreamProvider end-to-end", () => {
  it("streams §15 deltas to the Observation bus and logs only the consolidated assistant_message", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { role: "assistant", content: "Hel" }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    ];
    const provider = new OpenAIStreamProvider({ apiKey: "test", fetch: mockFetch(chunks).fetch, turnId: () => "turn_e2e" });
    const manifest = {
      harnas_version: "0.1",
      name: "e2e-stream",
      provider: { kind: "openai", model: "gpt-4o", max_tokens: 1024 },
      tools: [],
      strategies: [],
    } as unknown as ProviderManifest;

    const bus = new ObservationBus();
    const busDeltas: Observation[] = [];
    bus.subscribe((o) => {
      if (o.type === "stream_event") {
        busDeltas.push(o);
      }
    });

    const session = await runScriptedSession(manifest, [], ["hi"], {
      fixturePath: NO_TOOLS_FIXTURE,
      streaming: true,
      streamProvider: provider,
      observation: bus,
    });

    // Deltas streamed live to the Observation bus.
    expect(busDeltas.map((o) => (o.payload as StreamEvent).type)).toEqual([
      "assistant_turn_started",
      "assistant_text_delta",
      "assistant_text_delta",
      "assistant_turn_completed",
    ]);

    // The Log holds the consolidated turn only — no transport deltas.
    const logTypes = session.log.serializableEvents().map((e) => e.type);
    expect(logTypes).toContain("assistant_message");
    expect(logTypes).not.toContain("assistant_text_delta");
    const assistant = session.log.serializableEvents().find((e) => e.type === "assistant_message");
    expect((assistant?.payload as { text: string }).text).toBe("Hello");
  });
});
