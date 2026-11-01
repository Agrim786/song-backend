import {
  ProviderRateLimitedError,
  ProviderUnavailableError,
} from "../../shared/errors.js";

// After repeated real failures (not 429s) stop calling the provider for a while,
// so an outage doesn't burn every job's retry attempts in seconds.
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  get isOpen() {
    return Date.now() < this.openUntil;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen)
      throw new ProviderUnavailableError(
        this.openUntil - Date.now(),
        "circuit open",
      );
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (e) {
      if (
        !(e instanceof ProviderRateLimitedError) &&
        ++this.failures >= this.threshold
      ) {
        this.openUntil = Date.now() + this.cooldownMs;
        this.failures = 0;
      }
      throw e;
    }
  }
}
