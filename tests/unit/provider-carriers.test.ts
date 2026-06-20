import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EventPayload, EventType } from "../../src/core/events.js";
import { Log } from "../../src/core/log.js";
import { ingestAnthropicResponseEvents } from "../../src/ingestors/anthropic.js";
import { ingestGeminiResponseEvents } from "../../src/ingestors/gemini.js";
import { ingestOpenAIResponseEvents } from "../../src/ingestors/openai.js";
import { projectAnthropicRequest } from "../../src/projections/provider/anthropic.js";
import { projectGeminiRequest } from "../../src/projections/provider/gemini.js";
import { projectOpenAIRequest } from "../../src/projections/provider/openai.js";
import type { ProviderManifest } from "../../src/projections/provider/common.js";

interface CarrierFixture {
  readonly name: string;
  readonly provider: {
    readonly kind: "anthropic" | "openai" | "gemini";
    readonly model: string;
  };
  readonly ingest: {
    readonly provider_response: unknown;
    readonly expect_event: {
      readonly type: "assistant_message";
      readonly payload: Record<string, unknown>;
    };
  };
  readonly project: {
    readonly log: readonly {
      readonly type: EventType;
      readonly payload: EventPayload<EventType>;
    }[];
    readonly expect_request: unknown;
  };
  readonly round_trip: {
    readonly reingest_response_path: string;
  };
}

function specRoot(): string {
  return process.env.HARNAS_SPEC ?? join(process.cwd(), "..", "harnas");
}

function loadFixtures(): readonly CarrierFixture[] {
  const root = join(specRoot(), "conformance", "provider-carriers");
  const names = readdirSync(root).filter((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() && existsSync(join(path, "fixture.json"));
  });
  return names.sort().map((name) => JSON.parse(
    readFileSync(join(root, name, "fixture.json"), "utf8"),
  ) as CarrierFixture);
}

describe("provider-carrier fixtures", () => {
  const fixtures = loadFixtures();

  for (const fixture of fixtures) {
    it(`passes ${fixture.name}`, () => {
      const manifest: ProviderManifest = {
        provider: {
          kind: fixture.provider.kind,
          model: fixture.provider.model,
          ...(fixture.provider.kind === "anthropic" ? { max_tokens: 1024 } : {}),
        },
      };

      const ingested = ingest(fixture.provider.kind, fixture.ingest.provider_response)[0];
      expect(ingested?.type).toBe(fixture.ingest.expect_event.type);
      const payload: Record<string, unknown> = { ...(ingested?.payload as Record<string, unknown> | undefined) };
      if (payload.model === undefined) {
        payload.model = fixture.provider.model;
      }
      expect(payload).toEqual(fixture.ingest.expect_event.payload);

      const request = project(fixture.provider.kind, manifest, logFromRows(fixture.project.log));
      expect(request).toEqual(fixture.project.expect_request);

      const roundtrip = ingest(fixture.provider.kind, pathValue(fixture, fixture.round_trip.reingest_response_path))[0];
      const roundtripPayload: Record<string, unknown> = { ...(roundtrip?.payload as Record<string, unknown> | undefined) };
      if (roundtripPayload.model === undefined) {
        roundtripPayload.model = fixture.provider.model;
      }
      for (const key of ["provider_items", "content", "reasoning"] as const) {
        if (fixture.ingest.expect_event.payload[key] !== undefined) {
          expect(roundtripPayload[key]).toEqual(fixture.ingest.expect_event.payload[key]);
        }
      }
    });
  }
});

function ingest(kind: CarrierFixture["provider"]["kind"], response: unknown) {
  switch (kind) {
    case "anthropic":
      return ingestAnthropicResponseEvents(response as Parameters<typeof ingestAnthropicResponseEvents>[0]);
    case "openai":
      return ingestOpenAIResponseEvents(response as Parameters<typeof ingestOpenAIResponseEvents>[0]);
    case "gemini":
      return ingestGeminiResponseEvents(response as Parameters<typeof ingestGeminiResponseEvents>[0]);
  }
}

function project(kind: CarrierFixture["provider"]["kind"], manifest: ProviderManifest, log: Log): unknown {
  switch (kind) {
    case "anthropic":
      return projectAnthropicRequest(manifest, log);
    case "openai":
      return projectOpenAIRequest(manifest, log);
    case "gemini":
      return projectGeminiRequest(manifest, log);
  }
}

function logFromRows(rows: CarrierFixture["project"]["log"]): Log {
  const log = new Log();
  for (const row of rows) {
    log.append(row.type, row.payload);
  }
  return log;
}

function pathValue(root: unknown, path: string): unknown {
  return path.split(".").reduce((value, part) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    const match = /^(.*)\[(\d+)\]$/.exec(part);
    if (match !== null) {
      const collection = (value as Record<string, unknown>)[match[1] as string];
      return Array.isArray(collection) ? collection[Number(match[2])] : undefined;
    }
    return (value as Record<string, unknown>)[part];
  }, root);
}
