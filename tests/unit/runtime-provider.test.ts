import { describe, it, expect } from "vitest";

import { OpenAIProvider } from "../../src/providers/openai.js";
import { runtimeProvider } from "../../src/providers/runtime.js";

describe("runtimeProvider", () => {
  it("drives a live OpenAI completion through the AgentLoop's next() interface", async () => {
    const captured: { url?: string; body?: string } = {};
    const mockFetch = (async (url: unknown, init: { body?: string }) => {
      captured.url = String(url);
      if (init.body !== undefined) {
        captured.body = init.body;
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "hi from live" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const provider = runtimeProvider(new OpenAIProvider({ apiKey: "test", fetch: mockFetch }));
    const response = (await provider.next({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    })) as { choices: { message: { content: string } }[] };

    expect(captured.url).toContain("/chat/completions");
    expect(captured.body).toContain('"model":"gpt-4o"');
    expect(response.choices[0]?.message.content).toBe("hi from live");
  });
});
