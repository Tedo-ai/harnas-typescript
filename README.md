# harnas-typescript

TypeScript reference implementation of [Harnas](https://github.com/Tedo-ai/harnas).

**Version 0.2.0** is the post-v0.19 foundation milestone. It keeps the
strict TypeScript package scaffold, JSONL Session persistence,
manifest-schema validation, observation bus, minimal provider projection
and scripted conformance runner, and updates the package identity to
`@tedo-ai/harnas-typescript`.

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
npm run test:conformance:node:all # shows the current full v0.19 gap
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

- Foundation conformance: `minimal-chat` and `with-system-prompt-openai`
- Full v0.19.0 conformance target: 65/65 fixtures for v1.0.0
- Future contrib layout reserved with the `@tedo-ai/harnas-typescript/mcp`
  subpath export; core does not depend on MCP.
