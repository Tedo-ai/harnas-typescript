import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LoadSkillArgs {
  readonly name: string;
}

export interface LoadSkillConfig {
  readonly skills_dir?: string;
}

export async function loadSkillBuiltin(
  args: LoadSkillArgs,
  config: LoadSkillConfig | undefined,
  options: { readonly root: string },
): Promise<string> {
  if (!/^[A-Za-z0-9_]+$/.test(args.name)) {
    const error = new Error(`invalid skill name: ${args.name}`);
    error.name = "RuntimeError";
    throw error;
  }
  const skillsDir = config?.skills_dir ?? "skills";
  const text = await readFile(join(options.root, skillsDir, `${args.name}.md`), "utf8");
  return stripFrontmatter(text);
}

function stripFrontmatter(text: string): string {
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---\n")) {
    return text;
  }
  const end = text.indexOf("\n---\n", 4);
  return end === -1 ? text : text.slice(end + 5);
}
