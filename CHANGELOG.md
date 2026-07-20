# Changelog

## [Unreleased]

### Added

- Raw provider-wire conformance for Anthropic, OpenAI, and Gemini: 18 logical
  cases and 39 deterministic byte-fragmented executions through production
  `fetch`/SSE parsers, with a standalone runner.
- Production Anthropic and Gemini stream adapters alongside the hardened
  OpenAI stream adapter.
- Added v0.20 durability primitives: harnas-jcs-v1 canonicalization with a
  BigInt-safe parser, Event `content_hash`, and the OCC `expected_next_seq`
  append fence on storage adapters.
- Added fixture-gated tests for the §24 oracle corpus and §21 storage law
  fixtures.

### Changed

- Built-in stream adapters now fail closed on provider error frames,
  malformed JSON or UTF-8, invalid tool lifecycles, duplicate or missing
  terminal evidence, and partial failures without producing durable results.
- Updated the conformance target to fixtures v0.22.0: 78/78 agent fixtures
  plus 39/39 raw provider-wire executions.
- Updated the conformance target to fixtures v0.20.0: 75/75.
- Reset the conformance runner to the strict runtime path: scripted provider
  turns now execute through `AgentLoop`, `ToolRegistry`, provider projections,
  ingestors, guards, hooks, compaction, streaming handling, and built-ins
  instead of runner-side fixture accommodation.
- Added real runtime/library coverage for write/read/load-skill tools,
  `bash_session`, permission denial, sandbox/write, sandbox/network,
  credential/proxy injection, guard/timeout, guard/health, guard/repetition,
  strict capability mismatch, hook failure/audit behavior, and spawn-agent
  receipts.
- Revalidated the runtime path under strict comparison, with old simulation
  paths removed from the conformance runner.
- Updated the conformance target to fixtures v0.19.2: 69/69, including
  the Anthropic text-plus-reasoning projection guard and text-plus-tool
  projection guards for Anthropic, OpenAI, and Gemini.
- Updated the conformance target to fixtures v0.19.3: 70/70, including
  the process-isolation repeat fixture that runs independent Sessions in
  one host process.
- Conformance runner now honors `isolation.json` repeat checks.
- Fixed OpenAI projection so assistant messages with tool calls preserve
  non-empty assistant text in later requests.
- Fixed Gemini projection so prior tool calls and tool results project back as
  `functionCall` and `functionResponse` parts in later requests.
- Scoped Gemini-generated tool call IDs to the current Session/Log instead of
  a process-global counter so conformance fixtures remain isolated.
- Expanded Node, Bun, and Deno conformance tests to run the full v0.19.x
  fixture suite instead of the initial two-fixture smoke subset.
- Added `expected-projections.jsonl` assertions to the conformance runner for
  subagent delegation fixtures.
- Moved subagent delegation projections into exported helpers and made the
  conformance runner compute expected projections from loaded Session Logs.
- Added the cross-language Session JSONL round-trip matrix for TypeScript,
  Go, Ruby, and Python writers/readers.
- Fixed Anthropic projection after cross-language load so assistant messages
  with reasoning preserve both thinking blocks and the assistant text block.
- Exported the Gemini projection and ingestor from the public package surface.
- Hardened text fixture handling and CI fixture checkout against Windows CRLF
  conversion.
- Added the `StorageAdapter` persistence seam with file-backed and in-memory
  adapters before the v1.0 API freeze.
- Aligned the storage seam with the v0.19.4 `EventDraft` → `EventRow`
  contract: the Session/runtime now mints event id and timestamp while
  adapters assign durable `seq`.
- Enforced dense Event `seq` validation when parsing Session JSONL so
  duplicate, gapped, or reordered rows fail loudly.
- Added conformance replay support for malformed streaming provider frames
  and validated against the expanded fixture set.
- Added a README drift check that compares public spec-target and
  fixture-count claims with the checked-out spec.
- Pinned the README conformance claim to disclose the open MarkerTail,
  manifest hook, and fork implementation gaps before v1.0.0.
- Replaced the disclosed MarkerTail, manifest-hook, and fork/save-load
  implementation gaps with real runtime behavior and validated against the
  expanded 75-fixture spec set.
- Added canary coverage for fixture-aware implementation behavior via
  MarkerTail, hook, and fork variants.

## [0.2.0] — 2026-05-24

### Changed

- Renamed the package identity from `@tedo-ai/harnas-ts` to
  `@tedo-ai/harnas-typescript` per ADR 0004.
- Updated the conformance target to Harnas spec v0.19.0: 65 fixtures.
- Added canonical event timestamps and canonical provider usage metadata
  to the foundation event/ingestor path.
- Reserved the `@tedo-ai/harnas-typescript/mcp` subpath export for future
  v0.20 contrib work without making core depend on MCP.

## [0.1.0] — 2026-05-21

### Added

- Initial TypeScript foundation for `@tedo-ai/harnas-ts`.
- Strict ESM-only NodeNext TypeScript package scaffold.
- Core discriminated-union event types, branded ids, append-only Log,
  Session JSONL persistence, AsyncIterable observation bus, and Ajv
  manifest validation against the bundled Harnas schema.
- Minimal provider projection/ingestor path for `minimal-chat` and
  `with-system-prompt-openai` conformance fixtures.
- `read_file` built-in with offset/limit and cat-style line numbering.
