export class HarnasError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ManifestError extends HarnasError {}

export class ProviderError extends HarnasError {}

export class ConformanceError extends HarnasError {}
