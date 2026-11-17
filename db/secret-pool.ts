import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Pool, type PoolClient, type PoolConfig } from "pg";

type Credentials = { username: string; password: string };
type ReadSecret = () => Promise<string>;
const CACHE_MS = 5 * 60 * 1000;

/** Cache only in process memory. Never fall back to an expired secret. */
export function secretCredentials(read: ReadSecret, now = Date.now) {
  let cached: Credentials | undefined, expiresAt = 0;
  let pending: Promise<Credentials> | undefined;
  return {
    async get(): Promise<Credentials> {
      if (cached && now() < expiresAt) return cached;
      if (!pending) pending = (async () => {
        const raw = await read();
        let value: Partial<Credentials> | null;
        try { value = JSON.parse(raw); }
        catch { throw new Error("Database secret must contain JSON credentials."); }
        if (!value || typeof value.username !== "string" || !value.username || typeof value.password !== "string" || !value.password) {
          throw new Error("Database secret must contain username and password.");
        }
        cached = { username: value.username, password: value.password };
        expiresAt = now() + CACHE_MS;
        return cached;
      })().finally(() => { pending = undefined; });
      return pending;
    },
    invalidate(value: Credentials) {
      // A late failure must not discard credentials another request already refreshed.
      if (cached === value) { cached = undefined; expiresAt = 0; }
    },
  };
}

/** Refresh/retry only connection establishment, never a query or transaction. */
export function useSecretCredentials(pool: Pool, credentials: ReturnType<typeof secretCredentials>): Pool {
  const connect = pool.connect.bind(pool);
  const acquire = async (): Promise<PoolClient> => {
    const current = await credentials.get();
    pool.options.user = current.username;
    pool.options.password = current.password;
    try { return await connect(); }
    catch (error) {
      if (!["28P01", "28000"].includes(String((error as { code?: string }).code))) throw error;
      credentials.invalidate(current);
      const fresh = await credentials.get();
      pool.options.user = fresh.username;
      pool.options.password = fresh.password;
      return connect();
    }
  };
  pool.connect = ((callback?: Parameters<Pool["connect"]>[0]) => {
    const result = acquire();
    if (!callback) return result;
    void result.then(client => callback(undefined, client, client.release.bind(client)),
      error => callback(error, undefined, () => {}));
  }) as Pool["connect"];
  return pool;
}

export function createSecretPool(options: PoolConfig, env: Record<string, string | undefined> = process.env): Pool {
  const arn = env.DATABASE_SECRET_ARN!;
  const region = arn.split(":")[3];
  const host = env.RDS_PROXY_ENDPOINT;
  if (!/^arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:.+/.test(arn) || !host || /[/:\s]/.test(host)) {
    throw new Error("Configure DATABASE_SECRET_ARN and RDS_PROXY_ENDPOINT for secret-based database access.");
  }
  const port = Number(env.DATABASE_PORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DATABASE_PORT is invalid.");
  const secrets = new SecretsManagerClient({ region, maxAttempts: 2,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 5000 } });
  const credentials = secretCredentials(async () => {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: arn, VersionStage: "AWSCURRENT" }));
    if (!response.SecretString) throw new Error("Database secret must contain JSON credentials.");
    return response.SecretString;
  });
  const pool = new Pool({ ...options, host, port, database: env.DATABASE_NAME || "claim_status",
    // RDS Proxy uses a public ACM certificate; Node's trusted roots verify it.
    ssl: { rejectUnauthorized: true, servername: host },
    max: 5, maxLifetimeSeconds: 600,
    // RDS Proxy rejects statement_timeout in the startup packet.
    statement_timeout: undefined,
  });
  pool.on("error", error => console.error("Database idle connection error", { code: (error as { code?: string }).code }));
  return useSecretCredentials(pool, credentials);
}
