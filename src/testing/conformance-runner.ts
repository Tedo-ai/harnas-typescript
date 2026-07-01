import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ConformanceError } from "../core/errors.js";
import { readJsonFile, readJsonlFile, canonicalJson } from "../core/json.js";
import type { StreamEvent, StreamEventSink } from "../core/streaming.js";
import type { ObservationBus } from "../core/observation-bus.js";
import type { StreamProvider } from "../providers/openai-stream.js";
import { appendUserMessage, Log } from "../core/log.js";
import { BashSessionTool } from "../builtins/bash-session.js";
import { loadSkillBuiltin } from "../builtins/load-skill.js";
import { readFileBuiltin } from "../builtins/read-file.js";
import { writeFileBuiltin } from "../builtins/write-file.js";
import { buildRuntime } from "../runtime/build.js";
import { AgentLoop } from "../runtime/agent-loop.js";
import { delegationTree, descendantTimeline, descendantUsage, openChildren } from "../projections/delegation.js";
import { Session } from "../core/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { sessionJsonl } from "../storage/jsonl.js";
import type { ProviderManifest } from "../projections/provider/common.js";
import type { SerializableLogEvent } from "../core/events.js";
import type { HookHandler } from "../runtime/agent-loop.js";
import type { ToolDescriptor } from "../tools/types.js";

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

export interface ScriptedSessionOptions {
  readonly fixturePath: string;
  readonly initialSession?: Session;
  readonly streaming?: boolean;
  readonly onStreamEvent?: StreamEventSink;
  readonly observation?: ObservationBus;
  readonly streamProvider?: StreamProvider;
}

