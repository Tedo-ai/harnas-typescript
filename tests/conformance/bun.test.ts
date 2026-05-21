import { test, expect } from "bun:test";
import { defaultFixturesDir, runAllFixtures } from "../../src/testing/index.js";

test("phase 1 conformance suite (Bun)", async () => {
  const fixturesDir = await defaultFixturesDir();
  const report = await runAllFixtures(fixturesDir, {
    fixtureNames: ["minimal-chat", "with-system-prompt-openai"],
  });
  expect(report.failed).toBe(0);
});
