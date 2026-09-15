import { createSignupUser, isAuthDbConnectionError } from "@/lib/auth/db";
import { passwordPolicyErrorMessage } from "@/lib/auth/password-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !email.includes("@") || !username || !password) {
      return Response.json({ error: "Email, username, and password are required." }, { status: 400 });
    }
    if (password !== body.confirmPassword) {
      return Response.json({ error: "Password and confirm password must match." }, { status: 400 });
    }
    const policyError = passwordPolicyErrorMessage(password);
    if (policyError) {
      return Response.json({ error: policyError }, { status: 400 });
    }

    const user = await createSignupUser(email, username, password);
    return Response.json({ ok: true, user });
  } catch (error: any) {
    if (error?.code === "23505") {
      return Response.json({ error: "A user with this email or username already exists." }, { status: 409 });
    }
    console.error("Signup failed", error);
    if (isAuthDbConnectionError(error)) {
      return Response.json(
        { error: "Authentication database connection timed out. Check DATABASE_URL and network access, then try again." },
        { status: 503 },
      );
    }

    return Response.json({ error: "Unable to create account." }, { status: 500 });
  }
}
