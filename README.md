# harnas-typescript

TypeScript reference implementation of [Harnas](https://github.com/Tedo-ai/harnas).

**Version 0.2.0** is the post-v0.19 development milestone. It keeps the
strict TypeScript package scaffold, JSONL Session persistence,
manifest-schema validation, observation bus, provider projections, ingestors,
and a scripted conformance runner for `@tedo-ai/harnas-typescript`.

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

## Status

- v0.19.0 fixture runner: 65/65 fixtures locally, including
  `expected-projections.jsonl` assertions for subagent fixtures
- CI runs the v0.19.0 fixture suite on Node 20/22 across Linux, macOS, and
  Windows, plus Bun and Deno smoke runtimes
- v1.0.0 still requires the cross-language round-trip matrix and release
  review
- Future contrib layout reserved with the `@tedo-ai/harnas-typescript/mcp`
  subpath export; core does not depend on MCP.
