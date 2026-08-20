import { AppError } from "./errors.ts";

interface SemaphoreWaiter {
  resolve(release: () => void): void;
  reject(error: unknown): void;
  previous: SemaphoreWaiter | undefined;
  next: SemaphoreWaiter | undefined;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
  queued: boolean;
}

export const PAID_CALL_MAX_PENDING = 8;

export class Semaphore {
  #available: number;
  readonly #maxPending: number;
  #pending = 0;
  #queueHead: SemaphoreWaiter | undefined;
  #queueTail: SemaphoreWaiter | undefined;

  constructor(capacity = 1, maxPending = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Semaphore capacity must be a positive integer");
    }
    if (!Number.isSafeInteger(maxPending) || maxPending < 0) {
      throw new RangeError("Semaphore pending limit must be a non-negative integer");
    }
    this.#available = capacity;
    this.#maxPending = maxPending;
  }

  get pendingCount(): number {
    return this.#pending;
  }

  async runExclusive<T>(
    operation: () => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.#acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  #acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#makeRelease());
    }
    if (this.#pending >= this.#maxPending) {
      return Promise.reject(
        new AppError(
          "RATE_LIMITED",
          "Too many paid image requests are already queued",
        ),
      );
    }

    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        reject,
        previous: this.#queueTail,
        next: undefined,
        signal,
        abort: undefined,
        queued: true,
      };
      if (this.#queueTail === undefined) {
        this.#queueHead = waiter;
      } else {
        this.#queueTail.next = waiter;
      }
      this.#queueTail = waiter;
      this.#pending += 1;

      if (signal !== undefined) {
        waiter.abort = () => {
          if (!this.#removeWaiter(waiter)) {
            return;
          }
          waiter.reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
        if (signal.aborted) {
          waiter.abort();
        }
      }
    });
  }

  #removeWaiter(waiter: SemaphoreWaiter): boolean {
    if (!waiter.queued) {
      return false;
    }
    waiter.queued = false;
    this.#pending -= 1;

    if (waiter.previous === undefined) {
      this.#queueHead = waiter.next;
    } else {
      waiter.previous.next = waiter.next;
    }
    if (waiter.next === undefined) {
      this.#queueTail = waiter.previous;
    } else {
      waiter.next.previous = waiter.previous;
    }
    waiter.previous = undefined;
    waiter.next = undefined;
    if (waiter.signal !== undefined && waiter.abort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
    return true;
  }

  #makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;

      const next = this.#queueHead;
      if (next !== undefined) {
        this.#removeWaiter(next);
        next.resolve(this.#makeRelease());
        return;
      }

      this.#available += 1;
    };
  }
}

export const processPaidCallGate = new Semaphore(1, PAID_CALL_MAX_PENDING);
