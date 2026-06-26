import { authenticateUser, isAuthDbConnectionError } from "@/lib/auth/db";
import { setSessionCookie } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (typeof body.username !== "string" || typeof body.password !== "string") {
      return Response.json({ error: "Username and password are required." }, { status: 400 });
    }

    const user = await authenticateUser(body.username, body.password);
    if (!user) {
      return Response.json({ error: "Invalid username or password." }, { status: 401 });
    }

    await setSessionCookie(user);
    return Response.json({ user });
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
