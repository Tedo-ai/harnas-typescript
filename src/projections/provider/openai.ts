import type { Log } from "../../core/log.js";
import type { ProviderManifest } from "./common.js";
import { textTurns } from "./common.js";

export interface OpenAIMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface OpenAIRequest {
  readonly model: string;
  readonly messages: readonly OpenAIMessage[];
}

export function projectOpenAIRequest(manifest: ProviderManifest, log: Log): OpenAIRequest {
  const messages: OpenAIMessage[] = [];
  if (manifest.system !== undefined && manifest.system.length > 0) {
    messages.push({ role: "system", content: manifest.system });
  }
  for (const turn of textTurns(log)) {
    messages.push(turn);
  }

  const request: OpenAIRequest = {
    model: manifest.provider.model,
    messages,
  };
  return request;
}
