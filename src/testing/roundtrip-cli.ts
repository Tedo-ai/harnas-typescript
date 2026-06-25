import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, readJsonFile, readJsonlFile } from "../core/json.js";
import type { SerializableLogEvent } from "../core/events.js";
import { Session } from "../core/session.js";
import type { ProviderManifest } from "../projections/provider/common.js";
import { runScriptedSession } from "./conformance-runner.js";

interface RoundTripArgs {
  readonly fixture: string;
  readonly phase: 1 | 2;
  readonly save?: string;
  readonly load?: string;
  readonly check?: string;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const fixtureDir = join(specRoot(), "conformance", "round-trips", args.fixture);
  const manifest = await readJsonFile<ProviderManifest>(join(fixtureDir, "manifest.json"));
  const script = await readJsonFile<readonly unknown[]>(join(fixtureDir, `phase-${args.phase}-provider-script.json`));
  const inputs = await readJsonFile<readonly unknown[]>(join(fixtureDir, `phase-${args.phase}-inputs.json`));

  if (args.phase === 1) {
    if (args.save === undefined) {
      throw new Error("--save is required for phase 1");
    }
    const session = await runScriptedSession(manifest, script, inputs, { fixturePath: fixtureDir });
    await saveRoundTripJsonl(session, args.save);
    console.log(`saved ${args.fixture} (${session.log.events().length} events)`);
    return 0;
  }

  if (args.load === undefined) {
    throw new Error("--load is required for phase 2");
  }
  if (args.check === undefined) {
    throw new Error("--check is required for phase 2");
  }
  const session = await Session.load(args.load);
  const continued = await runScriptedSession(manifest, script, inputs, { fixturePath: fixtureDir, initialSession: session });
  const actual = normalizeForExpected(continued.log.serializableEvents(), await readJsonlFile<SerializableLogEvent>(args.check));
  const expected = await readJsonlFile<SerializableLogEvent>(args.check);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    console.error(`round-trip mismatch\nactual:   ${canonicalJson(actual)}\nexpected: ${canonicalJson(expected)}`);
    return 1;
  }
  console.log(`checked ${args.fixture} (${actual.length} events)`);
  return 0;
}

function parseArgs(argv: readonly string[]): RoundTripArgs {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || !key.startsWith("--") || value === undefined) {
      throw new Error("usage: tsx src/testing/roundtrip-cli.ts --fixture NAME --phase 1|2 [--save PATH] [--load PATH] [--check PATH]");
    }
    out[key.slice(2)] = value;
  }
  if (out.fixture === undefined || out.phase === undefined) {
    throw new Error("--fixture and --phase are required");
  }
  const phase = Number(out.phase);
  if (phase !== 1 && phase !== 2) {
    throw new Error("--phase must be 1 or 2");
  }
  return {
    fixture: out.fixture,
    phase,
    ...(out.save === undefined ? {} : { save: out.save }),
    ...(out.load === undefined ? {} : { load: out.load }),
    ...(out.check === undefined ? {} : { check: out.check }),
  };
}

function specRoot(): string {
  const fromEnv = process.env.HARNAS_SPEC;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  const sibling = resolve("../harnas");
  if (existsSync(join(sibling, "conformance", "round-trips"))) {
    return sibling;
  }
  return resolve("../spec");
}

function normalizeForExpected(
  actual: readonly SerializableLogEvent[],
  expected: readonly SerializableLogEvent[],
): readonly SerializableLogEvent[] {
  return actual.map((event, index) => {
    const expectedEvent = expected[index];
    if (expectedEvent === undefined) {
      return event;
    }
    const normalized: Record<string, unknown> = {
      seq: event.seq,
      type: event.type,
      payload: projectExpectedPayload(event.payload, expectedEvent.payload),
    };
    if (expectedEvent.timestamp === "<generated>" && event.timestamp !== undefined) {
      normalized.timestamp = "<generated>";
    } else if (expectedEvent.timestamp !== undefined) {
      normalized.timestamp = event.timestamp;
    }
    return normalized as unknown as SerializableLogEvent;
  });
}

async function saveRoundTripJsonl(session: Session, path: string): Promise<void> {
  const rows = [
    { __session__: true, id: session.header.session_id },
    ...session.log.serializableEvents().map((event) => ({
      seq: event.seq,
      id: "",
      timestamp: event.timestamp,
      type: event.type,
      payload: event.payload,
    })),
  ];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function projectExpectedPayload(actual: unknown, expected: unknown): unknown {
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.map((item, index) => projectExpectedPayload(item, expected[index]));
  }
  if (!isRecord(actual) || !isRecord(expected)) {
    return actual;
  }
  const projected: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) {
    projected[key] = projectExpectedPayload(actual[key], expected[key]);
  }
  return projected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
