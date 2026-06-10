# harnas-typescript

TypeScript reference implementation of [Harnas](https://github.com/Tedo-ai/harnas).

**Version 0.2.0** is the post-v0.19 development milestone targeting
Harnas spec 0.19.4. It keeps the
strict TypeScript package scaffold, JSONL Session persistence,
manifest-schema validation, observation bus, provider projections, ingestors,
and a strict conformance runner for `@tedo-ai/harnas-typescript`.

Runtime targets:

- Node 20+
- Bun 1.0+
- Deno 2

Browser and edge runtimes are not targets.

## Install

```sh
npm install
npm run typecheck
npm test
npm run test:conformance:node
npm run test:conformance:node:all
npm run test:conformance:bun
npm run test:conformance:deno
```

Set `HARNAS_FIXTURES` to a spec checkout's `conformance/agents` directory
when the sibling checkout is not available.

## Example

```ts
import { Log, appendUserMessage } from "@tedo-ai/harnas-typescript";

const log = new Log();
appendUserMessage(log, "hello");
```

## Persistence

Session persistence goes through a `StorageAdapter`. The default adapter is
file-backed JSONL, but applications can provide their own adapter for
database-backed sessions as long as it can emit canonical Session JSONL.

```ts
import { Session, FileStorageAdapter } from "@tedo-ai/harnas-typescript";

const session = await Session.open({
  storage: new FileStorageAdapter(".harnas/runs/ses_123.jsonl"),
});

await session.appendEvent("user_message", {
  content: [{ type: "text", text: "hello" }],
});

const newEvents = await session.eventsSince(0);
```

## Status

- Current runtime conformance: 75/75 fixtures locally against the current
  spec checkout. The runner is strict, MarkerTail compaction is
  tool-pair-safe, manifest hooks dispatch through registered handlers, and
  `Session.fork(at_seq)` rewinds the Log instead of passing vacuously.
- Disclosed v1.0 footnotes: Windows `bash_session` behavior and
  receipt-only `spawn_agent`.
- Fixture-only stubs remain only at explicit conformance boundaries:
  scripted providers, conformance-only test tools, and no-network `fetch_url`
  responses.
- Cross-language Session JSONL round-trip matrix is wired for TypeScript,
  Go, Ruby, and Python writers/readers
- Persistence is behind `StorageAdapter`; file-backed JSONL remains the
  default, and database adapters can supply the same three-operation seam.
- CI runs the fixture suite on Node 20/22 across Linux, macOS, and Windows,
  plus Bun and Deno smoke runtimes
- v1.0.0 still requires release review
- Future contrib layout reserved with the `@tedo-ai/harnas-typescript/mcp`
  subpath export; core does not depend on MCP.
