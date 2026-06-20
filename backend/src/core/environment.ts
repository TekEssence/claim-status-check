export type RuntimeEnvironment = "local" | "vercel";

export function getRuntimeEnvironment(): RuntimeEnvironment {
  return process.env.VERCEL === "1" || !!process.env.VERCEL_ENV ? "vercel" : "local";
}
