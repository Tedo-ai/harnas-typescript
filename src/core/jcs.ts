import { createHash } from "node:crypto";

type JsonNode =
  | null
  | boolean
  | string
  | readonly JsonNode[]
  | { readonly [key: string]: JsonNode }
  | { readonly __number: string };

export class InvalidUnicodeError extends Error {
  constructor() {
    super("invalid_unicode");
  }
}

export function canonicalizeJCSV1JSON(source: string, excludeKeys: readonly string[] = []): string {
  const value = new JsonParser(source).parse();
  if (isObjectNode(value)) {
    for (const key of excludeKeys) {
      delete (value as Record<string, JsonNode>)[key];
    }
  }
  return canonicalizeNode(value);
}

export function contentHashForEventRowJSON(source: string): string {
  return createHash("sha256").update(canonicalizeJCSV1JSON(source, ["content_hash"]), "utf8").digest("hex");
}

function canonicalizeNode(value: JsonNode): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return quoteString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeNode).join(",")}]`;
  if (isNumberNode(value)) return canonicalNumber(value.__number);
  const object = value as { readonly [key: string]: JsonNode };
  const keys = Object.keys(object).sort(compareUTF16);
  return `{${keys.map((key) => `${quoteString(key)}:${canonicalizeNode(object[key] as JsonNode)}`).join(",")}}`;
}

function canonicalNumber(raw: string): string {
  if (!/[.eE]/.test(raw)) return raw === "-0" ? "0" : raw;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error("invalid number");
  return value.toString();
}

function quoteString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    switch (code) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += "\\\\"; break;
      case 0x08: out += "\\b"; break;
      case 0x09: out += "\\t"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0c: out += "\\f"; break;
      case 0x0d: out += "\\r"; break;
      default:
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : value[i];
    }
  }
  return `${out}"`;
}

function compareUTF16(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let i = 0; i < limit; i += 1) {
    const diff = left.charCodeAt(i) - right.charCodeAt(i);
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

function isNumberNode(value: JsonNode): value is { readonly __number: string } {
  return typeof value === "object" && value !== null && "__number" in value;
}

function isObjectNode(value: JsonNode): value is { readonly [key: string]: JsonNode } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isNumberNode(value);
}

class JsonParser {
  #index = 0;

  constructor(readonly source: string) {}

  parse(): JsonNode {
    const value = this.#value();
    this.#ws();
    if (this.#index !== this.source.length) throw new Error("invalid JSON");
    return value;
  }

  #value(): JsonNode {
    this.#ws();
    const char = this.source[this.#index];
    if (char === '"') return this.#string();
    if (char === "{") return this.#object();
    if (char === "[") return this.#array();
    if (char === "t" && this.source.slice(this.#index, this.#index + 4) === "true") {
      this.#index += 4;
      return true;
    }
    if (char === "f" && this.source.slice(this.#index, this.#index + 5) === "false") {
      this.#index += 5;
      return false;
    }
    if (char === "n" && this.source.slice(this.#index, this.#index + 4) === "null") {
      this.#index += 4;
      return null;
    }
    return this.#number();
  }

  #object(): JsonNode {
    this.#index += 1;
    const out: Record<string, JsonNode> = {};
    this.#ws();
    if (this.source[this.#index] === "}") {
      this.#index += 1;
      return out;
    }
    while (true) {
      this.#ws();
      const key = this.#string();
      this.#ws();
      this.#expect(":");
      out[key] = this.#value();
      this.#ws();
      if (this.source[this.#index] === "}") {
        this.#index += 1;
        return out;
      }
      this.#expect(",");
    }
  }

  #array(): JsonNode {
    this.#index += 1;
    const out: JsonNode[] = [];
    this.#ws();
    if (this.source[this.#index] === "]") {
      this.#index += 1;
      return out;
    }
    while (true) {
      out.push(this.#value());
      this.#ws();
      if (this.source[this.#index] === "]") {
        this.#index += 1;
        return out;
      }
      this.#expect(",");
    }
  }

  #string(): string {
    const start = this.#index;
    this.#expect('"');
    while (this.#index < this.source.length) {
      const char = this.source[this.#index];
      if (char === '"') {
        this.#index += 1;
        return JSON.parse(this.source.slice(start, this.#index)) as string;
      }
      if (char === "\\") {
        this.#index += 1;
        if (this.source[this.#index] === "u") this.#validateUnicodeEscape();
      }
      this.#index += 1;
    }
    throw new Error("unterminated string");
  }

  #validateUnicodeEscape(): void {
    const code = Number.parseInt(this.source.slice(this.#index + 1, this.#index + 5), 16);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (this.source.slice(this.#index + 5, this.#index + 7) !== "\\u") throw new InvalidUnicodeError();
      const low = Number.parseInt(this.source.slice(this.#index + 7, this.#index + 11), 16);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new InvalidUnicodeError();
      this.#index += 10;
      return;
    }
    if (code >= 0xdc00 && code <= 0xdfff) throw new InvalidUnicodeError();
    this.#index += 4;
  }

  #number(): JsonNode {
    const start = this.#index;
    if (this.source[this.#index] === "-") this.#index += 1;
    while (/[0-9]/.test(this.source[this.#index] ?? "")) this.#index += 1;
    if (this.source[this.#index] === ".") {
      this.#index += 1;
      while (/[0-9]/.test(this.source[this.#index] ?? "")) this.#index += 1;
    }
    if ((this.source[this.#index] ?? "").toLowerCase() === "e") {
      this.#index += 1;
      if (["+", "-"].includes(this.source[this.#index] ?? "")) this.#index += 1;
      while (/[0-9]/.test(this.source[this.#index] ?? "")) this.#index += 1;
    }
    return { __number: this.source.slice(start, this.#index) };
  }

  #ws(): void {
    while (/\s/.test(this.source[this.#index] ?? "")) this.#index += 1;
  }

  #expect(char: string): void {
    if (this.source[this.#index] !== char) throw new Error(`expected ${char}`);
    this.#index += 1;
  }
}
