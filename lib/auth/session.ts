import { cookies, headers as nextHeaders } from "next/headers";
import { betterAuthInstance } from "./better-auth";
import { runBetterAuthWithDbRetry } from "./better-auth-retry";
import { getActiveAuthUser, type AuthUser } from "./db";

export type AuthSession = AuthUser & {
  exp: number | null;
};

function clearBetterAuthCookie(cookieStore: Awaited<ReturnType<typeof cookies>>, name: string): void {
  cookieStore.set(name, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export async function getSessionFromCookies(requestHeaders?: Headers): Promise<AuthSession | null> {
  try {
    const headers = requestHeaders ?? new Headers(await nextHeaders());
    const authResult = await runBetterAuthWithDbRetry(() =>
      betterAuthInstance.api.getSession({ headers }),
    );

    if (!authResult?.session || !authResult?.user) {
      return null;
    }

    const userId = String((authResult.user as { legacyUserId?: string | null }).legacyUserId || authResult.user.id);
    const activeUser = await getActiveAuthUser(userId);
    if (!activeUser) {
      return null;
    }

    return {
      ...activeUser,
      exp: Math.floor(new Date(authResult.session.expiresAt).getTime() / 1000),
    };
  } catch {
    return null;
  }
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  clearBetterAuthCookie(cookieStore, "better-auth.session_token");
  clearBetterAuthCookie(cookieStore, "better-auth.session_data");
  clearBetterAuthCookie(cookieStore, "better-auth.admin_session");
}
