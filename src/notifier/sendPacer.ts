export class SendPacer {
  private queue: Promise<void> = Promise.resolve();
  private nextStartAt = 0;

  constructor(private readonly minIntervalMs = 35) {}

  public async run<T>(send: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    const waitMs = this.nextStartAt - Date.now();
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }

    this.nextStartAt = Date.now() + this.minIntervalMs;
    release();
    return send();
  }
}
