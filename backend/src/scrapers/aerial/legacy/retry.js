async function withRetry(operation, options = {}) {
  const maxAttempts = options.maxAttempts || 1;
  const label = options.label || "operation";
  const onRetry = options.onRetry || (() => {});
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts) {
        break;
      }

      await onRetry(error, attempt, label);
    }
  }

  throw lastError;
}

module.exports = {
  withRetry,
};

