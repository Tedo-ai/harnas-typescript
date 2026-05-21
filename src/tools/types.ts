export interface ToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly input_schema?: Record<string, unknown>;
  readonly handler?: string;
  readonly config?: Record<string, unknown>;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  config?: Record<string, unknown>,
) => string | Promise<string>;
