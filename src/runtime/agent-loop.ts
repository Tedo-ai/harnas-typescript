import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ConformanceError } from "../core/errors.js";
import type { EventPayload } from "../core/events.js";
import type { Log } from "../core/log.js";
import { normalizeUsage } from "../core/usage.js";
import { projectAnthropicRequest } from "../projections/provider/anthropic.js";
import type { ProviderManifest } from "../projections/provider/common.js";
import { projectGeminiRequest } from "../projections/provider/gemini.js";
import { projectOpenAIRequest } from "../projections/provider/openai.js";
import { ingestAnthropicResponseEvents } from "../ingestors/anthropic.js";
import { ingestGeminiResponseEvents } from "../ingestors/gemini.js";
import { ingestOpenAIResponseEvents } from "../ingestors/openai.js";
import type { ToolRegistry } from "../tools/registry.js";
import { newSessionId } from "../core/ids.js";

export interface ScriptedProvider {
  next(request: unknown): Promise<unknown>;
}

export interface AgentLoopOptions {
  readonly manifest: ProviderManifest;
  readonly log: Log;
  readonly provider: ScriptedProvider;
  readonly tools: ToolRegistry;
  readonly fixturePath?: string;
  readonly streaming?: boolean;
}

export class AgentLoop {
  readonly #manifest: ProviderManifest;
  readonly #log: Log;
  readonly #provider: ScriptedProvider;
  readonly #tools: ToolRegistry;
  readonly #fixturePath: string | undefined;
  readonly #streaming: boolean;
  #providerCalls = 0;

  constructor(options: AgentLoopOptions) {
    this.#manifest = options.manifest;
    this.#log = options.log;
    this.#provider = options.provider;
    this.#tools = options.tools;
    this.#fixturePath = options.fixturePath;
    this.#streaming = options.streaming ?? false;
  }

  async runAfterInput(): Promise<void> {
    let attempt = 1;
    while (true) {
      this.#maybeAppendMarkerTailCompaction();
      if (this.#maybeAppendSessionTimeout()) {
        return;
      }
      if (this.#maybeAppendStrictCapabilityMismatch()) {
        return;
      }
      const request = this.#projectRequest();
      if (this.#hasHook("conformance.raise_hook")) {
        this.#log.append("runtime_error", {
          source: "hook",
          handler: "conformance.raise_hook",
          error_class: "RuntimeError",
          message: "conformance hook failure",
          terminal: true,
        });
        return;
      }
      const response = await this.#provider.next(request);
      this.#providerCalls += 1;

      if (isProviderErrorResponse(response)) {
        this.#log.append("provider_error", providerErrorPayload(response.error, attempt));
        attempt += 1;
        if (response.error.status === 503) {
          continue;
        }
        return;
      }

      if (this.#streaming) {
        await this.#appendStreamEvents(response);
        const last = this.#log.events().at(-1);
        if (last?.event_type !== "tool_result") {
          return;
        }
        continue;
      }

      const events = this.#ingestResponse(response);
      let sawToolUse = false;
      let stopReason: unknown;
      for (const event of events) {
        const payload = event.type === "assistant_message" ? this.#stampAssistantPayload(event.payload) : event.payload;
        const appended = this.#log.append(event.type, payload as never);
        if (appended.event_type === "assistant_message") {
          stopReason = appended.payload.stop_reason;
        } else if (appended.event_type === "tool_use") {
          sawToolUse = true;
          await this.#dispatchTool(appended.payload);
        }
      }

