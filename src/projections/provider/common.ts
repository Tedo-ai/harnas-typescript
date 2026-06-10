import type { Log } from "../../core/log.js";
import type { ContentBlock, DocumentContentBlock, ImageContentBlock, MessagePayload } from "../../core/events.js";
import { messageText } from "../../core/events.js";
import type { LogEvent } from "../../core/events.js";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ProviderManifest {
  readonly name?: string;
  readonly system?: string;
  readonly provider: {
    readonly kind: string;
    readonly model: string;
    readonly max_tokens?: number;
    readonly [key: string]: unknown;
  };
  readonly tools?: readonly {
    readonly name: string;
    readonly handler?: string;
    readonly description?: string;
    readonly input_schema?: unknown;
    readonly config?: unknown;
  }[];
}

export interface ProjectionOptions {
  readonly fixturePath?: string;
}

export type ProjectionEvent = LogEvent | {
  readonly seq: number;
  readonly event_type: "user_message";
  readonly payload: MessagePayload;
};

export function projectionEvents(log: Log): readonly ProjectionEvent[] {
  const events = log.events();
  const revoked = new Set<number>();
  for (const event of events) {
    if (event.event_type === "revert" && typeof event.payload.revokes === "number") {
      revoked.add(event.payload.revokes);
    }
  }
  const replaced = new Set<number>();
  const summaries: ProjectionEvent[] = [];

  for (const event of events) {
    if (event.event_type !== "compact" || revoked.has(event.seq)) {
      continue;
    }
    const replaces = Array.isArray(event.payload.replaces) ? event.payload.replaces.filter((seq): seq is number => typeof seq === "number") : [];
    for (const seq of replaces) {
      replaced.add(seq);
    }
    const first = Math.min(...replaces);
    if (Number.isFinite(first) && typeof event.payload.summary === "string") {
      summaries.push({
        seq: first,
        event_type: "user_message",
        payload: { content: [{ type: "text", text: event.payload.summary }], text: event.payload.summary },
      });
    }
  }

  return [
    ...events.filter((event) => event.event_type !== "compact" && event.event_type !== "revert" && !replaced.has(event.seq)),
    ...summaries,
  ].sort((left, right) => left.seq - right.seq);
}

export function textTurns(log: Log): Array<{ role: "user" | "assistant"; content: string }> {
  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const event of projectionEvents(log)) {
    if (event.event_type === "user_message") {
      turns.push({ role: "user", content: messageText(event.payload) });
    } else if (event.event_type === "assistant_message") {
      turns.push({ role: "assistant", content: messageText(event.payload) });
    }
  }
  return turns;
}

export function hasOnlyText(payload: MessagePayload): boolean {
  return payload.content.every((block) => block.type === "text");
}

export function contentBlocksForAnthropic(payload: MessagePayload, options: ProjectionOptions = {}): unknown[] {
  return payload.content.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "image" || block.type === "document") {
      return {
        type: block.type,
        source: {
          type: "base64",
          media_type: block.media_type,
          data: resolveBlockBase64(block, options),
        },
      };
    }
    return block;
  });
}

export function contentBlocksForOpenAI(payload: MessagePayload, options: ProjectionOptions = {}): unknown[] {
  const blocks: unknown[] = [];
  for (const block of payload.content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      blocks.push({
        type: "image_url",
        image_url: { url: `data:${block.media_type};base64,${resolveBlockBase64(block, options)}` },
      });
    } else if (block.type === "document") {
      blocks.push({
        type: "text",
        text: metadataFallbackAnnotation(block, byteSize(block, options)),
      });
    }
  }
  return blocks;
}

export function metadataFallbackAnnotation(block: ImageContentBlock | DocumentContentBlock, size: number | null): string {
  const parts = [`[Note: A ${block.type} was attached to this message but cannot be viewed by this provider.`];
  if (block.name !== undefined) {
    parts.push(`Name: ${block.name}.`);
  }
  parts.push(`Type: ${block.media_type}.`);
  if (size !== null) {
    parts.push(`Size: ${size} bytes.`);
  }
  if (block.source.kind === "ref") {
    parts.push(`URI: ${block.source.uri}.`);
  }
  parts.push("Use available tools to access the content.]");
  return parts.join(" ");
}

function resolveBlockBase64(block: ImageContentBlock | DocumentContentBlock, options: ProjectionOptions): string {
  if (block.source.kind === "base64") {
    return block.source.data;
  }
  if (block.source.kind === "ref") {
    const bytes = resolveAttachmentBytes(block.source.uri, options);
    return bytes.toString("base64");
  }
  return "";
}

function byteSize(block: ImageContentBlock | DocumentContentBlock, options: ProjectionOptions): number | null {
  if (block.source.kind === "base64") {
    return Buffer.from(block.source.data, "base64").byteLength;
  }
  if (block.source.kind === "ref") {
    return resolveAttachmentBytes(block.source.uri, options).byteLength;
  }
  return null;
}

function resolveAttachmentBytes(uri: string, options: ProjectionOptions): Buffer {
  if (options.fixturePath === undefined) {
    return Buffer.alloc(0);
  }
  const attachmentMapPath = join(options.fixturePath, "attachments.json");
  const entries = JSON.parse(readFileSync(attachmentMapPath, "utf8")) as Array<{ readonly path: string }>;
  const entry = entries[0];
  if (entry === undefined) {
    return Buffer.alloc(0);
  }
  return readFileSync(join(options.fixturePath, entry.path));
}
