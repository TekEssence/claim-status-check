import { changePasswordForUser, isAuthDbConnectionError } from "@/lib/auth/db";
import { getSessionFromCookies, setSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      return Response.json({ error: "You must be logged in to reset the password." }, { status: 401 });
    }

    const body = await req.json();
    if (typeof body.password !== "string" || body.password.length < 8) {
      return Response.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }
    if (body.password !== body.confirmPassword) {
      return Response.json({ error: "Password and confirm password must match." }, { status: 400 });
    }

    const result = await changePasswordForUser(session.userId, body.password);
    if (result.status === "not_found") {
      return Response.json({ error: "User account was not found." }, { status: 404 });
    }
    if (result.status === "same_password") {
      return Response.json({ error: "New password must be different from the old password." }, { status: 400 });
    }

    await setSessionCookie(result.user);
    return Response.json({ ok: true, user: result.user });
  } catch (error) {
    console.error("Change password failed", error);
    if (isAuthDbConnectionError(error)) {
      return Response.json(
        { error: "Database connection was interrupted while updating the password. Please try again in a moment." },
        { status: 503 },
      );
    }

    return Response.json({ error: "Password reset failed due to a server error. Please try again." }, { status: 500 });
  }
}
