import { betterAuthInstance } from "@/lib/auth/better-auth";
import { runBetterAuthWithDbRetry } from "@/lib/auth/better-auth-retry";
import { appendSetCookieHeaders } from "@/lib/auth/response";
import { clearSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const headers = new Headers();
  try {
    const signOutResponse = await runBetterAuthWithDbRetry(() =>
      betterAuthInstance.api.signOut({
        headers: req.headers,
        asResponse: true,
      }),
    );
    appendSetCookieHeaders(headers, signOutResponse.headers);
  } catch {
    // Better Auth logout is best-effort if the session has already expired.
  }

  await clearSessionCookie();
  return Response.json({ ok: true }, { headers });
}
