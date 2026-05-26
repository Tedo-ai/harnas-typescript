import { readFile } from "node:fs/promises";

export interface ReadFileArgs {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
}

export async function readFileBuiltin(args: ReadFileArgs): Promise<string> {
  const limit = Math.min(Math.max(args.limit ?? 2000, 0), 10_000);
  const offset = Math.max(args.offset ?? 0, 0);
  const bytes = await readFile(args.path);
  const sample = bytes.subarray(0, 8192);
  if (sample.includes(0)) {
    throw new Error(`Cannot read binary file '${args.path}'. Use bash_session to inspect binary files.`);
  }

  const text = bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (text.length === 0) {
    return "... [file has 0 total lines; showing 0-0]\n";
  }

  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = normalized.split("\n");
  if (offset >= lines.length) {
    return `... [file has ${lines.length} total lines; offset ${offset} is past EOF]\n`;
  }

  const shown = lines.slice(offset, offset + limit);
  const numbered = shown.map((line, index) => `${String(offset + index + 1).padStart(6, " ")}\t${line}`);
  if (offset + limit < lines.length) {
    numbered.push(`... [file has ${lines.length} total lines; showing ${offset}-${offset + limit}]`);
  }
  return numbered.join("\n") + "\n";
}

export const readFileDescriptor = {
  name: "read_file",
  description: "Read a text file with line numbers, offset, and limit.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", description: "Start at line N (0-indexed). Default 0." },
      limit: { type: "integer", description: "Read at most N lines. Default 2000." },
    },
    required: ["path"],
  },
  handler: "harnas.builtin.read_file",
} as const;
