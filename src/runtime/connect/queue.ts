/**
 * Request/response correlation with a cap on unanswered requests. The `/connect` endpoint refuses more than
 * `MAX_IN_FLIGHT` outstanding commands, so callers beyond the cap wait for a slot instead of being rejected.
 */

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

interface Pending<T> {
  resolve(value: T): void;
  reject(err: Error): void;
}

export class RequestQueue<T> {
  readonly limit: number;
  #inFlight = new Map<string, Pending<T>>();
  /** Slots taken, counted synchronously so a burst of concurrent requests cannot all pass the cap check. */
  #active = 0;
  #waiting: Array<() => void> = [];
  #closed: Error | undefined;

  constructor(limit: number) {
    if (limit < 1) throw new Error("limit must be >= 1");
    this.limit = limit;
  }

  get inFlight(): number {
    return this.#inFlight.size;
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  /** Takes a slot before the first await (async functions run synchronously up to it). */
  async #slot(): Promise<void> {
    while (this.#active >= this.limit) {
      if (this.#closed) throw this.#closed;
      const { promise, resolve } = Promise.withResolvers<void>();
      this.#waiting.push(resolve);
      await promise;
    }
    if (this.#closed) throw this.#closed;
    this.#active++;
  }

  #release(): void {
    this.#active--;
    this.#waiting.shift()?.();
  }

  /**
   * Wait for a free slot, register `id`, then call `send`. Resolves with the value passed to `settle(id, …)`;
   * rejects on timeout, send failure or `close`.
   */
  async request(id: string, send: () => void, timeoutMs: number, what = "request"): Promise<T> {
    await this.#slot();
    if (this.#closed) {
      this.#release();
      throw this.#closed;
    }
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const done = () => {
      clearTimeout(timer);
      this.#inFlight.delete(id);
      this.#release();
    };
    const entry: Pending<T> = {
      resolve: (v) => {
        done();
        resolve(v);
      },
      reject: (e) => {
        done();
        reject(e);
      },
    };
    const timer = setTimeout(() => entry.reject(new TimeoutError(what, timeoutMs)), timeoutMs);
    this.#inFlight.set(id, entry);
    try {
      send();
    } catch (e) {
      entry.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return promise;
  }

  /** Deliver a response; returns false when `id` is unknown (late or unsolicited). */
  settle(id: string, value: T): boolean {
    const p = this.#inFlight.get(id);
    if (!p) return false;
    p.resolve(value);
    return true;
  }

  fail(id: string, err: Error): boolean {
    const p = this.#inFlight.get(id);
    if (!p) return false;
    p.reject(err);
    return true;
  }

  /** Reject everything pending or waiting; later requests reject immediately. */
  close(err: Error): void {
    this.#closed = err;
    for (const p of [...this.#inFlight.values()]) p.reject(err);
    for (const w of this.#waiting.splice(0)) w();
  }
}
