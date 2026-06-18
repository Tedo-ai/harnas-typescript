import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeJCSV1JSON, contentHashForEventRowJSON, InvalidUnicodeError } from "../../src/index.js";

interface Vector {
  readonly name: string;
  readonly input_json: string;
  readonly expected_canonical: string;
  readonly expected_content_hash: string;
  readonly exclude_keys?: readonly string[];
}

function specRoot(): string {
  return process.env.HARNAS_SPEC ?? join(process.cwd(), "..", "harnas");
}

describe("harnas-jcs-v1", () => {
  it("matches the oracle vectors without routing big integers through Number", async () => {
    const corpus = JSON.parse(
      await readFile(join(specRoot(), "conformance/oracle-corpus/event-content-hash/vectors.json"), "utf8"),
    ) as { readonly valid: readonly Vector[] };

    for (const vector of corpus.valid) {
      const canonical = canonicalizeJCSV1JSON(vector.input_json, vector.exclude_keys ?? []);
      expect(canonical, vector.name).toBe(vector.expected_canonical);
      expect(createHash("sha256").update(canonical, "utf8").digest("hex"), vector.name)
        .toBe(vector.expected_content_hash);
    }
  });

  it("fails loudly on invalid unicode", async () => {
    const corpus = JSON.parse(
      await readFile(join(specRoot(), "conformance/oracle-corpus/event-content-hash/vectors.json"), "utf8"),
    ) as { readonly invalid: readonly { readonly input_json: string }[] };

    for (const vector of corpus.invalid) {
      expect(() => canonicalizeJCSV1JSON(vector.input_json)).toThrow(InvalidUnicodeError);
    }
  });

  it("computes Event row content_hash excluding itself", async () => {
    const root = join(specRoot(), "conformance/oracle-corpus/event-content-hash");
    const row = await readFile(join(root, "event-row-with-content-hash.json"), "utf8");
    const expected = (await readFile(join(root, "expected-content-hash.txt"), "utf8")).trim();
    expect(contentHashForEventRowJSON(row)).toBe(expected);
  });
});
