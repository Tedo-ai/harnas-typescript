import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultFixturesDir, runAllFixtures } from "../../src/testing/index.js";

test("v0.19 conformance suite (Node)", async () => {
  const fixturesDir = await defaultFixturesDir();
  const report = await runAllFixtures(fixturesDir);
  assert.equal(report.failed, 0, JSON.stringify(report.results, null, 2));
});
