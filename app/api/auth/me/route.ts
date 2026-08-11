import { isAuthDbConnectionError } from "@/lib/auth/db";
import { getSessionFromCookies } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await getSessionFromCookies(req.headers);
    if (!session) {
      return Response.json({ user: null }, { status: 401 });
    }

    return Response.json({
      user: {
        userId: session.userId,
        username: session.username,
        email: session.email,
        role: session.role,
        mustResetPassword: session.mustResetPassword,
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
