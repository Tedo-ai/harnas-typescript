# Changelog

## [Unreleased]

### Changed

- Expanded Node, Bun, and Deno conformance tests to run the full v0.19.0
  fixture suite instead of the initial two-fixture smoke subset.
- Added `expected-projections.jsonl` assertions to the conformance runner for
  subagent delegation fixtures.
- Exported the Gemini projection and ingestor from the public package surface.
- Hardened text fixture handling and CI fixture checkout against Windows CRLF
  conversion.
- Added the `StorageAdapter` persistence seam with file-backed and in-memory
  adapters before the v1.0 API freeze.

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
