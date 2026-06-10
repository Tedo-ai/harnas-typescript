import { mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Log, appendUserMessage } from "../../src/core/log.js";
import { AgentLoop, type ScriptedProvider } from "../../src/runtime/agent-loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("AgentLoop sandbox security", () => {
  it("refuses malformed network URLs instead of failing open", async () => {
    const log = new Log();
    appendUserMessage(log, "fetch");
    const provider = new QueueProvider([
      {
        model: "gpt-test",
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_fetch",
              function: { name: "fetch_url", arguments: JSON.stringify({ url: "http://[::1" }) },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
      finalResponse(),
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: "fetch_url" }, () => {
      throw new Error("fetch_url should not dispatch");
    });

    await new AgentLoop({
      manifest: {
        provider: { kind: "openai", model: "gpt-test" },
        strategies: [{ name: "sandbox/network", config: { allow: ["api.github.com"] } }],
      },
      log,
      provider,
      tools: registry,
    } as ConstructorParameters<typeof AgentLoop>[0]).runAfterInput();

    const result = log.events().find((event) => event.event_type === "tool_result");
    expect(result?.payload.error).toContain("unparseable URL");
  });

  it("refuses write sandbox symlink escapes", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnas-ts-sandbox-"));
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    symlinkSync(outside, join(allowed, "escape"), "dir");
    const log = new Log();
    appendUserMessage(log, "write");
    const provider = new QueueProvider([
      {
        model: "gpt-test",
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_write",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: join(allowed, "escape", "pwned.txt"), content: "secret" }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
      finalResponse(),
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: "write_file" }, () => {
      throw new Error("write_file should not dispatch");
    });

    await new AgentLoop({
      manifest: {
        provider: { kind: "openai", model: "gpt-test" },
        strategies: [{ name: "sandbox/write", config: { allow: [allowed] } }],
      },
      log,
      provider,
      tools: registry,
    } as ConstructorParameters<typeof AgentLoop>[0]).runAfterInput();

    const result = log.events().find((event) => event.event_type === "tool_result");
    expect(result?.payload.error).toContain("not permitted");
  });
});

class QueueProvider implements ScriptedProvider {
  #responses: unknown[];

  constructor(responses: unknown[]) {
    this.#responses = responses;
  }

  async next(): Promise<unknown> {
    const response = this.#responses.shift();
    if (response === undefined) {
      throw new Error("provider queue exhausted");
    }
    return response;
  }
}

function finalResponse(): unknown {
  return {
    model: "gpt-test",
    choices: [{ message: { content: "done" }, finish_reason: "stop" }],
  };
}
