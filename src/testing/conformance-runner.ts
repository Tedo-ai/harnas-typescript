import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ConformanceError } from "../core/errors.js";
import { readJsonFile, readJsonlFile, canonicalJson } from "../core/json.js";
import { appendUserMessage, Log } from "../core/log.js";
import { buildRuntime } from "../runtime/build.js";
import { projectOpenAIRequest } from "../projections/provider/openai.js";
import { projectAnthropicRequest } from "../projections/provider/anthropic.js";
import { ingestOpenAIResponse } from "../ingestors/openai.js";
import { ingestAnthropicResponse } from "../ingestors/anthropic.js";
import type { ProviderManifest } from "../projections/provider/common.js";
import type { SerializableLogEvent } from "../core/events.js";

export interface ProviderScriptTurn {
  readonly expect_request?: unknown;
  readonly response: unknown;
}

export interface ConformanceOptions {
  readonly fixtureNames?: readonly string[];
}

export interface FixtureResult {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: string;
}

export interface ConformanceReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly FixtureResult[];
}

interface FixtureFiles {
  readonly manifest: ProviderManifest;
  readonly inputs: readonly string[];
  readonly script: readonly ProviderScriptTurn[];
  readonly expectedLog: readonly SerializableLogEvent[];
}

export async function runFixture(fixturePath: string): Promise<FixtureResult> {
  const name = fixturePath.split(/[\\/]/).at(-1) ?? fixturePath;
  try {
    const files = await loadFixture(fixturePath);
    const runtime = buildRuntime({ manifest: files.manifest });
    const log = new Log();
    let scriptIndex = 0;

    for (const input of files.inputs) {
      appendUserMessage(log, input);
      const scriptTurn = files.script[scriptIndex];
      if (scriptTurn === undefined) {
        throw new ConformanceError(`provider script ended before input ${scriptIndex + 1}`);
      }

      const request = projectRequest(runtime.manifest, log);
      if (scriptTurn.expect_request !== undefined && canonicalJson(request) !== canonicalJson(scriptTurn.expect_request)) {
        throw new ConformanceError(
          `request mismatch\nactual:   ${canonicalJson(request)}\nexpected: ${canonicalJson(scriptTurn.expect_request)}`,
        );
      }

      const response = "response" in scriptTurn ? scriptTurn.response : scriptTurn;
      log.append("assistant_message", ingestResponse(runtime.manifest, response));
      scriptIndex += 1;
    }

    const actual = log.serializableEvents();
    if (canonicalJson(actual) !== canonicalJson(files.expectedLog)) {
      throw new ConformanceError(
        `log mismatch\nactual:   ${canonicalJson(actual)}\nexpected: ${canonicalJson(files.expectedLog)}`,
      );
    }

    return { name, passed: true };
  } catch (error) {
    return { name, passed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runAllFixtures(fixturesDir: string, options: ConformanceOptions = {}): Promise<ConformanceReport> {
  const names = options.fixtureNames ?? (await fixtureNames(fixturesDir));
  const results: FixtureResult[] = [];
  for (const name of names) {
    results.push(await runFixture(join(fixturesDir, name)));
  }
  const passed = results.filter((result) => result.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

export async function defaultFixturesDir(): Promise<string> {
  const fromEnv = process.env.HARNAS_FIXTURES;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const specEnv = process.env.HARNAS_SPEC;
  if (specEnv !== undefined && specEnv.length > 0) {
    return join(specEnv, "conformance", "agents");
  }
  return resolve("../harnas/conformance/agents");
}

async function loadFixture(fixturePath: string): Promise<FixtureFiles> {
  return {
    manifest: await readJsonFile<ProviderManifest>(join(fixturePath, "manifest.json")),
    inputs: await readJsonFile<readonly string[]>(join(fixturePath, "inputs.json")),
    script: await readJsonFile<readonly ProviderScriptTurn[]>(join(fixturePath, "provider-script.json")),
    expectedLog: await readJsonlFile<SerializableLogEvent>(join(fixturePath, "expected-log.jsonl")),
  };
}

async function fixtureNames(fixturesDir: string): Promise<readonly string[]> {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifest = join(fixturesDir, entry.name, "manifest.json");
    try {
      await access(manifest);
      names.push(entry.name);
    } catch {
      // Ignore directories that are not conformance fixtures.
    }
  }
  return names.sort();
}

function projectRequest(manifest: ProviderManifest, log: Log): unknown {
  switch (manifest.provider.kind) {
    case "openai":
      return projectOpenAIRequest(manifest, log);
    case "anthropic":
      return projectAnthropicRequest(manifest, log);
    default:
      throw new ConformanceError(`unsupported phase-1 provider: ${manifest.provider.kind}`);
  }
}

function ingestResponse(manifest: ProviderManifest, response: unknown): SerializableLogEvent<"assistant_message">["payload"] {
  switch (manifest.provider.kind) {
    case "openai":
      return ingestOpenAIResponse(response as Parameters<typeof ingestOpenAIResponse>[0]);
    case "anthropic":
      return ingestAnthropicResponse(response as Parameters<typeof ingestAnthropicResponse>[0]);
    default:
      throw new ConformanceError(`unsupported phase-1 provider: ${manifest.provider.kind}`);
  }
}
