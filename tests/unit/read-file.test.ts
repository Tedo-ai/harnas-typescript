import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readFileBuiltin } from "../../src/builtins/index.js";

describe("readFileBuiltin", () => {
  it("returns cat -n style line numbers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harnas-typescript-"));
    const file = join(dir, "sample.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");

    await expect(readFileBuiltin({ path: file })).resolves.toBe("     1\talpha\n     2\tbeta\n     3\tgamma\n");
  });

  it("supports offset and limit with a truncation footer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harnas-typescript-"));
    const file = join(dir, "sample.txt");
    await writeFile(file, "one\ntwo\nthree\nfour\n", "utf8");

    await expect(readFileBuiltin({ path: file, offset: 1, limit: 2 })).resolves.toBe(
      "     2\ttwo\n     3\tthree\n... [file has 4 total lines; showing 1-3]\n",
    );
  });

  it("refuses binary files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harnas-typescript-"));
    const file = join(dir, "bin.dat");
    await writeFile(file, Buffer.from([1, 2, 0, 3]));

    await expect(readFileBuiltin({ path: file })).rejects.toThrow(/Cannot read binary file/);
  });
});
