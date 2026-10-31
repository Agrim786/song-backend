// Errors that map cleanly onto HTTP responses.
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// The provider said "slow down". Jobs wait instead of burning retry attempts.
export class ProviderRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number, detail = "") {
    super(`provider rate limited: ${detail.slice(0, 200)}`);
  }
}

export class ProviderError extends Error {
  constructor(readonly status: number, detail = "") {
    super(`provider error ${status}: ${detail.slice(0, 300)}`);
  }
}

// Circuit breaker is open: treat like a rate limit so the queue pauses cleanly.
export class ProviderUnavailableError extends ProviderRateLimitedError {}
