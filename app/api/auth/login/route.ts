import { getActiveAuthUserByLogin, isAuthDbConnectionError } from "@/lib/auth/db";
import { getBetterAuthInstance } from "@/lib/auth/better-auth";
import { runBetterAuthWithDbRetry } from "@/lib/auth/better-auth-retry";
import { appendSetCookieHeaders } from "@/lib/auth/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return Response.json({ error: "Username and password are required." }, { status: 400 });
    }

    const normalizedLogin = body.username.trim();
    const normalizedPassword = body.password;
    if (!normalizedLogin || !normalizedPassword) {
      return Response.json({ error: "Username and password are required." }, { status: 400 });
    }

    const attemptBetterAuthLogin = async (mode: "username" | "email") => {
      if (mode === "username") {
        return getBetterAuthInstance().api.signInUsername({
          body: {
            username: normalizedLogin,
            password: normalizedPassword,
            rememberMe: true,
          },
          headers: req.headers,
          asResponse: true,
        });
      }

      return getBetterAuthInstance().api.signInEmail({
        body: {
          email: normalizedLogin,
          password: normalizedPassword,
          rememberMe: true,
        },
        headers: req.headers,
        asResponse: true,
      });
    };

    const loginModes: Array<"username" | "email"> = normalizedLogin.includes("@")
      ? ["email", "username"]
      : ["username", "email"];

    let betterAuthResponse: Response | null = null;
    for (const mode of loginModes) {
      betterAuthResponse = await runBetterAuthWithDbRetry(() => attemptBetterAuthLogin(mode));
      if (betterAuthResponse.ok || betterAuthResponse.status !== 401) {
        break;
      }
    }

    if (!betterAuthResponse) {
      return Response.json({ error: "Login failed. Please try again." }, { status: 500 });
    }

    if (!betterAuthResponse.ok) {
      const errorData = await betterAuthResponse.json().catch(() => ({} as { message?: string; error?: string }));
      const isAuthFailure =
        betterAuthResponse.status === 401 ||
        betterAuthResponse.status === 403 ||
        betterAuthResponse.status === 422;
      return Response.json(
        {
          error:
            errorData.message ||
            errorData.error ||
            (isAuthFailure ? "Invalid username or password." : "Login failed. Please try again."),
        },
        { status: isAuthFailure ? 401 : betterAuthResponse.status },
      );
    }

    const data = await betterAuthResponse.json().catch(() => ({} as { user?: unknown }));
    const betterAuthUser = data.user as {
      id: string;
      email: string;
      username?: string | null;
      role?: "ADMIN" | "USER";
      mustResetPassword?: boolean;
      legacyUserId?: string | null;
    } | undefined;

    const headers = new Headers();
    appendSetCookieHeaders(headers, betterAuthResponse.headers);

    const resolvedUser = betterAuthUser
      ? {
          userId: betterAuthUser.legacyUserId || betterAuthUser.id,
          username: betterAuthUser.username || betterAuthUser.email,
          email: betterAuthUser.email,
          role: betterAuthUser.role || "USER",
          mustResetPassword: Boolean(betterAuthUser.mustResetPassword),
        }
      : await getActiveAuthUserByLogin(normalizedLogin);

    if (!resolvedUser) {
      return Response.json({ error: "Login failed. User payload was missing." }, { status: 500, headers });
    }

    return Response.json({ user: resolvedUser }, { status: 200, headers });
  } catch (error) {
    console.error("Login failed", error);
    if (isAuthDbConnectionError(error)) {
      return Response.json(
        { error: "Authentication database connection timed out. Check DATABASE_URL and network access, then try again." },
        { status: 503 },
      );
    }

    return Response.json({ error: "Login failed. Please try again." }, { status: 500 });
  }
}
