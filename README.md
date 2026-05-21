# harnas-ts

TypeScript reference implementation of [Harnas](https://github.com/Tedo-ai/harnas).

**Version 0.1.0** is the foundation milestone. It establishes the package
shape, strict TypeScript settings, JSONL Session persistence,
manifest-schema validation, the observation bus, a minimal OpenAI projection
and scripted conformance runner, plus the small Anthropic ingest path needed
for the first fixture.

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
```

Set `HARNAS_FIXTURES` to a spec checkout's `conformance/agents` directory
when the sibling checkout is not available.

## Example

```ts
import { Log, appendUserMessage } from "@tedo-ai/harnas-ts";

const log = new Log();
appendUserMessage(log, "hello");
```

## Status

- Foundation conformance: `minimal-chat` and `with-system-prompt-openai`
- Full v0.18.0 conformance target: 59/59 fixtures in a later milestone
