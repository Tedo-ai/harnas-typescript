import type { Log } from "../../core/log.js";
import type { ProviderManifest } from "./common.js";
import { textTurns } from "./common.js";

export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AnthropicRequest {
  readonly model: string;
  readonly messages: readonly AnthropicMessage[];
  readonly max_tokens?: number;
  readonly system?: string;
}

export function projectAnthropicRequest(manifest: ProviderManifest, log: Log): AnthropicRequest {
  return {
    model: manifest.provider.model,
    messages: textTurns(log),
    ...(manifest.provider.max_tokens !== undefined ? { max_tokens: manifest.provider.max_tokens } : {}),
    ...(manifest.system !== undefined && manifest.system.length > 0 ? { system: manifest.system } : {}),
  };
}
