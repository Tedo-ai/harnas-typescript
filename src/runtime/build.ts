import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { ManifestError } from "../core/errors.js";
import type { ProviderManifest } from "../projections/provider/common.js";

export interface Runtime {
  readonly manifest: ProviderManifest;
}

export interface RuntimeBuildOptions {
  readonly manifest: unknown;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaUrl = new URL("../../schemas/agent-manifest.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8")) as Record<string, unknown>;
const validateManifest = ajv.compile(schema);

export function buildRuntime(options: RuntimeBuildOptions): Runtime {
  if (!validateManifest(options.manifest)) {
    const message = ajv.errorsText(validateManifest.errors, { separator: "; " });
    throw new ManifestError(`invalid manifest: ${message}`);
  }
  return { manifest: options.manifest as ProviderManifest };
}
