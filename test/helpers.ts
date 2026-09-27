import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getPool, closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { mintDevToken } from '../src/lib/auth.js';

// Every integration test file runs against the same real Postgres. Truncating
// between tests rather than recreating the schema keeps them fast, and running
// the migrations once proves the migrations themselves work — a schema built by
// hand in a fixture is a schema nobody has proved is deployable.
// `??=` only fills a variable that is completely unset. That is not enough
// once a real .env can legitimately set DEV_AUTH_SECRET to an empty string
// (to turn dev auth off) — an empty string is not nullish, so `??=` would
// leave it empty and every test that signs in would fail. Treat "unset OR
// empty" as "needs the test default" instead.
const fallback = (key: string, value: string) => { if (!process.env[key]) process.env[key] = value; };
fallback('DATABASE_URL', 'postgres://claude@127.0.0.1:5433/clarabooks_test');
fallback('DEV_AUTH_SECRET', 'test-only-secret-not-for-any-real-environment');
fallback('NODE_ENV', 'test');
fallback('AWS_REGION', 'us-east-1');

let migrated = false;

export async function setupDb(): Promise<void> {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
  await truncateAll();
}

export async function truncateAll(): Promise<void> {
  // Belt-and-suspenders: the DATABASE_URL fallback above only fires when the
  // variable is completely unset, but importing migrate.js pulls in its own
  // process.loadEnvFile() call, which can populate DATABASE_URL from a real
  // .env before this file's fallback ever runs — pointing every test at
  // someone's real database. A destructive TRUNCATE must never fire against
  // anything whose name doesn't self-identify as disposable, no matter how it
  // got selected.
  const { rows } = await getPool().query<{ name: string }>('SELECT current_database() AS name');
  const dbName = rows[0]!.name;
  if (!/test|e2e/i.test(dbName)) {
    throw new Error(
      `Refusing to TRUNCATE database "${dbName}" — its name doesn't contain "test" or "e2e", ` +
      `so it doesn't look disposable. Set DATABASE_URL to a real test database before running tests.`,
    );
  }
  await getPool().query(`
    TRUNCATE audit_log, journal_lines, journal_entries, bank_txns, opening_balances,
             invoices, expenses, clients, categories, business_access, businesses,
             firm_members, firms, users
    RESTART IDENTITY CASCADE`);
}

export async function teardown(): Promise<void> {
  await closePool();
}

export interface TestUser {
  userId: string;
  sub: string;
  email: string;
  token: string;
  auth: { authorization: string };
}

/** Creates a user the way a first Cognito login would, and returns a usable token. */
export async function makeUser(email = `u${randomUUID().slice(0, 8)}@example.test`, name = 'Test User'): Promise<TestUser> {
  const sub = `sub-${randomUUID()}`;
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (cognito_sub, email, name) VALUES ($1,$2,$3) RETURNING id`,
    [sub, email, name],
  );
  const token = mintDevToken({ sub, email, name });
  return { userId: rows[0]!.id, sub, email, token, auth: { authorization: `Bearer ${token}` } };
}

export async function makeFirm(owner: TestUser, name = 'Test Firm'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING id`,
    [name],
  );
  const firmId = rows[0]!.id;
  await getPool().query(`INSERT INTO firm_members (firm_id, user_id, role) VALUES ($1,$2,'owner')`, [
    firmId,
    owner.userId,
  ]);
  return firmId;
}

/** A business plus an access grant. Access is separate on purpose: tests that
 *  forget to grant it should fail closed, exactly as the API does. */
export async function makeBusiness(
  firmId: string,
  grantTo?: { user: TestUser; role?: 'owner' | 'accountant' | 'readonly' },
  name = 'Test Business',
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO businesses (firm_id, name) VALUES ($1,$2) RETURNING id`,
    [firmId, name],
  );
  const id = rows[0]!.id;
  if (grantTo) {
    await getPool().query(
      `INSERT INTO business_access (business_id, user_id, role) VALUES ($1,$2,$3)`,
      [id, grantTo.user.userId, grantTo.role ?? 'owner'],
    );
  }
  return id;
}

export interface Injected {
  status: number;
  body: any;
  headers: Record<string, unknown>;
}

/** Thin wrapper over Fastify's inject so tests read as intent, not plumbing. */
export async function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Injected> {
  const res = await app.inject({
    method,
    url,
    payload: opts.body as any,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
  });
  let body: any = res.body;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    /* non-JSON responses (the HTML front end) come back raw */
  }
  return { status: res.statusCode, body, headers: res.headers as Record<string, unknown> };
}
