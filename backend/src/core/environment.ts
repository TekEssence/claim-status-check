export type RuntimeEnvironment = "local" | "vercel";

export function isServerlessEnvironment(): boolean {
  return (
    process.env.VERCEL === "1" ||
    Boolean(process.env.VERCEL_ENV) ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(process.env.LAMBDA_TASK_ROOT) ||
    Boolean(process.env.AWS_EXECUTION_ENV)
  );
}

export function getRuntimeEnvironment(): RuntimeEnvironment {
  return isServerlessEnvironment() ? "vercel" : "local";
}
