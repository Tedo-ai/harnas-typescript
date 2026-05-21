import type { ToolDescriptor, ToolHandler } from "./types.js";

export class ToolRegistry {
  readonly #descriptors = new Map<string, ToolDescriptor>();
  readonly #handlers = new Map<string, ToolHandler>();

  register(descriptor: ToolDescriptor, handler: ToolHandler): void {
    this.#descriptors.set(descriptor.name, descriptor);
    this.#handlers.set(descriptor.name, handler);
  }

  descriptors(): readonly ToolDescriptor[] {
    return [...this.#descriptors.values()];
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    const descriptor = this.#descriptors.get(name);
    const handler = this.#handlers.get(name);
    if (descriptor === undefined || handler === undefined) {
      throw new Error(`unknown tool: ${name}`);
    }
    return handler(args, descriptor.config);
  }
}