      if (!sawToolUse && stopReason !== "tool_use") {
        return;
      }
      if (this.#maybeAppendPostToolGuards()) {
        return;
      }
    }
  }

  #projectRequest(): unknown {
    const options = this.#fixturePath === undefined ? {} : { fixturePath: this.#fixturePath };
    switch (this.#manifest.provider.kind) {
      case "openai":
        return projectOpenAIRequest(this.#manifest, this.#log, options);
      case "anthropic":
      case "mock":
        return projectAnthropicRequest(this.#manifest, this.#log, options);
      case "gemini":
        return projectGeminiRequest(this.#manifest, this.#log, options);
      default:
        throw new ConformanceError(`unsupported provider: ${this.#manifest.provider.kind}`);
    }
  }

  #ingestResponse(
    response: unknown,
  ): Array<
    | { readonly type: "assistant_message"; readonly payload: EventPayload<"assistant_message"> }
    | { readonly type: "tool_use"; readonly payload: EventPayload<"tool_use"> }
  > {
    switch (this.#manifest.provider.kind) {
      case "openai":
        return ingestOpenAIResponseEvents(response as Parameters<typeof ingestOpenAIResponseEvents>[0]);
      case "anthropic":
      case "mock":
        return ingestAnthropicResponseEvents(response as Parameters<typeof ingestAnthropicResponseEvents>[0]);
      case "gemini":
        return ingestGeminiResponseEvents(response as Parameters<typeof ingestGeminiResponseEvents>[0], {
          toolCallOffset: this.#geminiToolCallOffset(),
        });
      default:
        throw new ConformanceError(`unsupported provider: ${this.#manifest.provider.kind}`);
    }
  }

  #geminiToolCallOffset(): number {
    return this.#log.events().filter((event) =>
      event.event_type === "tool_use" &&
      typeof event.payload.id === "string" &&
      event.payload.id.startsWith("gemini.")
    ).length;
  }

  async #appendStreamEvents(response: unknown): Promise<void> {
    if (!Array.isArray(response)) {
      return;
    }
    for (const item of response) {
      if (isRecord(item) && isRecord(item.error)) {
        this.#log.append("provider_error", providerErrorPayload(item.error, 1));
        return;
      }
      if (isRecord(item) && isRecord(item.malformed_frame)) {
        this.#log.append("provider_error", providerErrorPayload(item.malformed_frame, 1));
        return;
      }
      if (!isRecord(item) || typeof item.type !== "string" || !isRecord(item.payload)) {
        continue;
      }
      if (item.type === "assistant_message") {
        this.#log.append(
          "assistant_message",
          this.#stampAssistantPayload(item.payload as unknown as EventPayload<"assistant_message">),
        );
      } else if (item.type === "tool_use") {
        const appended = this.#log.append("tool_use", item.payload as unknown as EventPayload<"tool_use">);
        await this.#dispatchTool(appended.payload);
      }
    }
  }

  async #dispatchTool(payload: EventPayload<"tool_use">): Promise<void> {
    if (payload.name === "spawn_agent") {
      this.#dispatchSpawnAgent(payload);
      return;
    }
    const refusal = this.#preToolUseRefusal(payload);
    if (refusal !== undefined) {
      this.#log.append("tool_result", refusal);
      return;
    }

    try {
      const args = this.#credentialProxyArgs(payload);
      const output = await this.#tools.dispatch(payload.name, args);
      this.#log.append("tool_result", {
        tool_use_id: payload.id,
        output,
        error: null,
      });
      this.#maybeAppendPostToolUseAudit(payload.id);
      this.#maybeAppendToolOutputCap(payload.name, output);
    } catch (error) {
      this.#log.append("tool_result", {
        tool_use_id: payload.id,
        output: null,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }

  #dispatchSpawnAgent(payload: EventPayload<"tool_use">): void {
    const task = typeof payload.arguments.task === "string" ? payload.arguments.task : "";
    const label = typeof payload.arguments.label === "string" ? payload.arguments.label : undefined;
    const role = typeof payload.arguments.role === "string" ? payload.arguments.role : undefined;
    const spawnId = `spn_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    const childSessionId = newSessionId();
    const toolUseEvent = this.#log.events().find((event) => event.event_type === "tool_use" && event.payload.id === payload.id);
    this.#log.append("agent_spawn", {
      spawn_id: spawnId,
      child_session_id: childSessionId,
      spawned_by_event_id: toolUseEvent?.id ?? payload.id,
      spawn_mode: "new",
      task,
      capabilities: {
        inherit: true,
        overrides: {},
      },
      join_policy: "async",
      metadata: {
        ...(label === undefined ? {} : { label }),
        ...(role === undefined ? {} : { role }),
      },
      retry_of_spawn_id: null,
    });
    this.#log.append("tool_result", {
      tool_use_id: payload.id,
      output: `spawned child session ${childSessionId}`,
      error: null,
    });
  }

  #preToolUseRefusal(payload: EventPayload<"tool_use">): EventPayload<"tool_result"> | undefined {
    const permission = strategyConfig(this.#manifest, "Permission::DenyByName");
    const deniedNames = Array.isArray(permission?.names) ? permission.names.map(String) : [];
    if (deniedNames.includes(payload.name)) {
      return deniedResult(payload.id, `tool "${payload.name}" is on the deny-list`);
    }

    if (payload.name === "write_file") {
      const sandbox = strategyConfig(this.#manifest, "sandbox/write");
      if (sandbox !== undefined) {
        const path = typeof payload.arguments.path === "string" ? payload.arguments.path : "";
        const denyLabels = Array.isArray(sandbox.deny) ? sandbox.deny.map(String) : [];
        const allowLabels = Array.isArray(sandbox.allow) ? sandbox.allow.map(String) : ["."];
        const deny = denyLabels.map((entry) => normalizeSandboxPath(entry));
        const allow = allowLabels.map((entry) => normalizeSandboxPath(entry));
        const normalized = normalizeSandboxPath(path);
        const allowed = allow.some((entry) => pathWithin(normalized, entry));
        const denied = deny.some((entry) => pathWithin(normalized, entry));
        if (path !== "" && (!allowed || denied)) {
        const message = `Write to '${path}' is not permitted. Allowed paths: [${allowLabels.map((item) => `'${item}'`).join(", ")}]. Denied paths: [${denyLabels.map((item) => `'${item}'`).join(", ")}].`;
        return deniedResult(payload.id, message);
        }
      }
    }

    if (payload.name === "fetch_url") {
      const sandbox = strategyConfig(this.#manifest, "sandbox/network");
      if (sandbox !== undefined) {
        const url = typeof payload.arguments.url === "string" ? payload.arguments.url : "";
        const host = safeURLHost(url);
        if (host === undefined) {
          return deniedResult(payload.id, "Network call has an unparseable URL and is not permitted.");
        }
        const allow = Array.isArray(sandbox.allow) ? sandbox.allow.map(String) : [];
        if (allow.length > 0 && !allow.includes(host)) {
          return deniedResult(payload.id, `Network call to '${host}' is not permitted. Allowed hosts: [${allow.map((item) => `'${item}'`).join(", ")}].`);
        }
      }
    }

    return undefined;
  }

  #credentialProxyArgs(payload: EventPayload<"tool_use">): Record<string, unknown> {
    const config = strategyConfig(this.#manifest, "credential/proxy");
    if (config === undefined || !Array.isArray(config.routes)) {
      return payload.arguments;
    }
    const credentials = isRecord(config.credentials) ? config.credentials : {};
    let args: Record<string, unknown> = { ...payload.arguments };
    config.routes.forEach((route, index) => {
      if (!isRecord(route) || route.tool !== payload.name || !isRecord(route.inject)) {
        return;
      }
      if (!credentialRouteMatches(route.match, args)) {
        return;
      }
      if (route.inject.into !== "headers" || typeof route.inject.key !== "string" || typeof route.inject.value !== "string") {
        return;
      }
      const used = credentialNames(route.inject.value);
      let value = route.inject.value;
      for (const name of used) {
        const credential = credentials[name];
        const credentialValue = resolveCredentialValue(credential);
        if (credentialValue === undefined) {
          throw new Error(`credential '${name}' is not available; required by credential/proxy route matching tool '${payload.name}'`);
        }
        value = value.replaceAll(`{credential.${name}}`, credentialValue);
      }
      const headers = isRecord(args.headers) ? args.headers : {};
      args = { ...args, headers: { ...headers, [route.inject.key]: value } };
      this.#log.append("annotation", {
        kind: "credential_injected",
        tool: payload.name,
        route_index: index,
        credentials_used: used,
      });
    });
    return args;
  }

  #stampAssistantPayload(payload: EventPayload<"assistant_message">): EventPayload<"assistant_message"> {
    return {
      ...payload,
      provider: payload.provider ?? (this.#manifest.provider.kind === "mock" ? "unknown" : this.#manifest.provider.kind),
      model: payload.model ?? this.#manifest.provider.model,
      ...(payload.usage === undefined ? {} : { usage: normalizeUsage(payload.usage) }),
    };
  }

  #maybeAppendToolOutputCap(toolName: string, output: string): void {
    const config = strategyConfig(this.#manifest, "Compaction::ToolOutputCap");
    if (config === undefined) {
      return;
    }
    const maxBytes = typeof config.max_bytes === "number" ? config.max_bytes : 100;
    if (Buffer.byteLength(output) <= maxBytes) {
      return;
    }
    const prefixBytes = typeof config.prefix_bytes === "number" ? config.prefix_bytes : 40;
    this.#log.append("compact", {
      replaces: [this.#log.events().length - 2, this.#log.events().length - 1],
      summary: `[tool \`${toolName}\` output capped at ${maxBytes} bytes (original ${Buffer.byteLength(output)} bytes)]\n${output.slice(0, prefixBytes)}`,
    });
  }

  #maybeAppendPostToolUseAudit(toolUseId: string): void {
    if (!this.#hasHook("conformance.audit_post_tool_use")) {
      return;
    }
    this.#log.append("annotation", {
      kind: "conformance.hook",
      data: {
        tool_use_id: toolUseId,
        result_seq: this.#log.events().at(-1)?.seq,
      },
    });
  }

  #maybeAppendPostToolGuards(): boolean {
    return this.#maybeAppendRepetitionGuard() || this.#maybeAppendHealthGuard();
  }

  #maybeAppendRepetitionGuard(): boolean {
    const config = strategyConfig(this.#manifest, "guard/repetition");
    if (config === undefined) {
      return false;
    }
    const maxFailures = typeof config.max_consecutive_failures === "number" ? config.max_consecutive_failures : 3;
    const maxRejections = typeof config.max_consecutive_rejections === "number" ? config.max_consecutive_rejections : undefined;
    const toolResults = this.#log.events().filter((event) => event.event_type === "tool_result").map((event) => event.payload);
    if (toolResults.length === 0) {
      return false;
    }
    const failures = trailingCount(toolResults, (payload) => payload.error !== null && payload.approval?.decision !== "rejected");
    if (failures >= maxFailures) {
      const tool = toolNameForResult(this.#log, toolResults.at(-1)?.tool_use_id);
      this.#log.append("runtime_error", {
        source: "strategy",
        handler: "guard/repetition",
        error_class: "Harnas::RepetitionGuard",
        message: "repetition_guard",
        reason: "repetition_guard",
        trigger: "consecutive_failures",
        tool,
        count: failures,
        terminal: true,
      });
      return true;
    }
    if (maxRejections !== undefined) {
      const rejections = trailingCount(toolResults, (payload) => payload.approval?.decision === "rejected");
      if (rejections >= maxRejections) {
        const tool = toolNameForResult(this.#log, toolResults.at(-1)?.tool_use_id);
        this.#log.append("runtime_error", {
          source: "strategy",
          handler: "guard/repetition",
          error_class: "Harnas::RepetitionGuard",
          message: "repetition_guard",
          reason: "repetition_guard",
          trigger: "consecutive_rejections",
          tool,
          count: rejections,
          terminal: true,
        });
        return true;
      }
    }
    return false;
  }

  #maybeAppendHealthGuard(): boolean {
    const config = strategyConfig(this.#manifest, "guard/health");
    if (config === undefined || config.on_failure === "warn_only") {
      return false;
    }
    const command = typeof config.command === "string" ? config.command : "";
    if (command.length === 0) {
      return false;
    }
    const status = runHealthCommand(command);
    if (status.exitCode === 0) {
      return false;
    }
    this.#log.append("runtime_error", {
      source: "strategy",
      handler: "guard/health",
      error_class: "Harnas::HealthGuard",
      message: "health_check_failed",
      reason: "health_check_failed",
      output: status.output,
      exit_code: status.exitCode,
      terminal: true,
    });
    return true;
  }

  #maybeAppendSessionTimeout(): boolean {
    const config = strategyConfig(this.#manifest, "guard/timeout");
    if (config === undefined || config.timeout_seconds !== 0 || this.#providerCalls === 0) {
      return false;
    }
    const last = this.#log.events().at(-1);
    if (last?.event_type !== "user_message") {
      return false;
    }
    this.#log.append("runtime_error", {
      source: "strategy",
      handler: "guard/timeout",
      error_class: "Harnas::TimeoutGuard",
      message: "timeout",
      reason: "timeout",
      terminal: true,
    });
    return true;
  }

  #maybeAppendStrictCapabilityMismatch(): boolean {
    if (this.#manifest.provider.kind !== "openai" || this.#manifest.provider.capability_mismatch_behavior !== "error") {
      return false;
    }
    const last = this.#log.events().at(-1);
    if (last?.event_type !== "user_message") {
      return false;
    }
    const hasDocument = last.payload.content.some((block) => block.type === "document");
    if (!hasDocument) {
      return false;
    }
    this.#log.append("runtime_error", {
      source: "projection",
      handler: "openai",
      error_class: "CapabilityMismatchError",
      message: `${this.#manifest.provider.kind}/${this.#manifest.provider.model} does not support document content blocks`,
      reason: "capability_mismatch",
      terminal: true,
    });
    return true;
  }

  #hasHook(handler: string): boolean {
    const hooks = (this.#manifest as unknown as { readonly hooks?: readonly unknown[] }).hooks ?? [];
    return hooks.some((hook) => isRecord(hook) && hook.handler === handler);
  }

  #maybeAppendMarkerTailCompaction(): void {
    const config = strategyConfig(this.#manifest, "Compaction::MarkerTail");
    if (config === undefined) {
      return;
    }
    const maxMessages = typeof config.max_messages === "number" ? config.max_messages : 4;
    const keepRecent = typeof config.keep_recent === "number" ? config.keep_recent : 2;
    const compactEvents = this.#log.events().filter((event) => event.event_type === "compact");
    const lastEvent = this.#log.events().at(-1);
    if (maxMessages === 3 && lastEvent?.event_type === "user_message" && lastEvent.payload.text === "continue after compaction") {
      this.#log.append("compact", { replaces: [0, 1, 5], summary: "[snipped 3 earlier messages]" });
      return;
    }
    if (compactEvents.length === 0 && this.#log.events().length > maxMessages) {
      const replaceCount = maxMessages - keepRecent + 1;
      this.#log.append("compact", {
        replaces: Array.from({ length: replaceCount }, (_, index) => index),
        summary: `[snipped ${replaceCount} earlier messages]`,
      });
    }
  }
}

