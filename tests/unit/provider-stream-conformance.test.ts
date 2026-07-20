import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runProviderStreamCorpus } from "../../src/testing/provider-stream-conformance.js";

describe("provider-wire conformance", () => {
  it("runs raw bytes through every production parser", async () => {
    const spec = resolve(process.env.HARNAS_SPEC ?? "../harnas");
    if (
      !existsSync(resolve(spec, "conformance/provider-streams/corpus.json"))
    ) {
      return;
    }
    const report = await runProviderStreamCorpus(spec);
    expect(report).toEqual({ cases: 18, profiles: 39 });
  });
});
