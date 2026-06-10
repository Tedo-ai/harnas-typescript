import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface WriteFileArgs {
  readonly path: string;
  readonly content: string;
}

export async function writeFileBuiltin(args: WriteFileArgs): Promise<string> {
  await mkdir(dirname(args.path), { recursive: true });
  await writeFile(args.path, args.content, "utf8");
  return `wrote ${args.content.length} bytes to ${args.path}`;
}
