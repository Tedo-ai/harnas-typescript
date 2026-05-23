import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testApp = mkdtempSync(join(tmpdir(), "harnas-typescript-packed-"));

try {
  const packOutput = execFileSync(npm, ["pack", "--json"], { cwd: root, encoding: "utf8" });
  const [packResult] = JSON.parse(packOutput);
  if (typeof packResult?.filename !== "string") {
    throw new Error(`npm pack did not report a tarball filename: ${packOutput}`);
  }

  execFileSync(npm, ["init", "-y"], { cwd: testApp, stdio: "ignore" });
  execFileSync(npm, ["install", join(root, packResult.filename)], { cwd: testApp, stdio: "ignore" });
  execFileSync(
    "node",
    ["--input-type=module", "-e", "import('@tedo-ai/harnas-typescript').then(() => console.log('packed import ok'))"],
    { cwd: testApp, stdio: "inherit" },
  );
} finally {
  rmSync(testApp, { force: true, recursive: true });
}
