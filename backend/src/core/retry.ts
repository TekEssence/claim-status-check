export type RetryOptions = {
  attempts: number;
  delayMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
};

export async function retry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < options.attempts && (options.shouldRetry?.(error, attempt) ?? true);
      if (!canRetry) break;
      if (options.delayMs && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }

  throw lastError;
}
