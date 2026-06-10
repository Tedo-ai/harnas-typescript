#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`drift check failed: ${message}`);
  process.exit(1);
}

function specRoot() {
  const explicit = process.env.HARNAS_SPEC;
  if (explicit && existsSync(explicit)) return explicit;
  const localCheckout = join(root, "harnas-spec");
  if (existsSync(join(localCheckout, "conformance", "agents"))) return localCheckout;
  const sibling = resolve(root, "../harnas");
  if (existsSync(join(sibling, "conformance", "agents"))) return sibling;
  fail("set HARNAS_SPEC to a Harnas spec checkout");
}

function versionFields(spec) {
  const out = {};
  const lines = readFileSync(join(spec, "VERSION"), "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes(":")) continue;
    const [key, ...rest] = line.split(":");
    out[key.trim()] = rest.join(":").trim();
  }
  return out;
}

function fixtureCount(spec) {
  const agents = join(spec, "conformance", "agents");
  return readdirSync(agents, { withFileTypes: true }).filter((entry) => {
    return entry.isDirectory() && existsSync(join(agents, entry.name, "manifest.json"));
  }).length;
}

const spec = specRoot();
const fields = versionFields(spec);
const specVersion = fields.harnas_version;
const fixturesVersion = fields.fixtures_version;
if (specVersion === undefined) fail("spec VERSION has no harnas_version");
if (fixturesVersion === undefined) fail("spec VERSION has no fixtures_version");
const count = fixtureCount(spec);
const readme = readFileSync(join(root, "README.md"), "utf8");

for (const needle of [
  `Harnas spec ${specVersion}`,
  `${count}/${count} fixtures`,
  "with disclosed implementation gaps",
  "real MarkerTail tool-pair-safe compaction",
  "manifest hook dispatch",
  "Session.fork(at_seq)",
  "Cross-language Session JSONL round-trip matrix",
]) {
  if (!readme.includes(needle)) fail(`README does not contain ${JSON.stringify(needle)}`);
}

for (const stale of ["70/70", "65/65", "0.19.3"]) {
  if (readme.includes(stale)) fail(`README contains stale ${stale}`);
}

console.log(`drift ok: harnas-typescript ${specVersion}, fixtures v${fixturesVersion}, ${count} agent fixtures`);
