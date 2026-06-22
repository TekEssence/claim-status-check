import { deactivateManagedUser, getActiveAuthUser, updateManagedUserEmail } from "@/lib/auth/db";
import { getSessionFromCookies } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin() {
  const session = await getSessionFromCookies();
  const user = session ? await getActiveAuthUser(session.userId) : null;
  return user?.role === "ADMIN" ? user : null;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await requireAdmin();
  if (!session) {
    return Response.json({ error: "Admin access required." }, { status: 403 });
  }

  const { userId } = await params;
  const body = await req.json();
  if (typeof body.email !== "string" || !body.email.includes("@")) {
    return Response.json({ error: "A valid email is required." }, { status: 400 });
  }

  await updateManagedUserEmail(userId, body.email);
  return Response.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await requireAdmin();
  if (!session) {
    return Response.json({ error: "Admin access required." }, { status: 403 });
  }

  const { userId } = await params;
  if (userId === session.userId) {
    return Response.json({ error: "You cannot deactivate your own account." }, { status: 400 });
  }

  await deactivateManagedUser(userId);
  return Response.json({ ok: true });
}
