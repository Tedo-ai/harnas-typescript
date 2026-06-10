import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SerializableLogEvent } from "../../src/core/events.js";
import { readJsonlFile } from "../../src/core/json.js";
import { firstLogMismatch } from "../../src/testing/conformance-runner.js";

describe("conformance runner strict diffing", () => {
  it("rejects oracle logs with extra actual payload fields", async () => {
    const oracle = join(specRoot(), "conformance", "oracle-corpus", "strict-diff-extra-payload-field");
    const actual = await readJsonlFile<SerializableLogEvent>(join(oracle, "actual-log.jsonl"));
    const expected = await readJsonlFile<SerializableLogEvent>(join(oracle, "expected-log.jsonl"));

    expect(firstLogMismatch(actual, expected)).toBeDefined();
  });
});

function specRoot(): string {
  const fromEnv = process.env.HARNAS_SPEC;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const sibling = resolve("../harnas");
  if (existsSync(join(sibling, "conformance", "oracle-corpus"))) {
    return sibling;
  }
  throw new Error("HARNAS_SPEC is required to locate conformance oracle corpus");
}
