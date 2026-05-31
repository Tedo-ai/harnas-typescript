import { describe, expect, it } from "vitest";
import { brand } from "../../src/core/ids.js";
import { Session } from "../../src/core/session.js";
import { delegationTree, descendantTimeline, descendantUsage, openChildren } from "../../src/projections/delegation.js";

describe("delegation projections", () => {
  it("computes parent views from session logs", () => {
    const parent = new Session({ session_id: brand<"SessionId">("ses_parent") });
    const spawn = parent.log.append("agent_spawn", {
      spawn_id: "spn_1",
      child_session_id: "ses_child",
      task: "audit",
      join_policy: "async",
      metadata: { label: "Auditor" },
    });
    parent.log.append("agent_result", {
      spawn_id: "spn_1",
      child_session_id: "ses_child",
      status: "succeeded",
      result: { text: "done" },
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } as never,
      error: null,
    });

    const child = new Session({
      session_id: brand<"SessionId">("ses_child"),
      parent_session_id: brand<"SessionId">("ses_parent"),
      root_session_id: brand<"SessionId">("ses_parent"),
      spawn_id: "spn_1",
      spawned_by_event_id: spawn.id,
      delegation_chain: [{ session_id: "ses_parent", spawn_id: null }],
    });
    child.log.append("assistant_message", {
      content: [{ type: "text", text: "child result" }],
      stop_reason: "end_turn",
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } as never,
    });

    const sessions = new Map([
      ["ses_parent", parent],
      ["ses_child", child],
    ]);

    expect(delegationTree("ses_parent", sessions)).toEqual({
      session_id: "ses_parent",
      children: [{
        spawn_id: "spn_1",
        child_session_id: "ses_child",
        task: "audit",
        join_policy: "async",
        metadata: { label: "Auditor" },
        status: "succeeded",
        result: { text: "done" },
        error: null,
        children: [],
      }],
    });
    expect(openChildren("ses_parent", sessions)).toEqual([]);
    expect(descendantUsage("ses_parent", sessions)).toEqual({
      prompt_tokens: 6,
      completion_tokens: 8,
      total_tokens: 14,
    });
    expect(descendantTimeline("ses_parent", sessions).map((event) => event.session_id).sort()).toEqual([
      "ses_child",
      "ses_parent",
      "ses_parent",
    ]);
  });
});
