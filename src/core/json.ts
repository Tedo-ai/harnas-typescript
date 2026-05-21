import { readFile } from "node:fs/promises";

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        sorted[key] = canonicalize(item);
      }
    }
    return sorted;
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonlFile<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function jsonlString(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + "\n";
}
