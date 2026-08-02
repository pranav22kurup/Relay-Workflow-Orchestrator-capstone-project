export type RetryOutcome<T> =
  | { outcome: 'success'; value: T; attempts: number }
  | { outcome: 'failed'; error: unknown; attempts: number };

export type RetryOptions = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` with exponential backoff. Only errors `isRetryable` accepts
 * consume a retry - anything else (a bad param, a permanent 4xx) fails on
 * the first attempt, since retrying it would just reproduce the same error.
 */
export async function withRetries<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<RetryOutcome<T>> {
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const value = await fn(attempt);
      return { outcome: 'success', value, attempts: attempt };
    } catch (error) {
      const canRetry = attempt < options.maxAttempts && options.isRetryable(error);
      if (!canRetry) {
        return { outcome: 'failed', error, attempts: attempt };
      }
      const delayMs = Math.min(options.baseDelayMs * 2 ** (attempt - 1), options.maxDelayMs);
      options.onRetry?.(attempt, error, delayMs);
      await sleep(delayMs);
    }
  }
}
