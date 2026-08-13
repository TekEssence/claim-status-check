import { isAuthDbConnectionError } from "@/lib/auth/db";
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

    const attemptBetterAuthLogin = async (mode: "username" | "email") => {
      if (mode === "username") {
        return getBetterAuthInstance().api.signInUsername({
          body: {
            username: body.username,
            password: body.password,
          },
          headers: req.headers,
          asResponse: true,
        });
      }

      return getBetterAuthInstance().api.signInEmail({
        body: {
          email: body.username,
          password: body.password,
        },
        headers: req.headers,
        asResponse: true,
      });
    };

    const normalizedLogin = body.username.trim();
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
      return Response.json({ error: "Invalid username or password." }, { status: 401 });
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

    if (!betterAuthUser) {
      return Response.json({ error: "Login failed. User payload was missing." }, { status: 500 });
    }

    const headers = new Headers();
    appendSetCookieHeaders(headers, betterAuthResponse.headers);

    return Response.json({
      user: {
        userId: betterAuthUser.legacyUserId || betterAuthUser.id,
        username: betterAuthUser.username || betterAuthUser.email,
        email: betterAuthUser.email,
        role: betterAuthUser.role || "USER",
        mustResetPassword: Boolean(betterAuthUser.mustResetPassword),
      },
    }, {
      status: 200,
      headers,
    });
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
