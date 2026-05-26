import { defaultFixturesDir, runAllFixtures } from "../../src/testing/index.ts";

Deno.test("v0.19 conformance suite (Deno)", async () => {
  const fixturesDir = await defaultFixturesDir();
  const report = await runAllFixtures(fixturesDir);
  if (report.failed > 0) {
    throw new Error(JSON.stringify(report.results, null, 2));
  }
});
