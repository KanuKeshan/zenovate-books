import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import bankRoutes from '../../src/routes/bank.js';
import { getPool } from '../../src/db/pool.js';
import {
  setupDb, truncateAll, teardown, makeUser, makeFirm, makeBusiness, call,
  type TestUser,
} from '../helpers.js';

let app: FastifyInstance;

async function build(): Promise<FastifyInstance> {
  const a = await buildApp({ logger: false });
  await a.register(bankRoutes);
  await a.ready();
  return a;
}

interface Ctx { owner: TestUser; firmId: string; businessId: string }

async function ctx(name = 'Test Business'): Promise<Ctx> {
  const owner = await makeUser();
  const firmId = await makeFirm(owner);
  const businessId = await makeBusiness(firmId, { user: owner, role: 'owner' }, name);
  return { owner, firmId, businessId };
}

async function newTxn(c: Ctx, body: Record<string, unknown>) {
  const res = await call(app, 'POST', `/businesses/${c.businessId}/bank`, {
    token: c.owner.token, body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.transaction;
}

const STATEMENT = [
  { date: '2026-03-01', description: 'ACME CORP PAYMENT', amount: '1200.00', balance: '5200.00' },
  { date: '2026-03-02', description: 'AWS EU-WEST-1', amount: '-84.31', balance: '5115.69' },
  { date: '2026-03-03', description: 'Coffee Bar', amount: '-4.20', balance: '5111.49' },
];

async function importStatement(c: Ctx, transactions: unknown[] = STATEMENT, extra: Record<string, unknown> = {}) {
  return await call(app, 'POST', `/businesses/${c.businessId}/bank/import`, {
    token: c.owner.token, body: { transactions, ...extra },
  });
}

async function auditActions(businessId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ action: string }>(
    `SELECT action FROM audit_log WHERE business_id=$1 ORDER BY id`, [businessId],
  );
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  await setupDb();
});

beforeEach(async () => {
  await truncateAll();
  app = await build();
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await teardown();
});

// ─── tenancy ────────────────────────────────────────────────────────────────

