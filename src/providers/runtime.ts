// Adapters that let the runtime AgentLoop drive a *live* provider.
//
// The AgentLoop consumes a provider shaped `{ next(request): Promise<unknown> }`
// (the same shape ScriptedProvider uses for conformance). The live HTTP
// providers (OpenAIProvider, etc.) expose `complete(request)`. `runtimeProvider`
// bridges the two, so the full loop (projection -> live provider -> ingest ->
// tool dispatch -> repeat) runs end-to-end against a real endpoint.

/** A live completion provider, e.g. OpenAIProvider. */
export interface CompletionProvider<Req = unknown, Res = unknown> {
  complete(request: Req, options?: { readonly signal?: AbortSignal }): Promise<Res>;
}

/** The provider shape the runtime AgentLoop consumes. */
export interface RuntimeProvider {
  next(request: unknown): Promise<unknown>;
}

/**
 * Adapt a live `{ complete }` provider to the AgentLoop's `{ next }` interface.
 *
 * ```ts
 * const loop = new AgentLoop({ manifest, log, tools,
 *   provider: runtimeProvider(new OpenAIProvider({ apiKey })) });
 * ```
 *
 * An optional AbortSignal is threaded through for cancellation.
 */
export function runtimeProvider<Req, Res>(
  provider: CompletionProvider<Req, Res>,
  options: { readonly signal?: AbortSignal } = {},
): RuntimeProvider {
  return {
    next(request: unknown): Promise<unknown> {
      return provider.complete(
        request as Req,
        options.signal !== undefined ? { signal: options.signal } : {},
      );
    },
  };
}
