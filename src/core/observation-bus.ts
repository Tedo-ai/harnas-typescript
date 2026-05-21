export interface Observation {
  readonly type: string;
  readonly payload: unknown;
  readonly ts: string;
}

export type ObservationSubscriber = (observation: Observation) => void | Promise<void>;

export class ObservationBus implements AsyncIterable<Observation> {
  readonly #subscribers = new Set<ObservationSubscriber>();
  readonly #queue: Observation[] = [];
  readonly #waiters: Array<(value: IteratorResult<Observation>) => void> = [];
  #closed = false;

  emit(type: string, payload: unknown, now: Date = new Date()): void {
    if (this.#closed) {
      return;
    }
    const observation: Observation = { type, payload, ts: now.toISOString() };
    for (const subscriber of this.#subscribers) {
      void subscriber(observation);
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: observation });
      return;
    }
    this.#queue.push(observation);
  }

  subscribe(subscriber: ObservationSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Observation> {
    return {
      next: async (): Promise<IteratorResult<Observation>> => {
        const item = this.#queue.shift();
        if (item !== undefined) {
          return { done: false, value: item };
        }
        if (this.#closed) {
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<Observation>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}
