import { LoginPage } from "@/frontend/src/pages/LoginPage";
import { getActiveAuthUser } from "@/lib/auth/db";
import { betterAuthInstance } from "@/lib/auth/better-auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const authResult = await betterAuthInstance.api.getSession({
    headers: new Headers(await headers()),
  }).catch(() => null);

  if (authResult?.session && authResult.user) {
    const userId = String((authResult.user as { legacyUserId?: string | null }).legacyUserId || authResult.user.id);
    const activeUser = await getActiveAuthUser(userId).catch(() => null);
    if (activeUser) {
      redirect(activeUser.mustResetPassword ? "/claim-status" : "/portal");
    }
  }

  return <LoginPage />;
}
