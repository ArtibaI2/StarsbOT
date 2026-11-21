export class SendPacer {
  private queue: Promise<void> = Promise.resolve();
  private nextStartAt = 0;

  constructor(private readonly minIntervalMs = 35) {}

  /**
   * Runs `send` strictly after the previous one has finished and at least
   * `minIntervalMs` has passed since the previous send started. This guarantees
   * at most one in-flight request and a real cap on the request rate.
   */
  public async run<T>(send: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const waitMs = this.nextStartAt - Date.now();
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }

      this.nextStartAt = Date.now() + this.minIntervalMs;
      return await send();
    } finally {
      release();
    }
  }
}
