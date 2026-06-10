import { test, expect } from "bun:test";
import { defaultFixturesDir, runAllFixtures } from "../../src/testing/index.js";

test("v0.19 conformance suite (Bun)", async () => {
  const fixturesDir = await defaultFixturesDir();
  const report = await runAllFixtures(fixturesDir);
  expect(report.failed).toBe(0);
}, 20_000);
