import { and, eq, or } from "drizzle-orm";
import { isRetryableDbError, runDbWithRetry } from "@/db";
import { authAccounts, authUsers } from "@/db/schema/better-auth";
import { hashPassword, verifyPassword } from "./password";

export type AuthUser = {
  userId: string;
  username: string;
  email: string;
  role: "ADMIN" | "USER";
  mustResetPassword: boolean;
};

export type ManagedUser = {
  userId: string;
  username: string;
  email: string;
  role: "ADMIN" | "USER";
  isActive: boolean;
  mustResetPassword: boolean;
};

export type ChangePasswordResult =
  | { status: "updated"; user: AuthUser }
  | { status: "same_password" }
  | { status: "not_found" };

type AuthUserRow = typeof authUsers.$inferSelect;
type AuthAccountRow = typeof authAccounts.$inferSelect;

export function isAuthDbConnectionError(error: unknown): boolean {
  return isRetryableDbError(error);
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function parseUserIdSequence(userId: string): number | null {
  const match = /^USR(\d+)$/i.exec(userId.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

function mapAuthUser(row: AuthUserRow): AuthUser {
  return {
    userId: row.legacyUserId || row.id,
    username: row.username || row.email,
    email: row.email,
    role: row.role,
    mustResetPassword: row.mustResetPassword,
  };
}

async function findActiveUserByLogin(login: string): Promise<AuthUserRow | null> {
  const normalizedLogin = normalizeLogin(login);
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(authUsers)
      .where(
        and(
          eq(authUsers.isActive, true),
          or(
            eq(authUsers.username, normalizedLogin),
            eq(authUsers.email, normalizedLogin),
          ),
        ),
      )
      .limit(1),
  );

  return rows[0] ?? null;
}

async function findActiveUserByUserId(userId: string): Promise<AuthUserRow | null> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(authUsers)
      .where(
        and(
          eq(authUsers.isActive, true),
          or(eq(authUsers.id, userId), eq(authUsers.legacyUserId, userId)),
        ),
      )
      .limit(1),
  );

  return rows[0] ?? null;
}

async function findCredentialAccount(userId: string): Promise<AuthAccountRow | null> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(authAccounts)
      .where(and(eq(authAccounts.userId, userId), eq(authAccounts.providerId, "credential")))
      .limit(1),
  );

  return rows[0] ?? null;
}

async function generateNextUserId(): Promise<string> {
  const rows = await runDbWithRetry((db) =>
    db
      .select({
        id: authUsers.id,
        legacyUserId: authUsers.legacyUserId,
      })
      .from(authUsers),
  );

  const maxSequence = rows.reduce((max, row) => {
    const sequenceFromId = parseUserIdSequence(row.id);
    const sequenceFromLegacy = row.legacyUserId ? parseUserIdSequence(row.legacyUserId) : null;
    const sequence = Math.max(sequenceFromId ?? 0, sequenceFromLegacy ?? 0);
    return sequence > max ? sequence : max;
  }, 0);

  return `USR${String(maxSequence + 1).padStart(3, "0")}`;
}

export async function getActiveAuthUser(userId: string): Promise<AuthUser | null> {
  const row = await findActiveUserByUserId(userId);
  return row ? mapAuthUser(row) : null;
}

export async function resetPasswordByUsername(username: string, password: string): Promise<AuthUser | null> {
  const user = await findActiveUserByLogin(username);
  if (!user) {
    return null;
  }

  const result = await changePasswordForUser(user.id, password);
  if (result.status !== "updated") {
    return mapAuthUser(user);
  }

  return result.user;
}

export async function changePasswordForUser(userId: string, password: string): Promise<ChangePasswordResult> {
  const user = await findActiveUserByUserId(userId);
  if (!user) {
    return { status: "not_found" };
  }

  const account = await findCredentialAccount(user.id);
  if (account?.password && await verifyPassword(password, account.password)) {
    return { status: "same_password" };
  }

  const passwordHash = await hashPassword(password);
  const now = new Date();

  await runDbWithRetry(async (db) => {
    if (account) {
      await db
        .update(authAccounts)
        .set({
          password: passwordHash,
          updatedAt: now,
        })
        .where(eq(authAccounts.id, account.id));
    } else {
      await db
        .insert(authAccounts)
        .values({
          id: `${user.id}:credential`,
          accountId: user.id,
          providerId: "credential",
          userId: user.id,
          password: passwordHash,
          createdAt: now,
          updatedAt: now,
        });
    }

    await db
      .update(authUsers)
      .set({
        mustResetPassword: false,
        updatedAt: now,
      })
      .where(eq(authUsers.id, user.id));
  });

  const refreshed = await findActiveUserByUserId(user.id);
  return refreshed
    ? { status: "updated", user: mapAuthUser(refreshed) }
    : { status: "not_found" };
}

export async function listManagedUsers(): Promise<ManagedUser[]> {
  const rows = await runDbWithRetry((db) =>
    db
      .select()
      .from(authUsers)
      .orderBy(authUsers.id),
  );

  return rows.map((row) => ({
    userId: row.legacyUserId || row.id,
    username: row.username || row.email,
    email: row.email,
    role: row.role,
    isActive: row.isActive,
    mustResetPassword: row.mustResetPassword,
  }));
}

export async function createManagedUser(email: string, temporaryPassword: string): Promise<AuthUser> {
  const normalizedEmail = email.trim().toLowerCase();
  const userId = await generateNextUserId();
  const passwordHash = await hashPassword(temporaryPassword);
  const now = new Date();

  const rows = await runDbWithRetry(async (db) => {
    const insertedUsers = await db
      .insert(authUsers)
      .values({
        id: userId,
        legacyUserId: userId,
        name: normalizedEmail,
        email: normalizedEmail,
        emailVerified: true,
        username: normalizedEmail,
        displayUsername: normalizedEmail,
        role: "USER",
        mustResetPassword: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await db.insert(authAccounts).values({
      id: `${userId}:credential`,
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    return insertedUsers;
  });

  return mapAuthUser(rows[0]);
}

export async function updateManagedUserEmail(userId: string, email: string): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await findActiveUserByUserId(userId);
  if (!user) {
    return;
  }

  await runDbWithRetry((db) =>
    db
      .update(authUsers)
      .set({
        email: normalizedEmail,
        username: normalizedEmail,
        displayUsername: normalizedEmail,
        name: normalizedEmail,
        updatedAt: new Date(),
      })
      .where(eq(authUsers.id, user.id)),
  );
}

export async function deactivateManagedUser(userId: string): Promise<void> {
  const user = await findActiveUserByUserId(userId);
  if (!user) {
    return;
  }

  await runDbWithRetry((db) =>
    db
      .update(authUsers)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(authUsers.id, user.id)),
  );
}

export async function getCredentialPasswordHashByLogin(username: string): Promise<string | null> {
  const user = await findActiveUserByLogin(username);
  if (!user) {
    return null;
  }

  const account = await findCredentialAccount(user.id);
  return account?.password ?? null;
}