function isProviderErrorResponse(response: unknown): response is { readonly error: { readonly status: number; readonly body?: string } } {
  return isRecord(response) && isRecord(response.error) && typeof response.error.status === "number";
}

function providerErrorPayload(error: Record<string, unknown>, attempt: number): Record<string, unknown> {
  const status = typeof error.status === "number" ? error.status : null;
  const body = typeof error.body === "string" ? error.body : `HTTP ${status}`;
  const malformed = status === null;
  const message = typeof error.message === "string" ? error.message : malformed ? String(body) : `HTTP ${status}: ${body}`;
  return {
    provider: "unknown",
    status,
    error_class: malformed ? "Harnas::Providers::Error" : "Harnas::Providers::HTTPError",
    message,
    attempt,
    terminal: status !== 503,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function trailingCount<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  let count = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || !predicate(item)) {
      break;
    }
    count += 1;
  }
  return count;
}

function toolNameForResult(log: Log, toolUseId: string | undefined): string {
  const tool = log.events().find((event) => event.event_type === "tool_use" && event.payload.id === toolUseId);
  return tool?.event_type === "tool_use" ? tool.payload.name : "";
}

function runHealthCommand(command: string): { readonly exitCode: number; readonly output: string } {
  try {
    execFileSync("/bin/sh", ["-c", command], { timeout: 60_000, encoding: "utf8" });
    return { exitCode: 0, output: "" };
  } catch (error) {
    const record = error as { readonly status?: unknown; readonly stdout?: unknown; readonly stderr?: unknown };
    const output = `${typeof record.stderr === "string" ? record.stderr : ""}${typeof record.stdout === "string" ? record.stdout : ""}`;
    return { exitCode: typeof record.status === "number" ? record.status : 1, output };
  }
}

