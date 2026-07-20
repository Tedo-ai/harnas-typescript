import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ProviderError,
  ProviderProtocolError,
  ProviderStreamError,
} from "../core/errors.js";
import type { StreamEvent } from "../core/streaming.js";
import { AnthropicStreamProvider } from "../providers/anthropic-stream.js";
import { GeminiStreamProvider } from "../providers/gemini-stream.js";
import {
  OpenAIStreamProvider,
  type StreamProvider,
} from "../providers/openai-stream.js";

const SCHEMA_VERSION = "harnas.provider-streams.v1";

interface ChunkProfile {
  readonly sizes: readonly number[];
  readonly repeat: boolean;
}

interface ProviderStreamCase {
  readonly id: string;
  readonly provider: "anthropic" | "openai" | "gemini";
  readonly request: Readonly<Record<string, unknown>>;
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  };
  readonly chunking_profiles: readonly string[];
  readonly expected: {
    readonly outcome: "success" | "failure";
    readonly events: readonly unknown[];
    readonly failure?: Readonly<Record<string, unknown>>;
  };
}

interface ProviderStreamCorpus {
  readonly schema_version: string;
  readonly chunking_profiles: Readonly<Record<string, ChunkProfile>>;
  readonly cases: readonly ProviderStreamCase[];
}

export interface ProviderStreamConformanceReport {
  readonly cases: number;
  readonly profiles: number;
}

export async function runProviderStreamCorpus(
  specRoot: string,
): Promise<ProviderStreamConformanceReport> {
  const path = join(specRoot, "conformance", "provider-streams", "corpus.json");
  const corpus = JSON.parse(
    await readFile(path, "utf8"),
  ) as ProviderStreamCorpus;
  if (corpus.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `unsupported provider-stream schema ${JSON.stringify(corpus.schema_version)}`,
    );
  }
  let executions = 0;
  for (const fixture of corpus.cases) {
    for (const profileName of fixture.chunking_profiles) {
      const profile = corpus.chunking_profiles[profileName];
      if (profile === undefined) {
        throw new Error(
          `${fixture.id}: unknown chunking profile ${JSON.stringify(profileName)}`,
        );
      }
      executions += 1;
      try {
        await runCase(fixture, profile);
      } catch (error) {
        throw new Error(`${fixture.id}/${profileName}: ${String(error)}`, {
          cause: error,
        });
      }
    }
  }
  return { cases: corpus.cases.length, profiles: executions };
}

async function runCase(
  fixture: ProviderStreamCase,
  profile: ChunkProfile,
): Promise<void> {
  const chunks = splitBytes(
    new TextEncoder().encode(fixture.response.body),
    profile,
  );
  const fetch = async (): Promise<Response> =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk === undefined) {
            controller.close();
          } else {
            controller.enqueue(chunk);
          }
        },
      }),
      {
        status: fixture.response.status,
        headers: fixture.response.headers,
      },
    );
  const turnId = () => "turn_fixture";
  let provider: StreamProvider;
  switch (fixture.provider) {
    case "anthropic":
      provider = new AnthropicStreamProvider({
        apiKey: "conformance-key",
        endpoint: "https://provider.invalid/anthropic",
        fetch,
        turnId,
      });
      break;
    case "openai":
      provider = new OpenAIStreamProvider({
        apiKey: "conformance-key",
        baseUrl: "https://provider.invalid",
        fetch,
        turnId,
      });
      break;
    case "gemini":
      provider = new GeminiStreamProvider({
        apiKey: "conformance-key",
        endpointBase: "https://provider.invalid/gemini",
        fetch,
        turnId,
      });
      break;
  }

  const events: unknown[] = [];
  let caught: unknown;
  try {
    const consolidated = await provider.stream(
      fixture.request,
      (event: StreamEvent) => events.push(event),
    );
    events.push(...consolidated);
  } catch (error) {
    caught = error;
  }
  const actualEvents = normalizeEvents(events);
  if (!deepEqual(actualEvents, fixture.expected.events)) {
    throw new Error(
      `event artifact mismatch\nexpected: ${canonical(fixture.expected.events)}\nactual:   ${canonical(actualEvents)}`,
    );
  }
  if (fixture.expected.outcome === "success") {
    if (caught !== undefined) {
      throw new Error(`expected success, got ${String(caught)}`);
    }
    return;
  }
  if (caught === undefined) {
    throw new Error("expected failure, got success");
  }
  const failure = normalizeFailure(fixture.provider, caught);
  if (!deepEqual(failure, fixture.expected.failure)) {
    throw new Error(
      `failure artifact mismatch\nexpected: ${canonical(fixture.expected.failure)}\nactual:   ${canonical(failure)}`,
    );
  }
  const forbidden = new Set([
    "assistant_turn_completed",
    "assistant_message",
    "tool_use",
  ]);
  const leak = actualEvents.find(
    (event) =>
      isRecord(event) &&
      typeof event.type === "string" &&
      forbidden.has(event.type),
  );
  if (leak !== undefined) {
    throw new Error(
      `failed stream produced durable/completed event ${canonical(leak)}`,
    );
  }
}

function splitBytes(body: Uint8Array, profile: ChunkProfile): Uint8Array[] {
  if (profile.sizes.length === 0) {
    return [body.slice()];
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let sizeIndex = 0;
  while (offset < body.length) {
    if (sizeIndex >= profile.sizes.length) {
      if (!profile.repeat) {
        chunks.push(body.slice(offset));
        break;
      }
      sizeIndex = 0;
    }
    const size = profile.sizes[sizeIndex];
    sizeIndex += 1;
    if (size === undefined || !Number.isInteger(size) || size < 1) {
      throw new Error(`invalid chunk size ${String(size)}`);
    }
    chunks.push(body.slice(offset, offset + size));
    offset += size;
  }
  return chunks.length === 0 ? [new Uint8Array()] : chunks;
}

function normalizeEvents(events: readonly unknown[]): readonly unknown[] {
  const normalized = JSON.parse(JSON.stringify(events)) as unknown[];
  for (const raw of normalized) {
    if (!isRecord(raw) || !isRecord(raw.payload)) {
      continue;
    }
    if ("turn_id" in raw.payload) {
      raw.payload.turn_id = "<turn_id>";
    }
    if (raw.type === "assistant_turn_failed") {
      raw.payload.error = "<provider_failure>";
    }
  }
  return normalized;
}

function normalizeFailure(
  provider: string,
  error: unknown,
): Readonly<Record<string, unknown>> {
  if (error instanceof ProviderStreamError) {
    return {
      kind: "provider_stream_error",
      provider,
      reason: "provider_error_frame",
      provider_error_type: error.providerErrorType,
      request_id: error.requestId,
      status: error.status ?? 0,
    };
  }
  if (error instanceof ProviderProtocolError) {
    return {
      kind: "provider_protocol_error",
      provider,
      reason: error.reason,
    };
  }
  if (error instanceof ProviderError && error.status !== undefined) {
    return {
      kind: "http_error",
      provider,
      reason: "http_status",
      status: error.status,
    };
  }
  return {
    kind: "network_error",
    provider,
    reason: "transport",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, objectKeysSorted);
}

function objectKeysSorted(_key: string, value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

function deepEqual(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
