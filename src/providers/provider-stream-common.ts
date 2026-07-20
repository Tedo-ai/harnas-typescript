import { ProviderProtocolError } from "../core/errors.js";

export async function readSSEBody(
  response: Response,
  provider: string,
  onData: (data: string) => void,
): Promise<void> {
  if (response.body === null) {
    throw new ProviderProtocolError(
      provider,
      "missing_body",
      "successful response has no body",
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    try {
      buffer += decoder.decode(value, { stream: true });
    } catch (error) {
      throw new ProviderProtocolError(
        provider,
        "invalid_utf8",
        `invalid UTF-8 stream: ${String(error)}`,
      );
    }
    buffer = dispatchCompleteBlocks(buffer, onData);
  }
  try {
    buffer += decoder.decode();
  } catch (error) {
    throw new ProviderProtocolError(
      provider,
      "invalid_utf8",
      `invalid UTF-8 stream: ${String(error)}`,
    );
  }
  buffer = dispatchCompleteBlocks(buffer, onData);
  if (buffer.length > 0) {
    dispatchBlock(buffer, onData);
  }
}

function dispatchCompleteBlocks(
  buffer: string,
  onData: (data: string) => void,
): string {
  for (;;) {
    const match = /\r?\n\r?\n/.exec(buffer);
    if (match === null || match.index === undefined) {
      return buffer;
    }
    dispatchBlock(buffer.slice(0, match.index), onData);
    buffer = buffer.slice(match.index + match[0].length);
  }
}

function dispatchBlock(block: string, onData: (data: string) => void): void {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const raw = line.slice(5);
    dataLines.push(raw.startsWith(" ") ? raw.slice(1) : raw);
  }
  if (dataLines.length > 0) {
    const data = dataLines.join("\n");
    if (data !== "") {
      onData(data);
    }
  }
}

export async function providerBodyExcerpt(
  response: Response,
): Promise<string | undefined> {
  try {
    const text = (await response.text()).trim();
    if (text.length === 0) {
      return undefined;
    }
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseObjectJSON(
  provider: string,
  raw: string,
  reason = "invalid_json",
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ProviderProtocolError(
      provider,
      reason,
      `invalid SSE JSON: ${String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ProviderProtocolError(
      provider,
      "invalid_frame",
      "SSE payload must be an object",
    );
  }
  return parsed;
}

export function parseToolArguments(
  provider: string,
  raw: string,
): Record<string, unknown> {
  if (raw === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ProviderProtocolError(
      provider,
      "invalid_tool_arguments",
      `tool arguments are not valid JSON: ${String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new ProviderProtocolError(
      provider,
      "invalid_tool_arguments",
      "tool arguments must be a JSON object",
    );
  }
  return parsed;
}
