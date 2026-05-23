export type UsageProvenance = "provider_reported" | "runtime_estimated" | "unavailable";

export interface CanonicalUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  readonly cache_read_input_tokens: number | null;
  readonly cache_write_input_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly provider_raw: Record<string, unknown> | null;
  readonly provenance: UsageProvenance;
}

export function normalizeUsage(raw: unknown): CanonicalUsage {
  const usage = isRecord(raw) ? stringifyKeys(raw) : {};
  if (isCanonicalUsage(usage)) {
    return {
      input_tokens: intValue(usage.input_tokens),
      output_tokens: intValue(usage.output_tokens),
      total_tokens: intValue(usage.total_tokens),
      cache_read_input_tokens: optionalInt(usage.cache_read_input_tokens),
      cache_write_input_tokens: optionalInt(usage.cache_write_input_tokens),
      reasoning_tokens: optionalInt(usage.reasoning_tokens),
      provider_raw: isRecord(usage.provider_raw) ? usage.provider_raw : null,
      provenance: isUsageProvenance(usage.provenance) ? usage.provenance : "provider_reported",
    };
  }

  const inputTokens = intValue(firstPresent(usage.input_tokens, usage.prompt_tokens, usage.promptTokenCount));
  const outputTokens = intValue(firstPresent(usage.output_tokens, usage.completion_tokens, usage.candidatesTokenCount));
  const totalRaw = firstPresent(usage.total_tokens, usage.totalTokenCount);
  let totalTokens = intValue(totalRaw);
  if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0)) {
    totalTokens = inputTokens + outputTokens;
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    cache_read_input_tokens: optionalInt(
      firstPresent(
        nestedValue(usage, "prompt_tokens_details", "cached_tokens"),
        nestedValue(usage, "input_token_details", "cache_read"),
        usage.cache_read_input_tokens,
      ),
    ),
    cache_write_input_tokens: optionalInt(
      firstPresent(nestedValue(usage, "cache_creation", "input_tokens"), usage.cache_write_input_tokens),
    ),
    reasoning_tokens: optionalInt(
      firstPresent(nestedValue(usage, "completion_tokens_details", "reasoning_tokens"), usage.reasoning_tokens),
    ),
    provider_raw: Object.keys(usage).length > 0 ? usage : null,
    provenance: Object.keys(usage).length > 0 ? "provider_reported" : "unavailable",
  };
}

function isCanonicalUsage(usage: Record<string, unknown>): boolean {
  return ["input_tokens", "output_tokens", "total_tokens", "provider_raw", "provenance"].every((key) => key in usage);
}

function stringifyKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[String(key)] = stringifyValue(item);
  }
  return out;
}

function stringifyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stringifyValue(item));
  }
  if (isRecord(value)) {
    return stringifyKeys(value);
  }
  return value;
}

function nestedValue(value: Record<string, unknown>, ...keys: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function firstPresent(...values: readonly unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function optionalInt(value: unknown): number | null {
  return value === undefined || value === null ? null : intValue(value);
}

function intValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}

function isUsageProvenance(value: unknown): value is UsageProvenance {
  return value === "provider_reported" || value === "runtime_estimated" || value === "unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