describe('a user with no business_access row', () => {
  it('gets 404 from every bank endpoint', async () => {
    const c = await ctx();
    const stranger = await makeUser();
    const txn = await newTxn(c, { date: '2026-03-01', desc: 'ACME', amount: '10.00' });

    const b = c.businessId;
    const attempts: [string, string, unknown?][] = [
      ['GET', `/businesses/${b}/bank`],
      ['GET', `/businesses/${b}/bank/${txn.id}`],
      ['POST', `/businesses/${b}/bank`, { date: '2026-03-02', desc: 'x', amount: '1.00' }],
      ['PATCH', `/businesses/${b}/bank/${txn.id}`, { amount: '2.00' }],
      ['DELETE', `/businesses/${b}/bank/${txn.id}`, {}],
      ['POST', `/businesses/${b}/bank/import`, { transactions: STATEMENT }],
    ];

    for (const [method, url, body] of attempts) {
      const res = await call(app, method as 'GET', url, { token: stranger.token, body });
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.body.error, `${method} ${url}`).toBe('not_found');
    }

    // and nothing they tried actually happened
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM bank_txns WHERE business_id=$1', [b]);
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it('is refused without a token at all', async () => {
    const c = await ctx();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/bank`);
    expect(res.status).toBe(401);
  });

  it('cannot reach another business\'s transaction through its own business id', async () => {
    const a = await ctx('A Ltd');
    const other = await ctx('B Ltd');
    const mine = await newTxn(a, { date: '2026-03-01', desc: 'A payment', amount: '10.00' });
    const theirs = await newTxn(other, { date: '2026-03-01', desc: 'B payment', amount: '99.00' });

    // The classic cross-tenant bug: a valid id, a business the caller CAN reach.
    const read = await call(app, 'GET', `/businesses/${a.businessId}/bank/${theirs.id}`, { token: a.owner.token });
    expect(read.status).toBe(404);

    const patched = await call(app, 'PATCH', `/businesses/${a.businessId}/bank/${theirs.id}`, {
      token: a.owner.token, body: { amount: '0.01' },
    });
    expect(patched.status).toBe(404);

    const deleted = await call(app, 'DELETE', `/businesses/${a.businessId}/bank/${theirs.id}`, {
      token: a.owner.token, body: {},
    });
    expect(deleted.status).toBe(404);

    // Their row is untouched, and A's list never contains it.
    const still = await call(app, 'GET', `/businesses/${other.businessId}/bank/${theirs.id}`, {
      token: other.owner.token,
    });
    expect(still.status).toBe(200);
    expect(still.body.transaction.amount).toBe('99.00');

    const list = await call(app, 'GET', `/businesses/${a.businessId}/bank`, { token: a.owner.token });
    expect(list.body.transactions.map((t: { id: string }) => t.id)).toEqual([mine.id]);
  });

  it('gives an identical fingerprint in two businesses its own row', async () => {
    const a = await ctx('A Ltd');
    const other = await ctx('B Ltd');
    const one = await importStatement(a);
    const two = await importStatement(other);
    expect(one.body.imported).toBe(3);
    expect(two.body.imported).toBe(3);   // a different tenant is never a duplicate
  });

  it('404s an unknown or malformed business id', async () => {
    const c = await ctx();
    expect((await call(app, 'GET', '/businesses/not-a-uuid/bank', { token: c.owner.token })).status).toBe(404);
    expect((await call(app, 'GET', '/businesses/11111111-1111-4111-8111-111111111111/bank', {
      token: c.owner.token,
    })).status).toBe(404);
  });
});

// ─── roles ──────────────────────────────────────────────────────────────────

describe('roles', () => {
  it('lets read-only read but not write', async () => {
    const c = await ctx();
    const reader = await makeUser();
    await getPool().query(
      `INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'readonly')`,
      [c.businessId, reader.userId],
    );
    const txn = await newTxn(c, { date: '2026-03-01', desc: 'ACME', amount: '10.00' });

    expect((await call(app, 'GET', `/businesses/${c.businessId}/bank`, { token: reader.token })).status).toBe(200);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/bank/${txn.id}`, { token: reader.token })).status).toBe(200);
    expect((await call(app, 'POST', `/businesses/${c.businessId}/bank`, {
      token: reader.token, body: { date: '2026-03-02', desc: 'x', amount: '1.00' },
    })).status).toBe(403);
    expect((await call(app, 'POST', `/businesses/${c.businessId}/bank/import`, {
      token: reader.token, body: { transactions: STATEMENT },
    })).status).toBe(403);
    expect((await call(app, 'DELETE', `/businesses/${c.businessId}/bank/${txn.id}`, {
      token: reader.token, body: {},
    })).status).toBe(403);
  });

  it('lets an accountant write but not delete', async () => {
    const c = await ctx();
    const acct = await makeUser();
    await getPool().query(
      `INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'accountant')`,
      [c.businessId, acct.userId],
    );
    const created = await call(app, 'POST', `/businesses/${c.businessId}/bank`, {
      token: acct.token, body: { date: '2026-03-01', desc: 'ACME', amount: '10.00' },
    });
    expect(created.status).toBe(201);
    expect((await call(app, 'PATCH', `/businesses/${c.businessId}/bank/${created.body.transaction.id}`, {
      token: acct.token, body: { matched: true },
    })).status).toBe(200);
    expect((await call(app, 'POST', `/businesses/${c.businessId}/bank/import`, {
      token: acct.token, body: { transactions: STATEMENT },
    })).status).toBe(200);

    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/bank/${created.body.transaction.id}`, {
      token: acct.token, body: {},
    });
    expect(del.status).toBe(403);
    expect(del.body.error).toBe('insufficient_role');
  });
});

// ─── CRUD ───────────────────────────────────────────────────────────────────

describe('create', () => {
  it('stores a transaction and returns it', async () => {
    const c = await ctx();
    const t = await newTxn(c, {
      date: '2026-03-01', desc: 'ACME CORP', amount: '1200.55', balance: '5200.00',
      cat: 'Revenue', matched: true, posted: true, source: 'march.csv',
    });
    expect(t).toMatchObject({
      date: '2026-03-01', desc: 'ACME CORP', amount: '1200.55', balance: '5200.00',
      cat: 'Revenue', matched: true, posted: true, source: 'march.csv',
    });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);

    const read = await call(app, 'GET', `/businesses/${c.businessId}/bank/${t.id}`, { token: c.owner.token });
    expect(read.status).toBe(200);
    expect(read.body.transaction).toEqual(t);
  });

  it('defaults the optional fields and accepts a negative amount', async () => {
    const c = await ctx();
    const t = await newTxn(c, { date: '2026-03-02', description: 'AWS', amount: -84.31 });
    expect(t).toMatchObject({
      desc: 'AWS', amount: '-84.31', balance: null, cat: null,
      matched: false, posted: false, source: '',
    });
  });

  it('keeps a deliberate second identical row rather than swallowing it', async () => {
    const c = await ctx();
    const one = await newTxn(c, { date: '2026-03-03', desc: 'Coffee Bar', amount: '-4.20' });
    const two = await newTxn(c, { date: '2026-03-03', desc: 'Coffee Bar', amount: '-4.20' });
    expect(two.id).not.toBe(one.id);

    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank`, { token: c.owner.token });
    expect(list.body.count).toBe(2);

    // The first row keeps the base fingerprint, so an import of that same line
    // still matches it and does not add a third.
    const imported = await importStatement(c, [{ date: '2026-03-03', description: 'Coffee Bar', amount: '-4.20' }]);
    expect(imported.body).toMatchObject({ imported: 0, skipped: 1 });
  });

  it('writes an audit row in the same transaction', async () => {
    const c = await ctx();
    const t = await newTxn(c, { date: '2026-03-01', desc: 'ACME', amount: '10.00' });
    const { rows } = await getPool().query<{ action: string; entity_id: string; detail: Record<string, unknown> }>(
      `SELECT action, entity_id, detail FROM audit_log WHERE business_id=$1`, [c.businessId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('bank.create');
    expect(rows[0]!.entity_id).toBe(t.id);
    expect(rows[0]!.detail).toMatchObject({ amount: '10.00', date: '2026-03-01' });
  });

  it('bumps the business version', async () => {
    const c = await ctx();
    const before = await getPool().query<{ version: string }>(
      'SELECT version::text AS version FROM businesses WHERE id=$1', [c.businessId],
    );
    await newTxn(c, { date: '2026-03-01', desc: 'ACME', amount: '10.00' });
    const after = await getPool().query<{ version: string }>(
      'SELECT version::text AS version FROM businesses WHERE id=$1', [c.businessId],
    );
    expect(Number(after.rows[0]!.version)).toBe(Number(before.rows[0]!.version) + 1);
  });

  it('rejects a stale version with 409 and writes nothing', async () => {
    const c = await ctx();
    const res = await call(app, 'POST', `/businesses/${c.businessId}/bank`, {
      token: c.owner.token, body: { date: '2026-03-01', desc: 'ACME', amount: '10.00', version: 99 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('stale_write');
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM bank_txns WHERE business_id=$1', [c.businessId]);
    expect((rows[0] as { n: number }).n).toBe(0);
    expect(await auditActions(c.businessId)).toEqual([]);
  });

  it('rejects malformed bodies with 400', async () => {
    const c = await ctx();
    const bad: Record<string, unknown>[] = [
      { date: '01/03/2026', desc: 'x', amount: '1.00' },
      { date: '2026-03-01', desc: 'x' },
      { date: '2026-03-01', desc: 'x', amount: 'twelve' },
      { date: '2026-03-01', desc: 'x', amount: '1.00', nonsense: true },
      { date: '2026-03-01', desc: 'x', amount: '1.00', matched: 'yes' },
    ];
    for (const body of bad) {
      const res = await call(app, 'POST', `/businesses/${c.businessId}/bank`, { token: c.owner.token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('read and list', () => {
  it('404s an unknown or malformed transaction id', async () => {
    const c = await ctx();
    expect((await call(app, 'GET', `/businesses/${c.businessId}/bank/nope`, { token: c.owner.token })).status).toBe(404);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/bank/11111111-1111-4111-8111-111111111111`, {
      token: c.owner.token,
    })).status).toBe(404);
  });

  it('paginates newest first and reports the full count', async () => {
    const c = await ctx();
    for (let d = 1; d <= 5; d++) {
      await newTxn(c, { date: `2026-03-0${d}`, desc: `row ${d}`, amount: `${d}.00` });
    }
    const page = await call(app, 'GET', `/businesses/${c.businessId}/bank?limit=2`, { token: c.owner.token });
    expect(page.status).toBe(200);
    expect(page.body.count).toBe(5);
    expect(page.body.limit).toBe(2);
    expect(page.body.transactions.map((t: { date: string }) => t.date)).toEqual(['2026-03-05', '2026-03-04']);
    expect(page.body.pageTotal).toBe('9.00');

    const next = await call(app, 'GET', `/businesses/${c.businessId}/bank?limit=2&offset=2`, { token: c.owner.token });
    expect(next.body.transactions.map((t: { date: string }) => t.date)).toEqual(['2026-03-03', '2026-03-02']);

    const asc = await call(app, 'GET', `/businesses/${c.businessId}/bank?sort=dateAsc&limit=1`, { token: c.owner.token });
    expect(asc.body.transactions[0].date).toBe('2026-03-01');
  });

  it('defaults to a limit and refuses one over the cap', async () => {
    const c = await ctx();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/bank`, { token: c.owner.token });
    expect(res.body.limit).toBe(50);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/bank?limit=201`, { token: c.owner.token })).status).toBe(400);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/bank?limit=200`, { token: c.owner.token })).status).toBe(200);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/bank?limit=0`, { token: c.owner.token })).status).toBe(400);
  });

  it('filters by date range, category, flags and description', async () => {
    const c = await ctx();
    await newTxn(c, { date: '2026-01-15', desc: 'ACME CORP PAYMENT', amount: '100.00', cat: 'Revenue', matched: true });
    await newTxn(c, { date: '2026-02-15', desc: 'AWS EU-WEST-1', amount: '-84.31', cat: 'Software' });
    await newTxn(c, { date: '2026-03-15', desc: 'Coffee Bar', amount: '-4.20', cat: 'Meals', posted: true });

    const q = async (qs: string) => (await call(app, 'GET', `/businesses/${c.businessId}/bank?${qs}`, {
      token: c.owner.token,
    })).body;

    expect((await q('from=2026-02-01&to=2026-02-28')).count).toBe(1);
    expect((await q('category=software')).count).toBe(1);        // case-insensitive
    expect((await q('matched=true')).count).toBe(1);
    expect((await q('posted=true')).count).toBe(1);
    expect((await q('q=coffee')).count).toBe(1);
    expect((await q('q=%25')).count).toBe(0);                    // '%' is a literal, not a wildcard
    expect((await q('from=2026-05-01&to=2026-01-01')).error ?? null).toBe('bad_request');
    expect((await q('bogus=1')).error).toBe('bad_request');
  });
});

describe('update', () => {
  it('patches only what it is given', async () => {
    const c = await ctx();
    const t = await newTxn(c, {
      date: '2026-03-01', desc: 'ACME', amount: '10.00', balance: '100.00', cat: 'Revenue', source: 'march.csv',
    });
    const res = await call(app, 'PATCH', `/businesses/${c.businessId}/bank/${t.id}`, {
      token: c.owner.token, body: { matched: true, cat: 'Consulting' },
    });
    expect(res.status).toBe(200);
    expect(res.body.transaction).toMatchObject({
      id: t.id, date: '2026-03-01', desc: 'ACME', amount: '10.00', balance: '100.00',
      cat: 'Consulting', matched: true, posted: false, source: 'march.csv',
    });
  });

  it('clears the balance and the category when told to', async () => {
    const c = await ctx();
    const t = await newTxn(c, { date: '2026-03-01', desc: 'ACME', amount: '10.00', balance: '100.00', cat: 'Revenue' });
    const res = await call(app, 'PATCH', `/businesses/${c.businessId}/bank/${t.id}`, {
      token: c.owner.token, body: { balance: null, cat: null },
    });
    expect(res.body.transaction.balance).toBeNull();
    expect(res.body.transaction.cat).toBeNull();
  });

  it('moves the fingerprint with the row', async () => {
    const c = await ctx();
    const t = await newTxn(c, { date: '2026-03-01', desc: 'ACME', amount: '10.00' });
    await call(app, 'PATCH', `/businesses/${c.businessId}/bank/${t.id}`, {
      token: c.owner.token, body: { amount: '11.00' },
    });
    // The original line is no longer in the ledger, so importing it is new work.
    const imp = await importStatement(c, [{ date: '2026-03-01', description: 'ACME', amount: '10.00' }]);
    expect(imp.body).toMatchObject({ imported: 1, skipped: 0 });
    // The edited row is now the one an import of 11.00 would match.
    const again = await importStatement(c, [{ date: '2026-03-01', description: 'ACME', amount: '11.00' }]);
    expect(again.body).toMatchObject({ imported: 0, skipped: 1 });
  });

  it('audits the change and rejects a stale version', async () => {
    const c = await ctx();
    const t = await newTxn(c, { date: '2026-03-01', desc: 'ACME', amount: '10.00' });
    await call(app, 'PATCH', `/businesses/${c.businessId}/bank/${t.id}`, {
      token: c.owner.token, body: { posted: true },
    });
    expect(await auditActions(c.businessId)).toEqual(['bank.create', 'bank.update']);

    const stale = await call(app, 'PATCH', `/businesses/${c.businessId}/bank/${t.id}`, {
      token: c.owner.token, body: { posted: false, version: 1 },
    });
    expect(stale.status).toBe(409);
    const read = await call(app, 'GET', `/businesses/${c.businessId}/bank/${t.id}`, { token: c.owner.token });
    expect(read.body.transaction.posted).toBe(true);   // rolled back
  });

  it('rejects an unknown field or a bad amount with 400', async () => {
    const c = await ctx();
    const t = await newTxn(c, { date: '2026-03-01', desc: 'ACME', amount: '10.00' });
    expect((await call(app, 'PATCH', `/businesses/${c.businessId}/bank/${t.id}`, {
      token: c.owner.token, body: { nope: 1 },
    })).status).toBe(400);
    expect((await call(app, 'PATCH', `/businesses/${c.businessId}/bank/${t.id}`, {
      token: c.owner.token, body: { amount: 'lots' },
    })).status).toBe(400);
  });
});

describe('delete', () => {
  it('removes the row and audits it', async () => {
    const c = await ctx();
    const t = await newTxn(c, { date: '2026-03-01', desc: 'ACME', amount: '10.00' });
    const res = await call(app, 'DELETE', `/businesses/${c.businessId}/bank/${t.id}`, {
      token: c.owner.token, body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await call(app, 'GET', `/businesses/${c.businessId}/bank/${t.id}`, { token: c.owner.token })).status).toBe(404);
    expect(await auditActions(c.businessId)).toEqual(['bank.create', 'bank.delete']);
  });

  it('frees the fingerprint so the line can be imported again', async () => {
    const c = await ctx();
    const imported = await importStatement(c);
    expect(imported.body.imported).toBe(3);
    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank?q=coffee`, { token: c.owner.token });
    const coffee = list.body.transactions[0];
    await call(app, 'DELETE', `/businesses/${c.businessId}/bank/${coffee.id}`, { token: c.owner.token, body: {} });

    const again = await importStatement(c);
    expect(again.body).toMatchObject({ imported: 1, skipped: 2 });
  });

  it('404s an unknown id and 409s a stale version', async () => {
    const c = await ctx();
    const t = await newTxn(c, { date: '2026-03-01', desc: 'ACME', amount: '10.00' });
    expect((await call(app, 'DELETE', `/businesses/${c.businessId}/bank/11111111-1111-4111-8111-111111111111`, {
      token: c.owner.token, body: {},
    })).status).toBe(404);
    const stale = await call(app, 'DELETE', `/businesses/${c.businessId}/bank/${t.id}`, {
      token: c.owner.token, body: { version: 1 },
    });
    expect(stale.status).toBe(409);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/bank/${t.id}`, { token: c.owner.token })).status).toBe(200);
  });
});

// ─── import ─────────────────────────────────────────────────────────────────

describe('import', () => {
  it('imports a statement and imports zero when the identical payload is re-posted', async () => {
    const c = await ctx();

    const first = await importStatement(c);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ imported: 3, skipped: 0 });

    const second = await importStatement(c);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ imported: 0, skipped: 3 });

    const third = await importStatement(c);
    expect(third.body).toMatchObject({ imported: 0, skipped: 3 });

    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank`, { token: c.owner.token });
    expect(list.body.count).toBe(3);
  });

  it('imports only the rows that are new when the ranges overlap', async () => {
    const c = await ctx();
    await importStatement(c, STATEMENT.slice(0, 2));
    const overlap = await importStatement(c, [
      ...STATEMENT.slice(1),
      { date: '2026-03-04', description: 'Rent', amount: '-950.00' },
    ]);
    expect(overlap.body).toMatchObject({ imported: 2, skipped: 1, total: 3 });
    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank`, { token: c.owner.token });
    expect(list.body.count).toBe(4);
  });

  it('treats case and whitespace differences in the description as the same line', async () => {
    const c = await ctx();
    await importStatement(c, [{ date: '2026-03-01', description: 'ACME CORP  PAYMENT', amount: '1200.00' }]);
    const again = await importStatement(c, [{ date: '2026-03-01', description: '  acme corp payment ', amount: '1200.00' }]);
    expect(again.body).toMatchObject({ imported: 0, skipped: 1 });
  });

  it('treats a different date, amount or description as a different line', async () => {
    const c = await ctx();
    await importStatement(c, [{ date: '2026-03-01', description: 'ACME', amount: '10.00' }]);
    const res = await importStatement(c, [
      { date: '2026-03-02', description: 'ACME', amount: '10.00' },
      { date: '2026-03-01', description: 'ACME', amount: '10.01' },
      { date: '2026-03-01', description: 'ACME LTD', amount: '10.00' },
      { date: '2026-03-01', description: 'ACME', amount: '-10.00' },
    ]);
    expect(res.body).toMatchObject({ imported: 4, skipped: 0 });
  });

  it('collapses rows repeated within one payload', async () => {
    const c = await ctx();
    const row = { date: '2026-03-03', description: 'Coffee Bar', amount: '-4.20' };
    const res = await importStatement(c, [row, row, row]);
    expect(res.body).toMatchObject({ imported: 1, skipped: 2 });
    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank`, { token: c.owner.token });
    expect(list.body.count).toBe(1);
  });

  it('dedupes across batch boundaries on a large file', async () => {
    const c = await ctx();
    const big = Array.from({ length: 600 }, (_, i) => ({
      date: '2026-03-01', description: `line ${i}`, amount: '1.00',
    }));
    const first = await importStatement(c, big);
    expect(first.body).toMatchObject({ imported: 600, skipped: 0 });

    // Re-post the file with one genuinely new line appended.
    const second = await importStatement(c, [...big, { date: '2026-03-01', description: 'line 600', amount: '1.00' }]);
    expect(second.body).toMatchObject({ imported: 1, skipped: 600 });

    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank?limit=200`, { token: c.owner.token });
    expect(list.body.count).toBe(601);
    expect(list.body.transactions).toHaveLength(200);
  });

  it('rejects a file bigger than the cap', async () => {
    const c = await ctx();
    const huge = Array.from({ length: 10_001 }, (_, i) => ({
      date: '2026-03-01', description: `line ${i}`, amount: '1.00',
    }));
    const res = await importStatement(c, huge);
    expect(res.status).toBe(400);
  });

  it('stores the amounts and balances exactly', async () => {
    const c = await ctx();
    await importStatement(c);
    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank?sort=dateAsc`, { token: c.owner.token });
    expect(list.body.transactions.map((t: { amount: string }) => t.amount)).toEqual(['1200.00', '-84.31', '-4.20']);
    expect(list.body.transactions.map((t: { balance: string | null }) => t.balance))
      .toEqual(['5200.00', '5115.69', '5111.49']);
    expect(list.body.pageTotal).toBe('1111.49');
    // and imported rows start unreconciled
    expect(list.body.transactions.every((t: { matched: boolean; posted: boolean }) => !t.matched && !t.posted)).toBe(true);
  });

  it('adds up in cents rather than floats', async () => {
    const c = await ctx();
    const rows = Array.from({ length: 10 }, (_, i) => ({
      date: '2026-03-01', description: `row ${i}`, amount: '0.10',
    }));
    const res = await importStatement(c, rows);
    expect(res.body.imported).toBe(10);
    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank`, { token: c.owner.token });
    expect(list.body.pageTotal).toBe('1.00');
  });

  it('tags the rows with a source and audits the run', async () => {
    const c = await ctx();
    await importStatement(c, STATEMENT, { source: 'march-2026.csv' });
    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank`, { token: c.owner.token });
    expect(list.body.transactions.every((t: { source: string }) => t.source === 'march-2026.csv')).toBe(true);

    const { rows } = await getPool().query<{ action: string; detail: Record<string, unknown> }>(
      `SELECT action, detail FROM audit_log WHERE business_id=$1`, [c.businessId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('bank.import');
    expect(rows[0]!.detail).toMatchObject({ imported: 3, skipped: 0, total: 3, source: 'march-2026.csv' });
  });

  it('rejects the whole file when one row is unreadable', async () => {
    const c = await ctx();
    const res = await importStatement(c, [
      { date: '2026-03-01', description: 'good', amount: '10.00' },
      { date: '2026-03-02', description: 'bad', amount: 'ten pounds' },
    ]);
    expect(res.status).toBe(400);
    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank`, { token: c.owner.token });
    expect(list.body.count).toBe(0);
  });

  it('rejects malformed payloads with 400', async () => {
    const c = await ctx();
    const url = `/businesses/${c.businessId}/bank/import`;
    const bad: unknown[] = [
      {},
      { transactions: 'nope' },
      { transactions: [{ date: 'March 1', description: 'x', amount: '1.00' }] },
      { transactions: [{ date: '2026-03-01', description: 'x' }] },
      { transactions: [{ date: '2026-03-01', description: 'x', amount: '1.00', extra: 1 }] },
      { transactions: [], surprise: true },
    ];
    for (const body of bad) {
      const res = await call(app, 'POST', url, { token: c.owner.token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('accepts an empty statement as a no-op', async () => {
    const c = await ctx();
    const res = await importStatement(c, []);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 0, skipped: 0 });
  });

  it('rejects a stale version and imports nothing', async () => {
    const c = await ctx();
    const res = await importStatement(c, STATEMENT, { version: 99 });
    expect(res.status).toBe(409);
    const list = await call(app, 'GET', `/businesses/${c.businessId}/bank`, { token: c.owner.token });
    expect(list.body.count).toBe(0);
  });
});
