import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getPool, closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { mintDevToken } from '../src/lib/auth.js';

// Every integration test file runs against the same real Postgres. Truncating
// between tests rather than recreating the schema keeps them fast, and running
// the migrations once proves the migrations themselves work — a schema built by
// hand in a fixture is a schema nobody has proved is deployable.
process.env.DATABASE_URL ??= 'postgres://claude@127.0.0.1:5433/clarabooks_test';
process.env.DEV_AUTH_SECRET ??= 'test-only-secret-not-for-any-real-environment';
process.env.NODE_ENV ??= 'test';
process.env.AWS_REGION ??= 'us-east-1';

let migrated = false;

export async function setupDb(): Promise<void> {
  if (!migrated) {
    await migrate();
    migrated = true;
  }
  await truncateAll();
}

export async function truncateAll(): Promise<void> {
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
