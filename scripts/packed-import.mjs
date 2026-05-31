import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecOptions = { shell: process.platform === "win32" };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testApp = mkdtempSync(join(tmpdir(), "harnas-typescript-packed-"));

try {
  const packOutput = execFileSync(npm, ["pack", "--json"], { ...npmExecOptions, cwd: root, encoding: "utf8" });
  const [packResult] = JSON.parse(packOutput);
  if (typeof packResult?.filename !== "string") {
    throw new Error(`npm pack did not report a tarball filename: ${packOutput}`);
  }

  execFileSync(npm, ["init", "-y"], { ...npmExecOptions, cwd: testApp, stdio: "ignore" });
  execFileSync(npm, ["install", join(root, packResult.filename)], { ...npmExecOptions, cwd: testApp, stdio: "ignore" });
  execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      "await import('@tedo-ai/harnas-typescript'); await import('@tedo-ai/harnas-typescript/storage'); console.log('packed import ok')",
    ],
    { cwd: testApp, stdio: "inherit" },
  );
} finally {
  rmSync(testApp, { force: true, recursive: true });
}
