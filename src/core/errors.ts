export class HarnasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ManifestError extends HarnasError {}

/** Coarse provider-failure class, derivable from HTTP status. Lets retry
 * policy and user-facing messaging be written once instead of per provider.
 * (Filed from production: Tedo-ai/harnas#7.) */
export type ProviderErrorClass =
  | "rate_limit"
  | "auth"
  | "invalid_request"
  | "overloaded"
  | "timeout"
  | "network"
  | "provider_error";

export interface ProviderErrorOptions {
  readonly status?: number;
  /** Excerpt of the provider response body (first ~300 chars). */
  readonly detail?: string;
  readonly errorClass?: ProviderErrorClass;
}

export class ProviderError extends HarnasError {
  readonly status: number | undefined;
  readonly detail: string | undefined;
  readonly errorClass: ProviderErrorClass | undefined;

  constructor(message: string, options: ProviderErrorOptions = {}) {
    super(message);
    this.status = options.status;
    this.detail = options.detail;
    this.errorClass = options.errorClass;
  }
}

/** Map an HTTP status to the coarse ProviderErrorClass. */
export function classifyProviderStatus(status: number): ProviderErrorClass {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 503 || status === 529) return "overloaded";
  if (status >= 400 && status < 500) return "invalid_request";
  return "provider_error";
}

export class ConformanceError extends HarnasError {}
