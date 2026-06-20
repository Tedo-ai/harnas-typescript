export interface ProviderCarrier {
  readonly carrier_destination: string;
  readonly index: number;
  readonly kind: string;
  readonly wire: unknown;
  readonly canonical_refs?: readonly string[];
}

export function providerCarrier(args: {
  readonly destination: string;
  readonly index: number;
  readonly kind: string;
  readonly wire: unknown;
  readonly canonicalRefs?: readonly string[];
}): ProviderCarrier {
  return {
    carrier_destination: args.destination,
    index: args.index,
    kind: args.kind,
    wire: args.wire,
    ...(args.canonicalRefs !== undefined && args.canonicalRefs.length > 0 ? { canonical_refs: args.canonicalRefs } : {}),
  };
}

export function carrierWire(carriers: unknown, destination: string): unknown | undefined {
  if (!Array.isArray(carriers)) {
    return undefined;
  }
  for (const raw of carriers) {
    if (!isRecord(raw)) {
      continue;
    }
    if (raw.carrier_destination === destination && "wire" in raw) {
      return structuredClone(raw.wire);
    }
  }
  return undefined;
}

export function carrierWires(carriers: unknown, destination: string): unknown[] | undefined {
  const wire = carrierWire(carriers, destination);
  return Array.isArray(wire) ? wire : undefined;
}

export function providerPartWire(block: unknown, destination: string): Record<string, unknown> | undefined {
  if (!isRecord(block)) {
    return undefined;
  }
  const wire = carrierWire(block.provider_parts, destination);
  return isRecord(wire) ? wire : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
