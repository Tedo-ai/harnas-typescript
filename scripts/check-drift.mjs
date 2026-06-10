#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

function fixtureHashes(spec) {
  const agents = join(spec, "conformance", "agents");
  const hashes = {};
  for (const entry of readdirSync(agents, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !existsSync(join(agents, entry.name, "manifest.json"))) continue;
    const expectedLog = join(agents, entry.name, "expected-log.jsonl");
    if (!existsSync(expectedLog)) fail(`conformance/agents/${entry.name} has no expected-log.jsonl`);
    hashes[entry.name] = createHash("sha256").update(readFileSync(expectedLog)).digest("hex");
  }
  return hashes;
}

function requireCorpusManifest(spec, fixturesVersion) {
  const manifestPath = join(spec, "conformance", "corpus-manifest.json");
  if (!existsSync(manifestPath)) fail("spec conformance/corpus-manifest.json is missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const versions = manifest.versions;
  if (versions === null || typeof versions !== "object" || Array.isArray(versions)) {
    fail("spec corpus manifest has no versions object");
  }
  const entry = versions[fixturesVersion];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`spec corpus manifest has no entry for fixtures_version ${fixturesVersion}`);
  }
  const expected = entry.agents;
  if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
    fail(`spec corpus manifest entry ${fixturesVersion} has no agents object`);
  }
  const actual = fixtureHashes(spec);
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;

  const actualNames = new Set(Object.keys(actual));
  const expectedNames = new Set(Object.keys(expected));
  const missing = [...actualNames].filter((name) => !expectedNames.has(name)).sort();
  const stale = [...expectedNames].filter((name) => !actualNames.has(name)).sort();
  const changed = [...actualNames].filter((name) => expectedNames.has(name) && actual[name] !== expected[name]).sort();
  const parts = [];
  if (missing.length > 0) parts.push(`new fixtures without version bump: ${missing.join(", ")}`);
  if (stale.length > 0) parts.push(`manifest contains removed fixtures: ${stale.join(", ")}`);
  if (changed.length > 0) parts.push(`expected-log hashes changed: ${changed.join(", ")}`);
  fail(parts.join("; ") || "spec corpus manifest does not match live fixtures");
}

const spec = specRoot();
const fields = versionFields(spec);
const specVersion = fields.harnas_version;
const fixturesVersion = fields.fixtures_version;
if (specVersion === undefined) fail("spec VERSION has no harnas_version");
if (fixturesVersion === undefined) fail("spec VERSION has no fixtures_version");
requireCorpusManifest(spec, fixturesVersion);
const count = fixtureCount(spec);
const readme = readFileSync(join(root, "README.md"), "utf8");

for (const needle of [
  `Harnas spec ${specVersion}`,
  `${count}/${count} fixtures`,
  "tool-pair-safe",
  "manifest hooks dispatch through registered handlers",
  "rewinds the Log instead of passing vacuously",
  "Disclosed v1.0 footnotes",
  "Cross-language Session JSONL round-trip matrix",
]) {
  if (!readme.includes(needle)) fail(`README does not contain ${JSON.stringify(needle)}`);
}

for (const stale of ["71/71", "70/70", "65/65", "0.19.3", "with disclosed implementation gaps"]) {
  if (readme.includes(stale)) fail(`README contains stale ${stale}`);
}

console.log(`drift ok: harnas-typescript ${specVersion}, fixtures v${fixturesVersion}, ${count} agent fixtures`);