interface SerializableStreamEvent {
  readonly index: number;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

interface FixtureFiles {
  readonly manifest: ProviderManifest;
  readonly inputs: readonly unknown[];
  readonly script: readonly unknown[];
  readonly streaming: boolean;
  readonly expectedLog: readonly SerializableLogEvent[];
  readonly expectedProjections?: readonly ProjectionExpectation[];
  readonly expectedDeltas?: readonly SerializableStreamEvent[];
  readonly staticLog?: readonly SerializableLogEvent[];
  readonly staticSessions?: ReadonlyMap<string, Session>;
  readonly isolation?: {
    readonly repeat?: number;
  };
}

interface ProjectionExpectation {
  readonly projection: string;
  readonly input: string;
  readonly output: unknown;
}

interface InputResult {
  readonly session: Session;
  readonly shouldCallProvider: boolean;
}

export async function runFixture(fixturePath: string): Promise<FixtureResult> {
  const name = fixturePath.split(/[\\/]/).at(-1) ?? fixturePath;
  try {
    const files = await loadFixture(fixturePath);
    const manifest = sanitizeManifest(files.manifest);
    if (files.staticLog !== undefined) {
    const actual = normalizeActualLogForExpected(files.staticLog, files.expectedLog);
      if (canonicalJson(actual) !== canonicalJson(files.expectedLog)) {
        throw new ConformanceError(
          `log mismatch\nactual:   ${canonicalJson(actual)}\nexpected: ${canonicalJson(files.expectedLog)}`,
        );
      }
      assertExpectedProjections(files);
      return { name, passed: true };
    }
    const collectedDeltas: StreamEvent[] = [];
    const onStreamEvent: StreamEventSink = (event) => collectedDeltas.push(event);
    const session = await runScriptedSession(manifest, files.script, files.inputs, { fixturePath, streaming: files.streaming, onStreamEvent });
    const log = session.log;

    const actual = normalizeActualLogForExpected(log.serializableEvents(), files.expectedLog);
    if (canonicalJson(actual) !== canonicalJson(files.expectedLog)) {
      throw new ConformanceError(
        `log mismatch\nactual:   ${canonicalJson(actual)}\nexpected: ${canonicalJson(files.expectedLog)}`,
      );
    }

    if (files.expectedDeltas !== undefined) {
      const actualDeltas = collectedDeltas.map((event, index) => ({ index, type: event.type, payload: event.payload }));
      if (canonicalJson(actualDeltas) !== canonicalJson(files.expectedDeltas)) {
        throw new ConformanceError(
          `delta sidecar mismatch\nactual:   ${canonicalJson(actualDeltas)}\nexpected: ${canonicalJson(files.expectedDeltas)}`,
        );
      }
    }
    const repeat = files.isolation?.repeat ?? 1;
    for (let index = 1; index < repeat; index += 1) {
      const repeatedSession = await runScriptedSession(manifest, files.script, files.inputs, { fixturePath, streaming: files.streaming });
      const repeated = normalizeActualLogForExpected(repeatedSession.log.serializableEvents(), files.expectedLog);
      if (canonicalJson(repeated) !== canonicalJson(files.expectedLog)) {
        throw new ConformanceError(
          `isolation repeat ${index + 1} log mismatch\nactual:   ${canonicalJson(repeated)}\nexpected: ${canonicalJson(files.expectedLog)}`,
        );
      }
    }

    return { name, passed: true };
  } catch (error) {
    return { name, passed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runScriptedSession(
  manifest: ProviderManifest,
  script: readonly unknown[],
  inputs: readonly unknown[],
  options: ScriptedSessionOptions,
): Promise<Session> {
  const runtime = buildRuntime({ manifest });
  let session = options.initialSession ?? new Session();
  const provider = new ScriptedConformanceProvider(script);
  const tools = toolRegistryForFixture(runtime.manifest, options.fixturePath);
  const hookHandlers = conformanceHookHandlers();
  const makeLoop = (current: Session) => new AgentLoop({
    manifest: runtime.manifest,
    log: current.log,
    provider,
    tools,
    hookHandlers,
    fixturePath: options.fixturePath,
    ...(options.streaming === undefined ? {} : { streaming: options.streaming }),
    ...(options.onStreamEvent === undefined ? {} : { onStreamEvent: options.onStreamEvent }),
    ...(options.observation === undefined ? {} : { observation: options.observation }),
    ...(options.streamProvider === undefined ? {} : { streamProvider: options.streamProvider }),
  });
  let loop = makeLoop(session);

  for (const input of inputs) {
    const result = appendInput(session, input);
    if (result.session !== session) {
      loop = makeLoop(result.session);
    }
    session = result.session;
    if (!result.shouldCallProvider) {
      continue;
    }
    await loop.runAfterInput();
  }

  return session;
}

function appendInput(session: Session, input: unknown): InputResult {
  const log = session.log;
  if (typeof input === "string") {
    appendUserMessage(log, input);
    return { session, shouldCallProvider: true };
  }
  if (!isRecord(input)) {
    appendUserMessage(log, "");
    return { session, shouldCallProvider: true };
  }
  if (Array.isArray(input.append_events)) {
    for (const event of input.append_events) {
      if (isRecord(event) && typeof event.type === "string" && isRecord(event.payload)) {
        log.append(event.type as EventTypeForAppend, event.payload as never);
      }
    }
    return { session, shouldCallProvider: false };
  }
  if (isRecord(input.compact)) {
    log.append("compact", input.compact);
    return { session, shouldCallProvider: false };
  }
  if (typeof input.revert === "number") {
    log.append("revert", { revokes: input.revert });
    return { session, shouldCallProvider: false };
  }
  if (isRecord(input.fork)) {
    const atSeq = typeof input.fork.at_seq === "number" ? input.fork.at_seq : log.events().at(-1)?.seq ?? -1;
    return { session: session.fork(atSeq), shouldCallProvider: false };
  }
  if (input.save_load === true) {
    return {
      session: Session.fromJsonl(sessionJsonl({ header: session.header, events: log.events() })),
      shouldCallProvider: false,
    };
  }
  if (Array.isArray(input.content)) {
    log.append("user_message", { content: input.content as never });
    return { session, shouldCallProvider: true };
  }
  appendUserMessage(log, "");
  return { session, shouldCallProvider: true };
}

type EventTypeForAppend = Parameters<Log["append"]>[0];

function conformanceHookHandlers(): ReadonlyMap<string, HookHandler> {
  const auditPostToolUse: HookHandler = (context) => {
    if (context.tool_use?.event_type !== "tool_use" || context.tool_result === undefined) {
      return;
    }
    context.log.append("annotation", {
      kind: "conformance.hook",
      data: {
        tool_use_id: context.tool_use.payload.id,
        result_seq: context.tool_result.seq,
      },
    });
  };
  const raiseHook: HookHandler = () => {
    const error = new Error("conformance hook failure");
    error.name = "RuntimeError";
    throw error;
  };
  return new Map([
    ["conformance.audit_post_tool_use", auditPostToolUse],
    ["conformance.audit_post_tool_use_variant", auditPostToolUse],
    ["conformance.raise_hook", raiseHook],
    ["conformance.raise_hook_variant", raiseHook],
  ]);
}

class ScriptedConformanceProvider {
  #index = 0;

  constructor(private readonly script: readonly unknown[]) {}

  async next(request: unknown): Promise<unknown> {
    const scriptTurn = this.script[this.#index];
    if (scriptTurn === undefined) {
      throw new ConformanceError(`provider script ended before turn ${this.#index + 1}`);
    }

    this.#index += 1;
    const recordTurn = isRecord(scriptTurn) ? scriptTurn : undefined;
    if (recordTurn?.expect_request !== undefined && !requestValueEqual(request, recordTurn.expect_request)) {
      throw new ConformanceError(
        `request mismatch\nactual:   ${canonicalJson(request)}\nexpected: ${canonicalJson(recordTurn.expect_request)}`,
      );
    }
    return recordTurn !== undefined && "response" in recordTurn ? recordTurn.response : scriptTurn;
  }
}

function toolRegistryForFixture(manifest: ProviderManifest, fixturePath: string): ToolRegistry {
  const registry = new ToolRegistry();
  const bashSession = new BashSessionTool({ root: fixturePath });
  for (const descriptor of manifest.tools ?? []) {
    const tool = descriptor as ToolDescriptor;
    switch (tool.handler) {
      case "conformance.get_current_time":
        registry.register(tool, (args) => `[conformance stub: conformance.get_current_time(${canonicalJson(args)})]`);
        break;
      case "conformance.echo_args":
        registry.register(tool, (args) => `[conformance stub: conformance.echo_args(${canonicalJson(args)})]`);
        break;
      case "conformance.echo":
        registry.register(tool, (args) => `[conformance stub: conformance.echo(${canonicalJson(args)})]`);
        break;
      case "conformance.echo_config":
        registry.register(tool, (_args, config) => `[conformance config: ${canonicalJson(config ?? {})}]`);
        break;
      case "conformance.big_echo":
        registry.register(tool, (args) => `[conformance stub: conformance.big_echo(${canonicalJson(args)})]`);
        break;
      case "conformance.raise_error":
        registry.register(tool, () => {
          const error = new Error("conformance tool error");
          error.name = "RuntimeError";
          throw error;
        });
        break;
      case "harnas.builtin.read_file":
        registry.register(tool, async (args) => {
          const path = typeof args.path === "string" ? join(fixturePath, args.path) : "";
          return await readFileBuiltin({
            path,
            ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
            ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          });
        });
        break;
      case "harnas.builtin.write_file":
        registry.register(tool, async (args) => {
          const relativePath = typeof args.path === "string" ? args.path : "";
          const content = typeof args.content === "string" ? args.content : "";
          await writeFileBuiltin({ path: join(fixturePath, relativePath), content });
          return `wrote ${content.length} bytes to ${relativePath}`;
        });
        break;
      case "harnas.builtin.load_skill":
        registry.register(tool, async (args, config) => await loadSkillBuiltin(
          { name: typeof args.name === "string" ? args.name : "" },
          config,
          { root: fixturePath },
        ));
        break;
      case "harnas.builtin.fetch_url":
        registry.register(tool, (args) => {
          const headers = isRecord(args.headers) ? args.headers : {};
          if (headers.Authorization === "Bearer SECRET-DO-NOT-LOG") {
            return "fetched OK";
          }
          return `[conformance stub: harnas.builtin.fetch_url(${canonicalJson(args)})]`;
        });
        break;
      case "harnas.builtin.bash_session":
        registry.register(tool, (args, config) => bashSession.run(args, config));
        break;
      default:
        break;
    }
  }
  return registry;
}

function requestValueEqual(actual: unknown, expected: unknown): boolean {
  if (expected === "<generated>") {
    return actual !== undefined && actual !== null && actual !== "";
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, index) => requestValueEqual(item, expected[index]));
  }
  if (isRecord(actual) && isRecord(expected)) {
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return canonicalJson(actualKeys) === canonicalJson(expectedKeys) &&
      expectedKeys.every((key) => requestValueEqual(actual[key], expected[key]));
  }
  return canonicalJson(actual) === canonicalJson(expected);
}

function sanitizeManifest(manifest: ProviderManifest): ProviderManifest {
  const copy = { ...(manifest as unknown as Record<string, unknown>) };
  delete copy.fixture_version_added;
  return copy as unknown as ProviderManifest;
}

export function firstLogMismatch(
  actual: readonly SerializableLogEvent[],
  expected: readonly SerializableLogEvent[],
): string | undefined {
  const normalized = normalizeActualLogForExpected(actual, expected);
  return canonicalJson(normalized) === canonicalJson(expected)
    ? undefined
    : `actual:   ${canonicalJson(normalized)}\nexpected: ${canonicalJson(expected)}`;
}

function normalizeActualLogForExpected(
  actual: readonly SerializableLogEvent[],
  expected: readonly SerializableLogEvent[],
): readonly SerializableLogEvent[] {
  return actual.map((event, index) => normalizeActualEventForExpected(event, expected[index]));
}

function normalizeActualEventForExpected(
  actual: SerializableLogEvent,
  expected: SerializableLogEvent | undefined,
): SerializableLogEvent {
  if (expected === undefined) {
    return actual;
  }

  const out: Record<string, unknown> = {
    seq: actual.seq,
    type: actual.type,
    payload: normalizeActualPayloadForExpected(actual.payload, expected.payload),
  };
  if (expected.timestamp === "<generated>" && actual.timestamp !== undefined) {
    out.timestamp = "<generated>";
  } else if (expected.timestamp !== undefined) {
    out.timestamp = actual.timestamp;
  }
  return out as unknown as SerializableLogEvent;
}

function normalizeActualPayloadForExpected(actual: unknown, expected: unknown): unknown {
  if (expected === "<generated>") {
    return "<generated>";
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.map((item, index) => normalizeActualPayloadForExpected(item, expected[index]));
  }
  if (!isRecord(actual) || !isRecord(expected)) {
    return actual;
  }

  const out: Record<string, unknown> = { ...actual };
  for (const key of Object.keys(expected)) {
    out[key] = normalizeActualPayloadForExpected(actual[key], expected[key]);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const providerScriptPath = join(fixturePath, "provider-script.json");
  const streamScriptPath = join(fixturePath, "provider-script-stream.json");
  const streaming = await exists(streamScriptPath);
  const inputsPath = join(fixturePath, "inputs.json");
  const hasInputs = await exists(inputsPath);
  const projectionsPath = join(fixturePath, "expected-projections.jsonl");
  const isolationPath = join(fixturePath, "isolation.json");
  const sessionsPath = join(fixturePath, "sessions");
  const expectedProjections = await exists(projectionsPath)
    ? await readJsonlFile<ProjectionExpectation>(projectionsPath)
    : undefined;
  const deltasPath = join(fixturePath, "expected-deltas.jsonl");
  const expectedDeltas = await exists(deltasPath)
    ? await readJsonlFile<SerializableStreamEvent>(deltasPath)
    : undefined;
  const staticSessions = !hasInputs || expectedProjections !== undefined
    ? await readSessionFixtures(sessionsPath)
    : undefined;
  return {
    manifest: await readJsonFile<ProviderManifest>(join(fixturePath, "manifest.json")),
    inputs: hasInputs ? await readJsonFile<readonly unknown[]>(inputsPath) : [],
    script: streaming
      ? await readJsonFile<readonly unknown[]>(streamScriptPath)
      : await (exists(providerScriptPath).then((ok) => ok ? readJsonFile<readonly ProviderScriptTurn[]>(providerScriptPath) : Promise.resolve([]))),
    streaming,
    expectedLog: await readJsonlFile<SerializableLogEvent>(join(fixturePath, "expected-log.jsonl")),
    ...((await exists(isolationPath)) ? { isolation: await readJsonFile<{ readonly repeat?: number }>(isolationPath) } : {}),
    ...(expectedProjections === undefined ? {} : { expectedProjections }),
    ...(expectedDeltas === undefined ? {} : { expectedDeltas }),
    ...(staticSessions === undefined ? {} : { staticSessions }),
    ...(hasInputs ? {} : { staticLog: sessionLogFromFile(await readSessionFile(join(sessionsPath, "parent.jsonl"))) }),
  };
}

async function readSessionFixtures(path: string): Promise<ReadonlyMap<string, Session>> {
  const sessions = new Map<string, Session>();
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const session = Session.fromJsonl(await readText(join(path, entry.name)));
    sessions.set(session.header.session_id, session);
  }
  return sessions;
}

async function readSessionFile(path: string): Promise<Session> {
  return Session.fromJsonl(await readText(path));
}

function sessionLogFromFile(session: Session): readonly SerializableLogEvent[] {
  return session.log.serializableEvents();
}

function assertExpectedProjections(files: FixtureFiles): void {
  if (files.expectedProjections === undefined) {
    return;
  }
  if (files.staticSessions === undefined) {
    throw new ConformanceError("expected projections require session fixtures");
  }
  const actual = files.expectedProjections.map((expectation) => ({
    projection: expectation.projection,
    input: expectation.input,
    output: projectSessionFixture(files.staticSessions as ReadonlyMap<string, Session>, expectation.projection, expectation.input),
  }));
  if (canonicalJson(actual) !== canonicalJson(files.expectedProjections)) {
    throw new ConformanceError(
      `projection mismatch\nactual:   ${canonicalJson(actual)}\nexpected: ${canonicalJson(files.expectedProjections)}`,
    );
  }
}

function projectSessionFixture(
  sessions: ReadonlyMap<string, Session>,
  projection: string,
  input: string,
): unknown {
  switch (projection) {
    case "delegation_tree":
      return delegationTree(input, sessions);
    case "open_children":
      return openChildren(input, sessions);
    case "descendant_usage":
      return descendantUsage(input, sessions);
    case "descendant_timeline":
      return descendantTimeline(input, sessions);
    default:
      throw new ConformanceError(`unsupported projection fixture: ${projection}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return await readFile(path, "utf8");
}

function stripFrontmatter(text: string): string {
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---\n")) {
    return text;
  }
  const end = text.indexOf("\n---\n", 4);
  return end === -1 ? text : text.slice(end + 5);
}
