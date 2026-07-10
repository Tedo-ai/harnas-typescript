import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { userMessagePayload, messageText } from "../../src/wire/index.js";
import { projectOpenAIRequest } from "../../src/projections/provider/openai.js";
import { projectAnthropicRequest } from "../../src/projections/provider/anthropic.js";
import { projectGeminiRequest } from "../../src/projections/provider/gemini.js";
import { ProviderError } from "../../src/core/errors.js";
import { Log } from "../../src/core/log.js";
import type { ProviderManifest } from "../../src/projections/provider/common.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "../../src");

// #18: the wire surface must be importable eagerly — its transitive graph
// must not reach Node built-ins. Walk the static imports from src/wire and
// assert none resolve to a `node:`/bare-Node module.
function transitiveLocalImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const nodeBuiltins: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
      const spec = match[1] ?? "";
      if (spec.startsWith("node:")) {
        nodeBuiltins.push(`${file} → ${spec}`);
        continue;
      }
      if (!spec.startsWith(".")) {
        // A bare specifier that isn't a relative path — treat known Node
        // built-ins without the node: prefix as a violation too.
        if (["fs", "path", "child_process", "os", "crypto"].includes(spec)) {
          nodeBuiltins.push(`${file} → ${spec}`);
        }
        continue;
      }
      const resolved = resolve(dirname(file), spec).replace(/\.js$/, ".ts");
      visit(resolved);
    }
  };
  visit(entry);
  if (nodeBuiltins.length > 0) {
    throw new Error(`wire graph reaches Node built-ins:\n${nodeBuiltins.join("\n")}`);
  }
  return seen;
}

describe("wire surface (#18)", () => {
  it("has a Node-built-in-free transitive import graph", () => {
    expect(() => transitiveLocalImports(join(srcRoot, "wire/index.ts"))).not.toThrow();
  });

  it("userMessagePayload matches what appendUserMessage writes (single source of shape)", () => {
    const payload = userMessagePayload("hello");
    expect(payload).toEqual({ content: [{ type: "text", text: "hello" }], text: "hello" });
    // content is authoritative; messageText reads back the same text
    expect(messageText(payload)).toBe("hello");

    const log = new Log();
    const { appendUserMessage } = { appendUserMessage: (l: Log, t: string) => l.append("user_message", userMessagePayload(t)) };
    appendUserMessage(log, "hello");
    expect(log.events()[0]?.payload).toEqual(payload);
  });
});

describe("trailing-assistant projection policy (#19)", () => {
  const manifest = (kind: string): ProviderManifest => ({
    provider: { kind, model: "m", max_tokens: 16 },
  });

  function logEndingOnAssistant(): Log {
    const log = new Log();
    log.append("user_message", userMessagePayload("summarize this"));
    log.append("assistant_message", { text: "partial", stop_reason: "end_turn", content: [{ type: "text", text: "partial" }] } as never);
    return log;
  }

  it("default allows the trailing-assistant projection (backward compatible)", () => {
    const req = projectOpenAIRequest(manifest("openai"), logEndingOnAssistant());
    expect(req.messages.at(-1)?.role).toBe("assistant");
  });

  it("'error' throws a ProviderError for each provider", () => {
    const log = logEndingOnAssistant();
    expect(() => projectOpenAIRequest(manifest("openai"), log, { onTrailingAssistant: "error" })).toThrow(ProviderError);
    expect(() => projectAnthropicRequest(manifest("anthropic"), log, { onTrailingAssistant: "error" })).toThrow(ProviderError);
    expect(() => projectGeminiRequest(manifest("gemini"), log, { onTrailingAssistant: "error" })).toThrow(ProviderError);
  });

  it("{appendUser} closes each request on a user turn", () => {
    const log = logEndingOnAssistant();
    const openai = projectOpenAIRequest(manifest("openai"), log, { onTrailingAssistant: { appendUser: "Continue." } });
    expect(openai.messages.at(-1)).toEqual({ role: "user", content: "Continue." });

    const gemini = projectGeminiRequest(manifest("gemini"), log, { onTrailingAssistant: { appendUser: "Continue." } });
    expect(gemini.contents.at(-1)).toEqual({ role: "user", parts: [{ text: "Continue." }] });

    const anthropic = projectAnthropicRequest(manifest("anthropic"), log, { onTrailingAssistant: { appendUser: "Continue." } });
    expect((anthropic.messages.at(-1) as { role: string }).role).toBe("user");
  });

  it("does not touch a Log that already ends on a user turn", () => {
    const log = new Log();
    log.append("user_message", userMessagePayload("just a question"));
    const req = projectOpenAIRequest(manifest("openai"), log, { onTrailingAssistant: "error" });
    expect(req.messages.at(-1)?.role).toBe("user");
  });
});
