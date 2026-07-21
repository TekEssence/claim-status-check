import { redirect } from "next/navigation";
import { getSessionFromCookies } from "./session";

export async function requirePageAuth() {
  const session = await getSessionFromCookies();
  if (!session) {
    redirect("/");
  }

  return session;
}
