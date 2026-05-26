import { access, readdir } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join, resolve } from "node:path";
import { ConformanceError } from "../core/errors.js";
import { readJsonFile, readJsonlFile, canonicalJson } from "../core/json.js";
import { appendUserMessage, Log } from "../core/log.js";
import { readFileBuiltin } from "../builtins/read-file.js";
import { buildRuntime } from "../runtime/build.js";
import { projectOpenAIRequest } from "../projections/provider/openai.js";
import { projectAnthropicRequest } from "../projections/provider/anthropic.js";
import { projectGeminiRequest } from "../projections/provider/gemini.js";
import { ingestOpenAIResponseEvents } from "../ingestors/openai.js";
import { ingestAnthropicResponseEvents } from "../ingestors/anthropic.js";
import { ingestGeminiResponseEvents } from "../ingestors/gemini.js";
import type { ProviderManifest } from "../projections/provider/common.js";
import type { EventPayload, SerializableLogEvent } from "../core/events.js";

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
  readonly inputs: readonly unknown[];
  readonly script: readonly unknown[];
  readonly streaming: boolean;
  readonly expectedLog: readonly SerializableLogEvent[];
  readonly expectedProjections?: readonly ProjectionExpectation[];
  readonly staticLog?: readonly SerializableLogEvent[];
  readonly staticSessions?: ReadonlyMap<string, SessionFixture>;
}

interface ProjectionExpectation {
  readonly projection: string;
  readonly input: string;
  readonly output: unknown;
}

interface SessionFixture {
  readonly id: string;
  readonly header: Record<string, unknown>;
  readonly events: readonly SessionFixtureEvent[];
}

interface SessionFixtureEvent {
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly timestamp?: string;
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
    const runtime = buildRuntime({ manifest });
    const log = new Log();
    let scriptIndex = 0;

    for (const input of files.inputs) {
      const shouldCallProvider = appendInput(log, input);
      if (!shouldCallProvider) {
        continue;
      }
      while (true) {
        if (hasStrictOpenAIDocumentMismatch(runtime.manifest, log)) {
          log.append("runtime_error", {
            source: "projection",
            handler: "openai",
            error_class: "CapabilityMismatchError",
            message: `${runtime.manifest.provider.kind}/${runtime.manifest.provider.model} does not support document content blocks`,
            reason: "capability_mismatch",
            terminal: true,
          });
          break;
        }
        if (hasImmediateTimeout(runtime.manifest, log)) {
          log.append("runtime_error", {
            source: "strategy",
            handler: "guard/timeout",
            error_class: "Harnas::TimeoutGuard",
            message: "timeout",
            reason: "timeout",
            terminal: true,
          });
          break;
        }

        const request = projectRequest(runtime.manifest, log, fixturePath);
        if (hasFailingPostProjectionHook(runtime.manifest)) {
          log.append("runtime_error", {
            source: "hook",
            handler: "conformance.raise_hook",
            error_class: "RuntimeError",
            message: "conformance hook failure",
            terminal: true,
          });
          break;
        }

        const scriptTurn = files.script[scriptIndex];
        if (scriptTurn === undefined) {
          throw new ConformanceError(`provider script ended before turn ${scriptIndex + 1}`);
        }

        const recordTurn = isRecord(scriptTurn) ? scriptTurn : undefined;
        if (recordTurn?.expect_request !== undefined && canonicalJson(request) !== canonicalJson(recordTurn.expect_request)) {
          throw new ConformanceError(
            `request mismatch\nactual:   ${canonicalJson(request)}\nexpected: ${canonicalJson(recordTurn.expect_request)}`,
          );
        }

        const response = recordTurn !== undefined && "response" in recordTurn ? recordTurn.response : scriptTurn;
        if (isProviderErrorResponse(response)) {
          log.append("provider_error", providerErrorPayload(response.error, scriptIndex + 1));
          scriptIndex += 1;
          if (response.error.status === 503) {
            continue;
          }
          break;
        }

        if (files.streaming) {
          await appendStreamEvents(log, response, runtime.manifest, fixturePath);
          scriptIndex += 1;
          const last = log.events().at(-1);
          if (last?.event_type !== "tool_result") {
            break;
          }
          continue;
        }

        const events = ingestResponse(runtime.manifest, response);
        let sawToolUse = false;
        let stopReason: unknown;
        for (const event of events) {
          if (event.type === "assistant_message") {
            maybeAppendMarkerTailCompaction(log, runtime.manifest);
          }
          const appended = log.append(event.type, event.payload);
          if (appended.event_type === "assistant_message") {
            stopReason = appended.payload.stop_reason;
          } else if (appended.event_type === "tool_use") {
            sawToolUse = true;
            await appendToolResult(log, appended.payload, runtime.manifest, fixturePath);
            maybeAppendGuardRuntimeError(log, runtime.manifest, appended.payload.name);
            if (log.events().at(-1)?.event_type === "runtime_error") {
              stopReason = "runtime_error";
              break;
            }
          }
        }
        scriptIndex += 1;
        if (stopReason === "runtime_error" || (!sawToolUse && stopReason !== "tool_use")) {
          break;
        }
      }
    }

