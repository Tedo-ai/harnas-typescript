import { defaultFixturesDir, runAllFixtures } from "./conformance-runner.js";

const fixturesDir = await defaultFixturesDir();
const fixtureNames = process.argv.slice(2);
const report = await runAllFixtures(fixturesDir, {
  fixtureNames: fixtureNames.length > 0 ? fixtureNames : ["minimal-chat", "with-system-prompt-openai"],
});

for (const result of report.results) {
  if (result.passed) {
    console.log(`ok ${result.name}`);
  } else {
    console.error(`not ok ${result.name}: ${result.error ?? "unknown error"}`);
  }
}

console.log(`Conformance: ${report.passed}/${report.total}`);
if (report.failed > 0) {
  process.exitCode = 1;
}
