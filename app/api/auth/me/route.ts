import { getActiveAuthUser, isAuthDbConnectionError } from "@/lib/auth/db";
import { getSessionFromCookies } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return Response.json({ user: null }, { status: 401 });
    }

    const user = await getActiveAuthUser(session.userId);
    if (!user) {
      return Response.json({ user: null }, { status: 401 });
    }

    return Response.json({
      user: {
        userId: user.userId,
        username: user.username,
        email: user.email,
        role: user.role,
        mustResetPassword: user.mustResetPassword,
      },
    });
  } catch (error) {
    console.error("Load auth user failed", error);
    if (isAuthDbConnectionError(error)) {
      return Response.json({ error: "Authentication database connection timed out." }, { status: 503 });
    }

    return Response.json({ error: "Unable to load authenticated user." }, { status: 500 });
  }
}
