import { resetDbPool } from "@/db";
import { isAuthDbConnectionError } from "./db";
import { resetBetterAuthInstance } from "./better-auth";

export async function runBetterAuthWithDbRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt < 2 && isAuthDbConnectionError(error)) {
        await resetDbPool();
        resetBetterAuthInstance();
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }

      throw error;
    }
  }

  throw new Error("Better Auth operation failed after retry.");
}
