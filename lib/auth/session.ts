import { cookies, headers as nextHeaders } from "next/headers";
import { betterAuthInstance } from "./better-auth";
import { getActiveAuthUser, type AuthUser } from "./db";
import { getActiveAutomationJobForUser } from "@/lib/automation-jobs/db";
import { getActiveScrapeJobForUser } from "@/lib/scrape-jobs/db";

export type AuthSession = AuthUser & {
  exp: number | null;
};

const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const LAST_ACTIVITY_COOKIE = "claim-status.last_activity";

function clearBetterAuthCookie(cookieStore: Awaited<ReturnType<typeof cookies>>, name: string): void {
  cookieStore.set(name, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

function setLastActivityCookie(cookieStore: Awaited<ReturnType<typeof cookies>>, timestamp: number): void {
  cookieStore.set(LAST_ACTIVITY_COOKIE, String(timestamp), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

function readLastActivity(cookieStore: Awaited<ReturnType<typeof cookies>>): number | null {
  const rawValue = cookieStore.get(LAST_ACTIVITY_COOKIE)?.value;
  if (!rawValue) return null;
  const value = Number(rawValue);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function hasActiveUserJob(userId: string): Promise<boolean> {
  try {
    const [scrapeJob, automationJob] = await Promise.all([
      getActiveScrapeJobForUser(userId),
      getActiveAutomationJobForUser(userId),
    ]);
    return Boolean(scrapeJob || automationJob);
  } catch {
    return false;
  }
}

export async function getSessionFromCookies(requestHeaders?: Headers): Promise<AuthSession | null> {
  try {
    const authResult = await betterAuthInstance.api.getSession({
      headers: requestHeaders ?? new Headers(await nextHeaders()),
    });

    if (!authResult?.session || !authResult?.user) {
      return null;
    }

    const userId = String((authResult.user as { legacyUserId?: string | null }).legacyUserId || authResult.user.id);
    const activeUser = await getActiveAuthUser(userId);
    if (!activeUser) {
      return null;
    }

    const cookieStore = await cookies();
    const now = Date.now();
    const lastActivity = readLastActivity(cookieStore);
    if (lastActivity && now - lastActivity > IDLE_TIMEOUT_MS && !(await hasActiveUserJob(activeUser.userId))) {
      await clearSessionCookie();
      return null;
    }
    setLastActivityCookie(cookieStore, now);

    return {
      ...activeUser,
      exp: Math.floor(new Date(authResult.session.expiresAt).getTime() / 1000),
    };
  } catch {
    return null;
  }
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  clearBetterAuthCookie(cookieStore, "better-auth.session_token");
  clearBetterAuthCookie(cookieStore, "better-auth.session_data");
  clearBetterAuthCookie(cookieStore, "better-auth.admin_session");
  clearBetterAuthCookie(cookieStore, LAST_ACTIVITY_COOKIE);
}