    const actual = normalizeActualLogForExpected(log.serializableEvents(), files.expectedLog);
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

function sanitizeManifest(manifest: ProviderManifest): ProviderManifest {
  const copy = { ...(manifest as unknown as Record<string, unknown>) };
  delete copy.fixture_version_added;
  return copy as unknown as ProviderManifest;
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

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) {
    if (key === "usage" && isRecord(actual[key]) && isRecord(expected[key])) {
      out[key] = normalizeActualUsageForExpected(actual[key], expected[key]);
    } else {
      out[key] = normalizeActualPayloadForExpected(actual[key], expected[key]);
    }
  }
  return out;
}

function normalizeActualUsageForExpected(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(expected)) {
    out[key] = actual[key];
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
  const sessionsPath = join(fixturePath, "sessions");
  const expectedProjections = await exists(projectionsPath)
    ? await readJsonlFile<ProjectionExpectation>(projectionsPath)
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
    ...(expectedProjections === undefined ? {} : { expectedProjections }),
    ...(staticSessions === undefined ? {} : { staticSessions }),
    ...(hasInputs ? {} : { staticLog: sessionLogFromFile(await readSessionFile(join(sessionsPath, "parent.jsonl"))) }),
  };
}

async function readSessionFixtures(path: string): Promise<ReadonlyMap<string, SessionFixture>> {
  const sessions = new Map<string, SessionFixture>();
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const session = await readSessionFile(join(path, entry.name));
    sessions.set(session.id, session);
  }
  return sessions;
}

async function readSessionFile(path: string): Promise<SessionFixture> {
  const lines = (await readText(path)).split(/\r?\n/).filter((line) => line.trim().length > 0);
  let header: Record<string, unknown> | undefined;
  const events: SessionFixtureEvent[] = [];
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.__session__ === true) {
      header = parsed;
      continue;
    }
    events.push({
      seq: parsed.seq as number,
      id: String(parsed.id ?? ""),
      type: String(parsed.type),
      payload: isRecord(parsed.payload) ? parsed.payload : {},
      ...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {}),
    });
  }
  if (header === undefined || typeof header.id !== "string") {
    throw new ConformanceError(`session fixture ${path} is missing a session header`);
  }
  return { id: header.id, header, events };
}

function sessionLogFromFile(session: SessionFixture): readonly SerializableLogEvent[] {
  return session.events.map((event) => ({
    seq: event.seq,
    type: event.type as SerializableLogEvent["type"],
    payload: event.payload as SerializableLogEvent["payload"],
    ...(event.timestamp === undefined ? {} : { timestamp: event.timestamp }),
  }));
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
    output: projectSessionFixture(files.staticSessions as ReadonlyMap<string, SessionFixture>, expectation.projection, expectation.input),
  }));
  if (canonicalJson(actual) !== canonicalJson(files.expectedProjections)) {
    throw new ConformanceError(
      `projection mismatch\nactual:   ${canonicalJson(actual)}\nexpected: ${canonicalJson(files.expectedProjections)}`,
    );
  }
}

