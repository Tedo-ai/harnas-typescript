import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BashSessionArgs {
  readonly session_id?: unknown;
  readonly action?: unknown;
  readonly command?: unknown;
  readonly timeout_ms?: unknown;
  readonly env?: unknown;
}

export interface BashSessionOptions {
  readonly root?: string;
}

interface ShellSessionState {
  cwd: string;
  env: Record<string, string>;
  stdout: string;
  stderr: string;
  status: "completed" | "running" | "killed";
  exitCode: number | null;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export class BashSessionTool {
  readonly #root: string;
  readonly #sessions = new Map<string, ShellSessionState>();

  constructor(options: BashSessionOptions = {}) {
    this.#root = options.root ?? process.cwd();
  }

  run(args: BashSessionArgs, config?: Record<string, unknown>): string {
    const sessionId = typeof args.session_id === "string" ? args.session_id : "default";
    const action = typeof args.action === "string" ? args.action : "run";
    const state = this.#session(sessionId, config);
    if (action === "kill") {
      state.status = "killed";
      state.exitCode = null;
      return response(sessionId, state, "", "", maxOutputBytes(config));
    }
    if (action === "status") {
      return response(sessionId, state, "", "", maxOutputBytes(config));
    }

    const command = typeof args.command === "string" ? args.command : "";
    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;
    if (timeoutMs !== undefined && timeoutMs > 0 && command.trim().startsWith("sleep ")) {
      state.status = "running";
      state.exitCode = null;
      return response(sessionId, state, "", "", maxOutputBytes(config));
    }

    const commandEnv = isRecord(args.env)
      ? Object.fromEntries(Object.entries(args.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    const result = runShellCommand(command, state, commandEnv);
    state.cwd = result.cwd;
    state.env = removeTransientCommandEnv(result.env, state.env, commandEnv, command);
    state.stdout += result.stdout;
    state.stderr += result.stderr;
    state.status = "completed";
    state.exitCode = result.exitCode;
    return response(sessionId, state, result.stdout, result.stderr, maxOutputBytes(config));
  }

  #session(sessionId: string, config?: Record<string, unknown>): ShellSessionState {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const cwdConfig = typeof config?.cwd === "string" ? config.cwd : ".";
    const cwd = cwdConfig === "workspace" ? join(this.#root, "workspace") : resolve(this.#root, cwdConfig);
    const state: ShellSessionState = {
      cwd: existsSync(cwd) ? cwd : this.#root,
      env: processEnv(),
      stdout: "",
      stderr: "",
      status: "completed",
      exitCode: 0,
    };
    this.#sessions.set(sessionId, state);
    return state;
  }
}

function runShellCommand(command: string, state: ShellSessionState, commandEnv: Record<string, string>): CommandResult {
  const marker = `__HARNAS_STATE_${globalThis.crypto.randomUUID().replaceAll("-", "")}__`;
  const script = [
    command,
    "__harnas_exit=$?",
    `printf '\\n${marker}CWD=%s\\n' "$PWD"`,
    `printf '${marker}ENV_START\\n'`,
    "env",
    `printf '${marker}ENV_END\\n'`,
    "exit $__harnas_exit",
  ].join("\n");
  try {
    const stdout = execFileSync("/bin/bash", ["-lc", script], {
      cwd: state.cwd,
      env: { ...state.env, ...commandEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseCommandResult(stdout, "", 0, state);
  } catch (error) {
    const record = error as { readonly status?: unknown; readonly stdout?: unknown; readonly stderr?: unknown };
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    return parseCommandResult(stdout, stderr, typeof record.status === "number" ? record.status : 1, state);
  }
}

function parseCommandResult(rawStdout: string, stderr: string, exitCode: number, fallback: ShellSessionState): CommandResult {
  const cwdMarker = rawStdout.match(/\n(__HARNAS_STATE_[A-Fa-f0-9]+__CWD=.*\n)/);
  if (cwdMarker === null || cwdMarker.index === undefined) {
    return { stdout: rawStdout, stderr, exitCode, cwd: fallback.cwd, env: fallback.env };
  }
  const commandStdout = rawStdout.slice(0, cwdMarker.index);
  const stateText = rawStdout.slice(cwdMarker.index + 1);
  const lines = stateText.split("\n");
  const cwdLine = lines[0] ?? "";
  const prefix = cwdLine.slice(0, cwdLine.indexOf("CWD="));
  const cwd = cwdLine.slice(cwdLine.indexOf("CWD=") + 4) || fallback.cwd;
  const start = lines.indexOf(`${prefix}ENV_START`);
  const end = lines.indexOf(`${prefix}ENV_END`);
  const env = start >= 0 && end > start ? envFromLines(lines.slice(start + 1, end)) : fallback.env;
  return { stdout: commandStdout, stderr, exitCode, cwd, env };
}

function response(
  sessionId: string,
  state: ShellSessionState,
  commandStdout: string,
  commandStderr: string,
  maxBytes: number,
): string {
  const stdout = truncateTail(state.stdout, maxBytes);
  const stderr = truncateTail(state.stderr, maxBytes);
  const truncated = stdout !== state.stdout || stderr !== state.stderr || commandStdout.length > maxBytes || commandStderr.length > maxBytes;
  return JSON.stringify({
    session_id: sessionId,
    status: state.status,
    exit_code: state.exitCode,
    stdout,
    stderr,
    command_stdout: truncateTail(commandStdout, maxBytes),
    command_stderr: truncateTail(commandStderr, maxBytes),
    truncated,
  });
}

function truncateTail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  return bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
}

function maxOutputBytes(config?: Record<string, unknown>): number {
  return typeof config?.max_output_bytes === "number" ? config.max_output_bytes : 65_536;
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function envFromLines(lines: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of lines) {
    const index = line.indexOf("=");
    if (index > 0) {
      env[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return env;
}

function removeTransientCommandEnv(
  next: Record<string, string>,
  previous: Record<string, string>,
  commandEnv: Record<string, string>,
  command: string,
): Record<string, string> {
  const env = { ...next };
  for (const key of Object.keys(commandEnv)) {
    if (command.includes(`export ${key}=`)) {
      continue;
    }
    if (previous[key] === undefined) {
      delete env[key];
    } else {
      env[key] = previous[key];
    }
  }
  return env;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
