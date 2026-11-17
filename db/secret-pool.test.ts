import test from "node:test";
import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import { createSecretPool, secretCredentials, useSecretCredentials } from "./secret-pool";
import { getPool, resetDbPool } from "./index";

test("secret cache coalesces reads, expires in five minutes, and does not retain stale credentials on failure", async () => {
  let clock = 0, reads = 0, fail = false;
  const cache = secretCredentials(async () => {
    reads++;
    if (fail) throw new Error("Secret service unavailable");
    return JSON.stringify({ username: "app-user", password: `version-${reads}` });
  }, () => clock);
  const [first, second] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(reads, 1); assert.equal(first, second);
  clock = 299999;
  assert.equal(await cache.get(), first);
  clock = 300000;
  assert.equal((await cache.get()).password, "version-2");
  clock = 600000; fail = true;
  await assert.rejects(cache.get(), /unavailable/);
  fail = false;
  assert.equal((await cache.get()).password, "version-4");
});

test("malformed secret errors cannot expose any part of the secret", async () => {
  for (const raw of ['{"password":"sensitive-value', 'null', '{}']) {
    const cache = secretCredentials(async () => raw);
    await assert.rejects(cache.get(), error => error instanceof Error
      && !error.message.includes("sensitive-value") && error.message.startsWith("Database secret must contain"));
  }
});

test("password rotation refreshes credentials and retries connection acquisition once, including callbacks", async () => {
  let reads = 0, connects = 0, released = 0;
  const credentials = secretCredentials(async () => JSON.stringify({ username: "app-user", password: ++reads === 1 ? "old" : "new" }));
  const client = { release: () => { released++; } } as unknown as PoolClient;
  const pool = { options: {}, async connect(this: { options: { user: string; password: string } }) {
    connects++;
    const options = this.options as { user: string; password: string };
    assert.equal(options.user, "app-user");
    if (options.password === "old") throw Object.assign(new Error("Authentication failed"), { code: "28P01" });
    return client;
  } } as unknown as Pool;
  useSecretCredentials(pool, credentials);
  assert.equal(await pool.connect(), client);
  assert.equal(reads, 2); assert.equal(connects, 2);
  await new Promise<void>((resolve, reject) => pool.connect((error, connected, done) => {
    if (error) return reject(error);
    assert.equal(connected, client); done(); resolve();
  }));
  assert.equal(reads, 2); assert.equal(released, 1);
});

test("non-authentication failures are not retried and repeated authentication failures stop after one refresh", async () => {
  for (const code of ["ECONNREFUSED", "28P01", "28000"]) {
    let reads = 0, connects = 0;
    const cache = secretCredentials(async () => { reads++; return '{"username":"app","password":"fixture"}'; });
    const pool = { options: {}, async connect() { connects++; throw Object.assign(new Error("fixture"), { code }); } } as unknown as Pool;
    useSecretCredentials(pool, cache);
    await assert.rejects(pool.connect(), error => (error as { code: string }).code === code);
    assert.equal(connects, code === "ECONNREFUSED" ? 1 : 2);
    assert.equal(reads, connects);
  }
});

test("a late authentication failure cannot invalidate already refreshed credentials", async () => {
  let reads = 0;
  const cache = secretCredentials(async () => JSON.stringify({ username: "app", password: String(++reads) }));
  const old = await cache.get();
  cache.invalidate(old);
  const fresh = await cache.get();
  cache.invalidate(old);
  assert.equal(await cache.get(), fresh); assert.equal(reads, 2);
});

test("RDS configuration selects the secret's region, correct database and verified TLS without opening a connection", async () => {
  const pool = createSecretPool({ query_timeout: 6000, statement_timeout: 6000 }, {
    DATABASE_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:fixture",
    RDS_PROXY_ENDPOINT: "fixture.proxy-example.us-west-2.rds.amazonaws.com", DATABASE_NAME: "claim_status",
  });
  try {
    assert.equal(pool.options.host, "fixture.proxy-example.us-west-2.rds.amazonaws.com");
    assert.equal(pool.options.database, "claim_status"); assert.equal(pool.options.port, 5432);
    assert.equal(pool.options.statement_timeout, undefined);
    assert.equal(pool.options.query_timeout, 6000); assert.equal(pool.options.max, 5);
    assert.equal(pool.options.connectionString, undefined);
    assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true, servername: pool.options.host });
  } finally { await pool.end(); }
  assert.throws(() => createSecretPool({}, { DATABASE_SECRET_ARN: "not-an-arn" }), /Configure/);
});

test("secret configuration takes priority over the old DATABASE_URL without leaking/falling back to its password", async () => {
  const names = ["DATABASE_SECRET_ARN", "DATABASE_URL", "RDS_PROXY_ENDPOINT", "DATABASE_NAME"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  await resetDbPool();
  Object.assign(process.env, { DATABASE_SECRET_ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:fixture",
    RDS_PROXY_ENDPOINT: "fixture.proxy-example.us-west-2.rds.amazonaws.com", DATABASE_NAME: "claim_status",
    DATABASE_URL: "postgres://old-user:old-password@old-host/old-database" });
  try {
    const pool = getPool();
    assert.equal(pool.options.host, process.env.RDS_PROXY_ENDPOINT);
    assert.equal(pool.options.password, undefined); assert.equal(pool.options.connectionString, undefined);
  } finally {
    await resetDbPool();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});