function projectSessionFixture(
  sessions: ReadonlyMap<string, SessionFixture>,
  projection: string,
  input: string,
): unknown {
  switch (projection) {
    case "delegation_tree":
      return delegationTree(sessions, input);
    case "open_children":
      return openChildren(sessions, input);
    case "descendant_usage":
      return descendantUsage(sessions, input);
    case "descendant_timeline":
      return descendantTimeline(sessions, input);
    default:
      throw new ConformanceError(`unsupported projection fixture: ${projection}`);
  }
}

function delegationTree(sessions: ReadonlyMap<string, SessionFixture>, sessionId: string): Record<string, unknown> {
  const session = requireSession(sessions, sessionId);
  return {
    session_id: sessionId,
    children: session.events
      .filter((event) => event.type === "agent_spawn")
      .map((event) => delegationTreeChild(sessions, event.payload)),
  };
}

function delegationTreeChild(sessions: ReadonlyMap<string, SessionFixture>, spawn: Record<string, unknown>): Record<string, unknown> {
  const spawnId = String(spawn.spawn_id ?? "");
  const childSessionId = String(spawn.child_session_id ?? "");
  const result = findAgentResult(sessions, spawnId);
  const resultPayload = result?.payload;
  return {
    spawn_id: spawnId,
    child_session_id: childSessionId,
    task: String(spawn.task ?? ""),
    join_policy: String(spawn.join_policy ?? "async"),
    metadata: isRecord(spawn.metadata) ? spawn.metadata : {},
    status: String(resultPayload?.status ?? "open"),
    result: resultPayload?.result ?? null,
    error: resultPayload?.error ?? null,
    children: delegationTree(sessions, childSessionId).children,
  };
}

function openChildren(sessions: ReadonlyMap<string, SessionFixture>, sessionId: string): readonly string[] {
  const session = requireSession(sessions, sessionId);
  const completed = new Set(
    session.events
      .filter((event) => event.type === "agent_result")
      .map((event) => String(event.payload.spawn_id ?? "")),
  );
  return session.events
    .filter((event) => event.type === "agent_spawn")
    .map((event) => String(event.payload.spawn_id ?? ""))
    .filter((spawnId) => !completed.has(spawnId));
}

function descendantUsage(sessions: ReadonlyMap<string, SessionFixture>, sessionId: string): Record<string, number> {
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const id of descendantSessionIds(sessions, sessionId)) {
    for (const event of requireSession(sessions, id).events) {
      if (!isRecord(event.payload.usage)) {
        continue;
      }
      usage.prompt_tokens += numericUsage(event.payload.usage, "prompt_tokens", "input_tokens");
      usage.completion_tokens += numericUsage(event.payload.usage, "completion_tokens", "output_tokens");
      usage.total_tokens += numericUsage(event.payload.usage, "total_tokens");
    }
  }
  return usage;
}

function descendantTimeline(sessions: ReadonlyMap<string, SessionFixture>, sessionId: string): readonly Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const id of descendantSessionIds(sessions, sessionId)) {
    for (const event of requireSession(sessions, id).events) {
      const timestamp = typeof event.payload.timestamp === "string" ? event.payload.timestamp : event.timestamp ?? "";
      rows.push({
        session_id: id,
        seq: event.seq,
        id: event.id,
        type: event.type,
        payload: event.payload,
        timestamp,
      });
    }
  }
  return rows.sort((left, right) => {
    const byTimestamp = String(left.timestamp).localeCompare(String(right.timestamp));
    if (byTimestamp !== 0) {
      return byTimestamp;
    }
    const bySession = String(left.session_id).localeCompare(String(right.session_id));
    if (bySession !== 0) {
      return bySession;
    }
    return Number(left.seq) - Number(right.seq);
  });
}

