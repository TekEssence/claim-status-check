import { createManagedUser, getActiveAuthUser, listManagedUsers } from "@/lib/auth/db";
import { getSessionFromCookies } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin() {
  const session = await getSessionFromCookies();
  const user = session ? await getActiveAuthUser(session.userId) : null;
  return user?.role === "ADMIN" ? user : null;
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) {
    return Response.json({ error: "Admin access required." }, { status: 403 });
  }

  return Response.json({ users: await listManagedUsers() });
}

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (!session) {
    return Response.json({ error: "Admin access required." }, { status: 403 });
  }

  try {
    const body = await req.json();
    if (typeof body.email !== "string" || !body.email.includes("@")) {
      return Response.json({ error: "A valid email is required." }, { status: 400 });
    }

    const temporaryPassword = typeof body.temporaryPassword === "string" && body.temporaryPassword.trim()
      ? body.temporaryPassword
      : "Welcome123";

    if (temporaryPassword.length < 8) {
      return Response.json({ error: "Temporary password must be at least 8 characters." }, { status: 400 });
    }

    const user = await createManagedUser(body.email, temporaryPassword);
    return Response.json({ user, temporaryPassword });
  } catch (error: any) {
    if (error?.code === "23505") {
      return Response.json({ error: "A user with this email already exists." }, { status: 409 });
    }
    console.error("Create managed user failed", error);
    return Response.json({ error: "Unable to create user." }, { status: 500 });
  }
}
