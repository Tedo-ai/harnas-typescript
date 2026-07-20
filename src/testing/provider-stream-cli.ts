import { resolve } from "node:path";

import { runProviderStreamCorpus } from "./provider-stream-conformance.js";

const specIndex = process.argv.indexOf("--spec");
const spec =
  specIndex >= 0 && process.argv[specIndex + 1] !== undefined
    ? resolve(process.argv[specIndex + 1] as string)
    : resolve(process.env.HARNAS_SPEC ?? "../harnas");

try {
  const report = await runProviderStreamCorpus(spec);
  console.log(
    `${report.cases}/${report.cases} provider-wire cases; ${report.profiles} chunked executions passed`,
  );
} catch (error) {
  console.error(`provider-wire conformance failed: ${String(error)}`);
  process.exitCode = 1;
}
