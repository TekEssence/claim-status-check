import { resetPasswordByUsername } from "@/lib/auth/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (typeof body.username !== "string" || body.username.trim() === "") {
      return Response.json({ error: "Username is required." }, { status: 400 });
    }
    if (typeof body.password !== "string" || body.password.length < 8) {
      return Response.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }
    if (body.password !== body.confirmPassword) {
      return Response.json({ error: "Password and confirm password must match." }, { status: 400 });
    }

    const user = await resetPasswordByUsername(body.username, body.password);
    if (!user) {
      return Response.json({ error: "Username was not found." }, { status: 404 });
    }

    return Response.json({ ok: true, user });
  } catch (error) {
    console.error("Reset password failed", error);
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "57P01"].includes(code)) {
      return Response.json(
        { error: "Database connection was interrupted while updating the password. Please try again in a moment." },
        { status: 503 },
      );
    }

    return Response.json({ error: "Reset password failed due to a server error. Please try again." }, { status: 500 });
  }
}
