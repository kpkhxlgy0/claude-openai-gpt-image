interface SemaphoreWaiter {
  resolve(release: () => void): void;
  next: SemaphoreWaiter | undefined;
}

export class Semaphore {
  #available: number;
  #queueHead: SemaphoreWaiter | undefined;
  #queueTail: SemaphoreWaiter | undefined;

  constructor(capacity = 1) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("Semaphore capacity must be a positive integer");
    }
    this.#available = capacity;
  }

  async runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const release = await this.#acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#makeRelease());
    }

    return new Promise((resolve) => {
      const waiter: SemaphoreWaiter = { resolve, next: undefined };
      if (this.#queueTail === undefined) {
        this.#queueHead = waiter;
      } else {
        this.#queueTail.next = waiter;
      }
      this.#queueTail = waiter;
    });
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
        this.#queueHead = next.next;
        if (this.#queueHead === undefined) {
          this.#queueTail = undefined;
        }
        next.next = undefined;
        next.resolve(this.#makeRelease());
        return;
      }

      this.#available += 1;
    };
  }
}

export const processPaidCallGate = new Semaphore(1);
