import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { boolean, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { authAccounts, authUsers } from "@/db/schema/better-auth";

const legacyAuthUsers = pgTable("iehp_auth_users", {
  userId: varchar("user_id", { length: 64 }).primaryKey(),
  username: varchar("username", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  passwordHash: text("password_hash").notNull(),
  role: varchar("role", { length: 20 }).$type<"ADMIN" | "USER">().notNull(),
  isActive: boolean("is_active").notNull(),
  mustResetPassword: boolean("must_reset_password").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }),
  updatedAt: timestamp("updated_at", { mode: "date" }),
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`${name} must be set before running the Better Auth migration.`);
  }
  return value;
}

async function migrateLegacyUsers(pool: Pool): Promise<void> {
  const db = drizzle(pool, {
    schema: {
      legacyAuthUsers,
      authUsers,
      authAccounts,
    },
  });

  const legacyUsers = await db.select().from(legacyAuthUsers).orderBy(legacyAuthUsers.userId);
  console.log(`Found ${legacyUsers.length} legacy auth user(s) to migrate.`);

  for (const user of legacyUsers) {
    const normalizedEmail = user.email.trim().toLowerCase();
    const normalizedUsername = user.username.trim().toLowerCase();
    const createdAt = user.createdAt ?? new Date();
    const updatedAt = user.updatedAt ?? createdAt;

    await db
      .insert(authUsers)
      .values({
        id: user.userId,
        name: normalizedUsername,
        email: normalizedEmail,
        emailVerified: true,
        username: normalizedUsername,
        displayUsername: normalizedUsername,
        role: user.role,
        mustResetPassword: user.mustResetPassword,
        isActive: user.isActive,
        legacyUserId: user.userId,
        createdAt,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: authUsers.id,
        set: {
          name: normalizedUsername,
          email: normalizedEmail,
          username: normalizedUsername,
          displayUsername: normalizedUsername,
          role: user.role,
          mustResetPassword: user.mustResetPassword,
          isActive: user.isActive,
          legacyUserId: user.userId,
          updatedAt,
        },
      });

    const existingCredentialAccount = await db
      .select()
      .from(authAccounts)
      .where(and(eq(authAccounts.providerId, "credential"), eq(authAccounts.accountId, user.userId)))
      .limit(1);

    if (existingCredentialAccount[0]) {
      await db
        .update(authAccounts)
        .set({
          userId: user.userId,
          password: user.passwordHash,
          updatedAt,
        })
        .where(eq(authAccounts.id, existingCredentialAccount[0].id));
    } else {
      await db.insert(authAccounts).values({
        id: `${user.userId}:credential`,
        accountId: user.userId,
        providerId: "credential",
        userId: user.userId,
        password: user.passwordHash,
        createdAt,
        updatedAt,
      });
    }

    console.log(`Migrated ${user.userId} (${normalizedEmail}).`);
  }
}

async function main(): Promise<void> {
  const pool = new Pool({
    connectionString: requireEnv("DATABASE_URL"),
    ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false },
  });

  try {
    await migrateLegacyUsers(pool);
    console.log("Better Auth migration completed successfully.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Better Auth migration failed.", error);
  process.exitCode = 1;
});
