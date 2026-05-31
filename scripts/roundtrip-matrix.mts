import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Impl {
  readonly name: string;
  readonly cwd: string;
  readonly command: readonly string[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const specRoot = resolve(process.env.HARNAS_SPEC ?? join(root, "..", "harnas"));
const fixtures = ["roundtrip-minimal-chat", "roundtrip-with-reasoning"];

const impls: readonly Impl[] = [
  {
    name: "typescript",
    cwd: root,
    command: [process.platform === "win32" ? "npx.cmd" : "npx", "tsx", "src/testing/roundtrip-cli.ts"],
  },
  {
    name: "go",
    cwd: resolve(process.env.HARNAS_GO ?? join(root, "..", "harnas-go")),
    command: ["bin/conformance-roundtrip"],
  },
  {
    name: "ruby",
    cwd: resolve(process.env.HARNAS_RUBY ?? join(root, "..", "harnas-ruby")),
    command: ["bundle", "exec", "ruby", "bin/conformance_roundtrip.rb"],
  },
  {
    name: "python",
    cwd: resolve(process.env.HARNAS_PYTHON ?? join(root, "..", "harnas-python")),
    command: ["python3", "bin/conformance_roundtrip.py"],
  },
];

const tmp = mkdtempSync(join(tmpdir(), "harnas-typescript-roundtrip-"));

try {
  for (const fixture of fixtures) {
    for (const writer of impls) {
      const sessionPath = join(tmp, `${fixture}-${writer.name}.jsonl`);
      run(writer, ["--fixture", fixture, "--phase", "1", "--save", sessionPath]);
      for (const reader of impls) {
        if (reader.name === writer.name) {
          continue;
        }
        run(reader, [
          "--fixture",
          fixture,
          "--phase",
          "2",
          "--load",
          sessionPath,
          "--check",
          join(specRoot, "conformance", "round-trips", fixture, "expected-log.jsonl"),
        ]);
        console.log(`ok ${fixture}: ${writer.name} -> ${reader.name}`);
      }
    }
  }
} finally {
  rmSync(tmp, { force: true, recursive: true });
}

function run(impl: Impl, args: readonly string[]): void {
  execFileSync(impl.command[0] ?? "", [...impl.command.slice(1), ...args], {
    cwd: impl.cwd,
    env: { ...process.env, HARNAS_SPEC: specRoot },
    stdio: "inherit",
  });
}
