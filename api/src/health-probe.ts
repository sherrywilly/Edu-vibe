export const HEALTH_TIMEOUT_MS = 2_000;

/** Reuse a stalled operation rather than accumulating abandoned probes. */
export class HealthProbe {
  private pending?: Promise<boolean>;

  constructor(
    private readonly check: () => Promise<boolean>,
    private readonly timeoutMs = HEALTH_TIMEOUT_MS,
  ) {}

  async run(): Promise<boolean> {
    if (!this.pending) {
      const operation = Promise.resolve()
        .then(() => this.check())
        .catch(() => false);
      this.pending = operation;
      void operation.then(() => {
        if (this.pending === operation) this.pending = undefined;
      });
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.pending,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
