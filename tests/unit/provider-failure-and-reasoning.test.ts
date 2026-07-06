import { describe, it, expect } from "vitest";

import { OpenAIStreamProvider } from "../../src/providers/openai-stream.js";
import { OpenAIProvider } from "../../src/providers/openai.js";
import { classifyProviderStatus, ProviderError } from "../../src/core/errors.js";
import { normalizeUsage } from "../../src/core/usage.js";

// Battle-test feedback from the Bidvise AI integration:
// - Tedo-ai/harnas#7: failed provider calls must carry status + body detail.
// - Tedo-ai/harnas-typescript#16: reasoning models can spend the whole
//   completion budget on reasoning; token counts and reasoning text must
//   survive the stream path.

function errorFetch(status: number, body: string): typeof globalThis.fetch {
  return (async () => new Response(body, { status })) as unknown as typeof globalThis.fetch;
}

function sseFetch(chunks: readonly string[]): typeof globalThis.fetch {
  const encoder = new TextEncoder();
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

describe("provider failure detail (harnas#7)", () => {
  it("stream errors carry status, body excerpt, and class", async () => {
    const provider = new OpenAIStreamProvider({
      apiKey: "test",
      fetch: errorFetch(400, '{"error":{"message":"This model does not support assistant message prefill"}}'),
    });
    let caught: unknown;
    try {
      await provider.stream({ model: "m", messages: [] }, () => {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    const providerError = caught as ProviderError;
    expect(providerError.status).toBe(400);
    expect(providerError.errorClass).toBe("invalid_request");
    expect(providerError.detail).toContain("assistant message prefill");
    expect(providerError.message).toContain("assistant message prefill");
  });

  it("buffered errors carry the same structure; 429 classifies as rate_limit", async () => {
    const provider = new OpenAIProvider({ apiKey: "test", fetch: errorFetch(429, "slow down") });
    let caught: unknown;
    try {
      await provider.complete({ model: "m", messages: [] } as never);
    } catch (error) {
      caught = error;
    }
    const providerError = caught as ProviderError;
    expect(providerError.status).toBe(429);
    expect(providerError.errorClass).toBe("rate_limit");
    expect(providerError.detail).toBe("slow down");
  });

  it("classifies the coarse taxonomy from status", () => {
    expect(classifyProviderStatus(429)).toBe("rate_limit");
    expect(classifyProviderStatus(401)).toBe("auth");
    expect(classifyProviderStatus(403)).toBe("auth");
    expect(classifyProviderStatus(408)).toBe("timeout");
    expect(classifyProviderStatus(503)).toBe("overloaded");
    expect(classifyProviderStatus(529)).toBe("overloaded");
    expect(classifyProviderStatus(400)).toBe("invalid_request");
    expect(classifyProviderStatus(500)).toBe("provider_error");
  });
});

describe("stream reasoning visibility (harnas-typescript#16)", () => {
  it("reasoning token details survive the stream into normalized usage", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 83,
          completion_tokens_details: { reasoning_tokens: 82 },
        },
      }),
    ];
    const provider = new OpenAIStreamProvider({ apiKey: "test", fetch: sseFetch(chunks) });
    const consolidated = await provider.stream({ model: "m", messages: [] }, () => {});
    const assistant = consolidated[0] as { payload: { usage: Record<string, unknown> } };

    const normalized = normalizeUsage(assistant.payload.usage);
    expect(normalized.output_tokens).toBe(83);
    expect(normalized.reasoning_tokens).toBe(82);
  });

  it("accumulates delta.reasoning into the consolidated assistant_message", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { role: "assistant", reasoning: "Consider " }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { reasoning: "carefully." }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: "Answer." }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    ];
    const provider = new OpenAIStreamProvider({ apiKey: "test", fetch: sseFetch(chunks) });
    const consolidated = await provider.stream({ model: "m", messages: [] }, () => {});
    const assistant = consolidated[0] as {
      payload: { text: string; reasoning?: readonly { type: string; text: string }[] };
    };

    expect(assistant.payload.text).toBe("Answer.");
    expect(assistant.payload.reasoning).toEqual([{ type: "text", text: "Consider carefully." }]);
  });

  it("omits reasoning when the model produced none (shape unchanged)", async () => {
    const chunks = [
      JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }] }),
    ];
    const provider = new OpenAIStreamProvider({ apiKey: "test", fetch: sseFetch(chunks) });
    const consolidated = await provider.stream({ model: "m", messages: [] }, () => {});
    const assistant = consolidated[0] as { payload: Record<string, unknown> };
    expect("reasoning" in assistant.payload).toBe(false);
  });
});
