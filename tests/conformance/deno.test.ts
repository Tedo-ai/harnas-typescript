import { defaultFixturesDir, runAllFixtures } from "../../src/testing/index.ts";

Deno.test("phase 1 conformance suite (Deno)", async () => {
  const fixturesDir = await defaultFixturesDir();
  const report = await runAllFixtures(fixturesDir, {
    fixtureNames: ["minimal-chat", "with-system-prompt-openai"],
  });
  if (report.failed > 0) {
    throw new Error(JSON.stringify(report.results, null, 2));
  }
});