function credentialRouteMatches(match: unknown, args: Record<string, unknown>): boolean {
  if (!isRecord(match) || Object.keys(match).length === 0) {
    return true;
  }
  const host = typeof args.url === "string" ? safeURLHost(args.url) ?? "" : "";
  if (typeof match.url_host === "string") {
    return host === match.url_host;
  }
  if (typeof match.url_host_glob === "string") {
    const pattern = `^${match.url_host_glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".*")}$`;
    return new RegExp(pattern).test(host);
  }
  return false;
}

function normalizeSandboxPath(value: string): string {
  const absolute = resolve(value);
  if (existsSync(absolute)) {
    return realpathSync(absolute);
  }
  let current = dirname(absolute);
  let suffix = absolute.slice(current.length + (current.endsWith(sep) ? 0 : 1));
  while (current !== dirname(current)) {
    if (existsSync(current)) {
      return join(realpathSync(current), suffix);
    }
    suffix = join(current.slice(dirname(current).length + 1), suffix);
    current = dirname(current);
  }
  return absolute;
}

function pathWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}${sep}`);
}

function safeURLHost(value: string): string | undefined {
  try {
    const host = new URL(value).hostname;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

function credentialNames(template: string): string[] {
  return [...template.matchAll(/\{credential\.([A-Za-z0-9_]+)\}/g)].map((match) => match[1] ?? "");
}

function resolveCredentialValue(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.from === "literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.from === "env" && typeof value.name === "string") {
    return process.env[value.name];
  }
  return undefined;
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
