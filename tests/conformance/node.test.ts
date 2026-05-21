import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultFixturesDir, runAllFixtures } from "../../src/testing/index.js";

test("phase 1 conformance suite (Node)", async () => {
  const fixturesDir = await defaultFixturesDir();
  const report = await runAllFixtures(fixturesDir, {
    fixtureNames: ["minimal-chat", "with-system-prompt-openai"],
  });
  assert.equal(report.failed, 0, JSON.stringify(report.results, null, 2));
});