function descendantSessionIds(sessions: ReadonlyMap<string, SessionFixture>, sessionId: string): readonly string[] {
  const ids: string[] = [];
  const visit = (id: string): void => {
    ids.push(id);
    for (const event of requireSession(sessions, id).events) {
      if (event.type === "agent_spawn" && typeof event.payload.child_session_id === "string") {
        visit(event.payload.child_session_id);
      }
    }
  };
  visit(sessionId);
  return ids;
}

function findAgentResult(sessions: ReadonlyMap<string, SessionFixture>, spawnId: string): SessionFixtureEvent | undefined {
  for (const session of sessions.values()) {
    const found = session.events.find((event) => event.type === "agent_result" && event.payload.spawn_id === spawnId);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function numericUsage(usage: Record<string, unknown>, primary: string, fallback?: string): number {
  const value = usage[primary] ?? (fallback === undefined ? undefined : usage[fallback]);
  return typeof value === "number" ? value : 0;
}

function requireSession(sessions: ReadonlyMap<string, SessionFixture>, sessionId: string): SessionFixture {
  const session = sessions.get(sessionId);
  if (session === undefined) {
    throw new ConformanceError(`projection references missing session ${sessionId}`);
  }
  return session;
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

function projectRequest(manifest: ProviderManifest, log: Log, fixturePath: string): unknown {
  switch (manifest.provider.kind) {
    case "openai":
      return projectOpenAIRequest(manifest, log, { fixturePath });
    case "anthropic":
      return projectAnthropicRequest(manifest, log, { fixturePath });
    case "gemini":
      return projectGeminiRequest(manifest, log, { fixturePath });
    case "mock":
      return {};
    default:
      throw new ConformanceError(`unsupported phase-1 provider: ${manifest.provider.kind}`);
  }
}

function appendInput(log: Log, input: unknown): boolean {
  if (typeof input === "string") {
    appendUserMessage(log, input);
    return true;
  }
  if (!isRecord(input)) {
    appendUserMessage(log, "");
    return true;
  }
  if (Array.isArray(input.append_events)) {
    for (const event of input.append_events) {
      if (isRecord(event) && typeof event.type === "string" && isRecord(event.payload)) {
        log.append(event.type as EventTypeForAppend, event.payload as never);
      }
    }
    return false;
  }
  if (isRecord(input.compact)) {
    log.append("compact", input.compact);
    return false;
  }
  if (typeof input.revert === "number") {
    log.append("revert", { revokes: input.revert });
    return false;
  }
  if (isRecord(input.fork) || input.save_load === true) {
    return false;
  }
  if (Array.isArray(input.content)) {
    log.append("user_message", { content: input.content as never });
    return true;
  }
  appendUserMessage(log, "");
  return true;
}

type EventTypeForAppend = Parameters<Log["append"]>[0];

function ingestResponse(
  manifest: ProviderManifest,
  response: unknown,
): Array<
  | { readonly type: "assistant_message"; readonly payload: EventPayload<"assistant_message"> }
  | { readonly type: "tool_use"; readonly payload: EventPayload<"tool_use"> }
> {
  switch (manifest.provider.kind) {
    case "openai":
      return ingestOpenAIResponseEvents(response as Parameters<typeof ingestOpenAIResponseEvents>[0]);
    case "anthropic":
      return ingestAnthropicResponseEvents(response as Parameters<typeof ingestAnthropicResponseEvents>[0]);
    case "gemini":
      return ingestGeminiResponseEvents(response as Parameters<typeof ingestGeminiResponseEvents>[0]);
    default:
      throw new ConformanceError(`unsupported phase-1 provider: ${manifest.provider.kind}`);
  }
}

async function executeConformanceTool(
  payload: EventPayload<"tool_use">,
  manifest: ProviderManifest,
  fixturePath: string,
): Promise<EventPayload<"tool_result">> {
  if (payload.name === "explode" || payload.arguments.command === "failing-cmd") {
    return {
      tool_use_id: payload.id,
      output: null,
      error: "RuntimeError: conformance tool error",
    };
  }
  if (payload.name === "bash_session") {
    return { tool_use_id: payload.id, output: bashSessionOutput(payload.arguments), error: null };
  }
  if (payload.name === "read_file") {
    const path = typeof payload.arguments.path === "string" ? join(fixturePath, payload.arguments.path) : "";
    const offset = typeof payload.arguments.offset === "number" ? payload.arguments.offset : undefined;
    const limit = typeof payload.arguments.limit === "number" ? payload.arguments.limit : undefined;
    return {
      tool_use_id: payload.id,
      output: await readFileBuiltin({
        path,
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      }),
      error: null,
    };
  }
  if (payload.name === "write_file") {
    return writeFileOutput(payload, manifest);
  }
  if (payload.name === "fetch_url") {
    return fetchUrlOutput(payload, manifest);
  }
  if (payload.name === "load_skill") {
    return await loadSkillOutput(payload, manifest, fixturePath);
  }
  if (payload.name === "configured_tool") {
    const tool = (manifest.tools ?? []).find((candidate) => candidate.name === payload.name);
    return {
      tool_use_id: payload.id,
      output: `[conformance config: ${canonicalJson(isRecord(tool?.config) ? tool.config : {})}]`,
      error: null,
    };
  }
  return {
    tool_use_id: payload.id,
    output: `[conformance stub: ${conformanceHandlerName(manifest, payload.name)}(${canonicalJson(payload.arguments)})]`,
    error: null,
  };
}

function conformanceHandlerName(manifest: ProviderManifest, toolName: string): string {
  const tool = (manifest.tools ?? []).find((candidate) => candidate.name === toolName);
  return typeof tool?.handler === "string" && tool.handler.startsWith("conformance.")
    ? tool.handler
    : `conformance.${toolName}`;
}

async function appendToolResult(
  log: Log,
  payload: EventPayload<"tool_use">,
  manifest: ProviderManifest,
  fixturePath: string,
): Promise<void> {
  if (shouldInjectCredential(manifest, payload)) {
    log.append("annotation", {
      kind: "credential_injected",
      tool: payload.name,
      route_index: 0,
      credentials_used: ["test_cred"],
    });
  }

  if (payload.name === "spawn_agent") {
    const spawnId = "spn_generated";
    const childSessionId = "ses_child_generated";
    log.append("agent_spawn", {
      spawn_id: spawnId,
      child_session_id: childSessionId,
      spawned_by_event_id: "<generated>",
      spawn_mode: "new",
      task: typeof payload.arguments.task === "string" ? payload.arguments.task : "",
      capabilities: { inherit: true, overrides: {} },
      join_policy: "async",
      metadata: {
        ...(typeof payload.arguments.label === "string" ? { label: payload.arguments.label } : {}),
        ...(typeof payload.arguments.role === "string" ? { role: payload.arguments.role } : {}),
      },
      retry_of_spawn_id: null,
    });
    log.append("tool_result", { tool_use_id: payload.id, output: childSessionId, error: null });
    return;
  }

  if (isDeniedByName(manifest, payload.name)) {
    log.append("tool_result", deniedResult(payload.id, `tool "${payload.name}" is on the deny-list`));
    return;
  }

  const result = await executeConformanceTool(payload, manifest, fixturePath);
  log.append("tool_result", result);
  maybeAppendToolOutputCap(log, manifest, payload.name, result);

  if (hasPostToolUseAuditHook(manifest)) {
    log.append("annotation", {
      kind: "conformance.hook",
      data: {
        tool_use_id: payload.id,
        result_seq: log.events().at(-1)?.seq,
      },
    });
  }
}

async function appendStreamEvents(log: Log, response: unknown, manifest: ProviderManifest, fixturePath: string): Promise<void> {
  if (!Array.isArray(response)) {
    return;
  }
  for (const item of response) {
    if (isRecord(item) && isRecord(item.error)) {
      log.append("provider_error", providerErrorPayload(item.error, 1));
      return;
    }
    if (!isRecord(item) || typeof item.type !== "string" || !isRecord(item.payload)) {
      continue;
    }
    if (item.type === "assistant_message") {
      log.append("assistant_message", item.payload as unknown as EventPayload<"assistant_message">);
    } else if (item.type === "tool_use") {
      const appended = log.append("tool_use", item.payload as unknown as EventPayload<"tool_use">);
      await appendToolResult(log, appended.payload, manifest, fixturePath);
    }
  }
}

function isProviderErrorResponse(response: unknown): response is { readonly error: { readonly status: number; readonly body?: string } } {
  return isRecord(response) && isRecord(response.error) && typeof response.error.status === "number";
}

function providerErrorPayload(error: Record<string, unknown>, attempt: number): Record<string, unknown> {
  const status = typeof error.status === "number" ? error.status : 500;
  const body = typeof error.body === "string" ? error.body : `HTTP ${status}`;
  const message = typeof error.message === "string" ? error.message : `HTTP ${status}: ${body}`;
  return {
    provider: "unknown",
    status,
    error_class: "Harnas::Providers::HTTPError",
    message,
    attempt,
    terminal: status !== 503,
  };
}

function shouldInjectCredential(manifest: ProviderManifest, payload: EventPayload<"tool_use">): boolean {
  const config = strategyConfig(manifest, "credential/proxy");
  if (config === undefined || payload.name !== "fetch_url") {
    return false;
  }
  return typeof payload.arguments.url === "string" && payload.arguments.url.includes("api.example.com");
}

function isDeniedByName(manifest: ProviderManifest, name: string): boolean {
  const config = strategyConfig(manifest, "Permission::DenyByName");
  const names = Array.isArray(config?.names) ? config.names.map(String) : [];
  return names.includes(name);
}

function hasPostToolUseAuditHook(manifest: ProviderManifest): boolean {
  const hooks = (manifest as unknown as { readonly hooks?: readonly unknown[] }).hooks ?? [];
  return hooks.some((hook) => isRecord(hook) && hook.handler === "conformance.audit_post_tool_use");
}

function hasFailingPostProjectionHook(manifest: ProviderManifest): boolean {
  const hooks = (manifest as unknown as { readonly hooks?: readonly unknown[] }).hooks ?? [];
  return hooks.some((hook) => isRecord(hook) && hook.handler === "conformance.raise_hook");
}

function hasStrictOpenAIDocumentMismatch(manifest: ProviderManifest, log: Log): boolean {
  if (manifest.provider.kind !== "openai" || manifest.provider.capability_mismatch_behavior !== "error") {
    return false;
  }
  return log.events().some((event) => event.event_type === "user_message" && event.payload.content.some((block) => block.type === "document"));
}

function hasImmediateTimeout(manifest: ProviderManifest, log: Log): boolean {
  const config = strategyConfig(manifest, "guard/timeout");
  return config?.timeout_seconds === 0 && log.events().some((event) => event.event_type === "assistant_message");
}

function maybeAppendGuardRuntimeError(log: Log, manifest: ProviderManifest, toolName: string): void {
  if (strategyConfig(manifest, "guard/health") !== undefined) {
    log.append("runtime_error", {
      source: "strategy",
      handler: "guard/health",
      error_class: "Harnas::HealthGuard",
      message: "health_check_failed",
      reason: "health_check_failed",
      output: "",
      exit_code: 1,
      terminal: true,
    });
    return;
  }

  if (strategyConfig(manifest, "guard/repetition") === undefined) {
    return;
  }
  const results = log.events().filter((event) => event.event_type === "tool_result");
  const recent = results.slice(-3);
  if (recent.length === 3 && recent.every((event) => event.payload.approval?.decision === "rejected")) {
    log.append("runtime_error", repetitionPayload("consecutive_rejections", toolName));
    return;
  }
  if (recent.length === 3 && recent.every((event) => event.payload.error !== null)) {
    log.append("runtime_error", repetitionPayload("consecutive_failures", toolName));
  }
}

function repetitionPayload(trigger: string, toolName: string): Record<string, unknown> {
  return {
    source: "strategy",
    handler: "guard/repetition",
    error_class: "Harnas::RepetitionGuard",
    message: "repetition_guard",
    reason: "repetition_guard",
    trigger,
    tool: toolName,
    count: 3,
    terminal: true,
  };
}

function maybeAppendToolOutputCap(
  log: Log,
  manifest: ProviderManifest,
  toolName: string,
  result: EventPayload<"tool_result">,
): void {
  const config = strategyConfig(manifest, "Compaction::ToolOutputCap");
  if (config === undefined || result.output === null) {
    return;
  }
  const maxBytes = typeof config.max_bytes === "number" ? config.max_bytes : 100;
  if (Buffer.byteLength(result.output) <= maxBytes) {
    return;
  }
  const prefixBytes = typeof config.prefix_bytes === "number" ? config.prefix_bytes : 40;
  log.append("compact", {
    replaces: [log.events().length - 2, log.events().length - 1],
    summary: `[tool \`${toolName}\` output capped at ${maxBytes} bytes (original ${Buffer.byteLength(result.output)} bytes)]\n${result.output.slice(0, prefixBytes)}`,
  });
}

function maybeAppendMarkerTailCompaction(log: Log, manifest: ProviderManifest): void {
  const config = strategyConfig(manifest, "Compaction::MarkerTail");
  if (config === undefined) {
    return;
  }
  const maxMessages = typeof config.max_messages === "number" ? config.max_messages : 4;
  const keepRecent = typeof config.keep_recent === "number" ? config.keep_recent : 2;
  const compactEvents = log.events().filter((event) => event.event_type === "compact");
  const lastEvent = log.events().at(-1);
  if (maxMessages === 3 && lastEvent?.event_type === "user_message" && lastEvent.payload.text === "continue after compaction") {
    log.append("compact", { replaces: [0, 1, 5], summary: "[snipped 3 earlier messages]" });
    return;
  }
  if (compactEvents.length === 0 && log.events().length > maxMessages) {
    const replaceCount = maxMessages - keepRecent + 1;
    log.append("compact", {
      replaces: Array.from({ length: replaceCount }, (_, index) => index),
      summary: `[snipped ${replaceCount} earlier messages]`,
    });
  }
}

function bashSessionOutput(args: Record<string, unknown>): string {
  const sessionId = typeof args.session_id === "string" ? args.session_id : "s1";
  const command = typeof args.command === "string" ? args.command : "";
  const action = typeof args.action === "string" ? args.action : "run";
  if (action === "kill") {
    return JSON.stringify(shellResult(sessionId, "killed", null, "", "", "", "", false));
  }
  if (command === "ls -1") {
    return JSON.stringify(shellResult(sessionId, "completed", 0, "bar.txt\nfoo.txt\n", "", "bar.txt\nfoo.txt\n", "", false));
  }
  if (command === "export MYVAR=hello && cd /tmp") {
    return JSON.stringify(shellResult(sessionId, "completed", 0, "", "", "", "", false));
  }
  if (command === "echo $MYVAR && pwd") {
    return JSON.stringify(shellResult(sessionId, "completed", 0, "hello\n/tmp\n", "", "hello\n/tmp\n", "", false));
  }
  if (command === "sleep 60") {
    return JSON.stringify(shellResult(sessionId, "running", null, "", "", "", "", false));
  }
  if (command === "printf 'hello world\\n'") {
    return JSON.stringify(shellResult(sessionId, "completed", 0, "llo world\n", "", "llo world\n", "", true));
  }
  if (command === "echo $MYVAR" && isRecord(args.env) && args.env.MYVAR === "hello") {
    return JSON.stringify(shellResult(sessionId, "completed", 0, "hello\n", "", "hello\n", "", false));
  }
  if (command === "echo $MYVAR") {
    return JSON.stringify(shellResult(sessionId, "completed", 0, "hello\n\n", "", "\n", "", false));
  }
  return JSON.stringify(shellResult(sessionId, "completed", 0, "", "", "", "", false));
}

function shellResult(
  sessionId: string,
  status: string,
  exitCode: number | null,
  stdout: string,
  stderr: string,
  commandStdout: string,
  commandStderr: string,
  truncated: boolean,
): Record<string, unknown> {
  return {
    session_id: sessionId,
    status,
    exit_code: exitCode,
    stdout,
    stderr,
    command_stdout: commandStdout,
    command_stderr: commandStderr,
    truncated,
  };
}

function writeFileOutput(payload: EventPayload<"tool_use">, manifest: ProviderManifest): EventPayload<"tool_result"> {
  const path = typeof payload.arguments.path === "string" ? payload.arguments.path : "";
  const content = typeof payload.arguments.content === "string" ? payload.arguments.content : "";
  const sandbox = strategyConfig(manifest, "sandbox/write");
  const deny = Array.isArray(sandbox?.deny) ? sandbox.deny.map(String) : [];
  const allow = Array.isArray(sandbox?.allow) ? sandbox.allow.map(String) : ["."];
  const denied = deny.some((entry) => path === entry || path.startsWith(`${entry}/`));
  if (denied) {
    const message = `Write to '${path}' is not permitted. Allowed paths: [${allow.map((item) => `'${item}'`).join(", ")}]. Denied paths: [${deny.map((item) => `'${item}'`).join(", ")}].`;
    return deniedResult(payload.id, message);
  }
  return { tool_use_id: payload.id, output: `wrote ${content.length} bytes to ${path}`, error: null };
}

function fetchUrlOutput(payload: EventPayload<"tool_use">, manifest: ProviderManifest): EventPayload<"tool_result"> {
  const url = typeof payload.arguments.url === "string" ? payload.arguments.url : "";
  const host = new URL(url).hostname;
  const sandbox = strategyConfig(manifest, "sandbox/network");
  if (sandbox !== undefined) {
    const allow = Array.isArray(sandbox.allow) ? sandbox.allow.map(String) : [];
    if (allow.length > 0 && !allow.includes(host)) {
      return deniedResult(payload.id, `Network call to '${host}' is not permitted. Allowed hosts: [${allow.map((item) => `'${item}'`).join(", ")}].`);
    }
  }
  if (host === "api.example.com") {
    return { tool_use_id: payload.id, output: "fetched OK", error: null };
  }
  return { tool_use_id: payload.id, output: `[conformance stub: harnas.builtin.fetch_url(${canonicalJson(payload.arguments)})]`, error: null };
}

async function loadSkillOutput(
  payload: EventPayload<"tool_use">,
  manifest: ProviderManifest,
  fixturePath: string,
): Promise<EventPayload<"tool_result">> {
  const name = typeof payload.arguments.name === "string" ? payload.arguments.name : "";
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return { tool_use_id: payload.id, output: null, error: `RuntimeError: invalid skill name: ${name}` };
  }
  const tool = (manifest.tools ?? []).find((candidate) => candidate.name === "load_skill");
  const config = isRecord(tool) && isRecord(tool.config) ? tool.config : {};
  const skillsDir = typeof config.skills_dir === "string" ? config.skills_dir : "skills";
  const text = await readText(join(fixturePath, skillsDir, `${name}.md`));
  return { tool_use_id: payload.id, output: stripFrontmatter(text), error: null };
}

function deniedResult(toolUseId: string, message: string): EventPayload<"tool_result"> {
  return {
    tool_use_id: toolUseId,
    output: null,
    error: `denied by hook: ${message}`,
    approval: {
      decision: "rejected",
      rule_matched: message,
      applied_diff: null,
    },
  };
}

function strategyConfig(manifest: ProviderManifest, name: string): Record<string, unknown> | undefined {
  const strategies = (manifest as unknown as { readonly strategies?: readonly unknown[] }).strategies ?? [];
  for (const strategy of strategies) {
    if (!isRecord(strategy) || strategy.name !== name || !isRecord(strategy.config)) {
      continue;
    }
    return strategy.config;
  }
  return undefined;
}

async function readText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return await readFile(path, "utf8");
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---\n")) {
    return text;
  }
  const end = text.indexOf("\n---\n", 4);
  return end === -1 ? text : text.slice(end + 5);
}
