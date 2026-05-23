import type { Log } from "../../core/log.js";
import { messageText } from "../../core/events.js";

export interface ProviderManifest {
  readonly name?: string;
  readonly system?: string;
  readonly provider: {
    readonly kind: string;
    readonly model: string;
    readonly max_tokens?: number;
    readonly [key: string]: unknown;
  };
  readonly tools?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly input_schema?: unknown;
    readonly config?: unknown;
  }[];
}

export function textTurns(log: Log): Array<{ role: "user" | "assistant"; content: string }> {
  const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const event of log.events()) {
    if (event.event_type === "user_message") {
      turns.push({ role: "user", content: messageText(event.payload) });
    } else if (event.event_type === "assistant_message") {
      turns.push({ role: "assistant", content: messageText(event.payload) });
    }
  }
  return turns;
}
