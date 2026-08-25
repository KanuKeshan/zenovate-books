import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import journalRoutes from '../../src/routes/journal.js';
import balancesRoutes from '../../src/routes/balances.js';
import { getPool } from '../../src/db/pool.js';
import {
  setupDb, truncateAll, teardown, makeUser, makeFirm, makeBusiness, call,
  type TestUser,
} from '../helpers.js';

let app: FastifyInstance;

async function build(): Promise<FastifyInstance> {
  const a = await buildApp({ logger: false });
  await a.register(journalRoutes);
  await a.register(balancesRoutes);
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

/** A two-line entry that balances, so tests can say what they mean in one line. */
function simpleEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-02-05',
    memo: 'Equipment bought on a note',
    lines: [
      { kind: 'asset', account: 'Equipment', debit: '800.00' },
      { kind: 'liability', account: 'Notes Payable', credit: '800.00' },
    ],
    ...over,
  };
}

async function newEntry(c: Ctx, body: Record<string, unknown> = simpleEntry()) {
  const res = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
    token: c.owner.token, body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.entry;
}

async function seedInvoice(
  businessId: string,
  ref: string,
  date: string,
  amount: string,
  status: string,
  taxRate = 0,
): Promise<void> {
  await getPool().query(
    `INSERT INTO invoices (business_id,ref,client_name,issue_date,description,category,amount,tax_rate,status)
     VALUES ($1,$2,'Acme',$3,'work','Revenue',$4,$5,$6)`,
    [businessId, ref, date, amount, taxRate, status],
  );
}

async function seedExpense(businessId: string, date: string, amount: string): Promise<void> {
  await getPool().query(
    `INSERT INTO expenses (business_id,spend_date,vendor,description,category,amount)
     VALUES ($1,$2,'Vendor','thing','Other',$3)`,
    [businessId, date, amount],
  );
}

async function seedAccounts(businessId: string): Promise<void> {
  const rows: [string, string][] = [
    ['asset', 'Cash'], ['asset', 'Accounts Receivable'], ['asset', 'Equipment'],
    ['liability', 'Accounts Payable'], ['liability', 'Notes Payable'],
    ['equity', "Owner's Equity"],
  ];
  let sort = 0;
  for (const [kind, name] of rows) {
    await getPool().query(
      `INSERT INTO categories (business_id,kind,name,sort) VALUES ($1,$2,$3,$4)`,
      [businessId, kind, name, sort++],
    );
  }
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
  it('gets 404 from every journal and balances endpoint', async () => {
    const c = await ctx();
    const stranger = await makeUser();
    const entry = await newEntry(c);
    await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
      token: c.owner.token, body: { date: '2026-01-01', cash: '10.00' },
    });

    const b = c.businessId;
    const attempts: [string, string, unknown?][] = [
      ['GET', `/businesses/${b}/journal`],
      ['GET', `/businesses/${b}/journal/${entry.id}`],
      ['POST', `/businesses/${b}/journal`, simpleEntry()],
      ['DELETE', `/businesses/${b}/journal/${entry.id}`],
      ['GET', `/businesses/${b}/opening-balance`],
      ['PUT', `/businesses/${b}/opening-balance`, { date: '2026-01-01', cash: '99.00' }],
      ['DELETE', `/businesses/${b}/opening-balance`],
      ['GET', `/businesses/${b}/balance-sheet`],
      ['GET', `/businesses/${b}/balance-sheet?asOf=2026-12-31`],
    ];

    for (const [method, url, body] of attempts) {
      const res = await call(app, method as 'GET', url, { token: stranger.token, body });
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.body.error, `${method} ${url}`).toBe('not_found');
    }

    // And nothing was written or removed on the way past the check.
    const after = await call(app, 'GET', `/businesses/${b}/journal`, { token: c.owner.token });
    expect(after.body.count).toBe(1);
    const ob = await call(app, 'GET', `/businesses/${b}/opening-balance`, { token: c.owner.token });
    expect(ob.body.openingBalance.cash).toBe('10.00');
  });

  it('is refused without a token at all', async () => {
    const c = await ctx();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/journal`);
    expect(res.status).toBe(401);
  });

  it('cannot reach one business\'s entry through another business it does own', async () => {
    const a = await ctx('A');
    const entry = await newEntry(a);
    // Same user, second business: the entry id is well formed and theirs, but it
    // does not belong to this business, and that is the whole check.
    const otherId = await makeBusiness(a.firmId, { user: a.owner, role: 'owner' }, 'B');

    const read = await call(app, 'GET', `/businesses/${otherId}/journal/${entry.id}`, { token: a.owner.token });
    expect(read.status).toBe(404);
    const del = await call(app, 'DELETE', `/businesses/${otherId}/journal/${entry.id}`, { token: a.owner.token });
    expect(del.status).toBe(404);

    const still = await call(app, 'GET', `/businesses/${a.businessId}/journal/${entry.id}`, { token: a.owner.token });
    expect(still.status).toBe(200);
  });

  it('does not list another business\'s entries', async () => {
    const a = await ctx('A');
    const b = await ctx('B');
    await newEntry(a);
    const res = await call(app, 'GET', `/businesses/${b.businessId}/journal`, { token: b.owner.token });
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.count).toBe(0);
  });
});

// ─── roles ──────────────────────────────────────────────────────────────────

describe('roles', () => {
  it('lets read-only read but not post, and accountants post but not delete', async () => {
    const c = await ctx();
    const reader = await makeUser();
    const bookkeeper = await makeUser();
    await getPool().query(
      `INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'readonly'),($1,$3,'accountant')`,
      [c.businessId, reader.userId, bookkeeper.userId],
    );

    expect((await call(app, 'GET', `/businesses/${c.businessId}/journal`, { token: reader.token })).status).toBe(200);
    const readerPost = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: reader.token, body: simpleEntry(),
    });
    expect(readerPost.status).toBe(403);

    const posted = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: bookkeeper.token, body: simpleEntry(),
    });
    expect(posted.status).toBe(201);
    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/journal/${posted.body.entry.id}`, {
      token: bookkeeper.token,
    });
    expect(del.status).toBe(403);
    expect((await call(app, 'DELETE', `/businesses/${c.businessId}/journal/${posted.body.entry.id}`, {
      token: c.owner.token,
    })).status).toBe(200);
  });

  it('needs accountant to set and owner to clear an opening balance', async () => {
    const c = await ctx();
    const reader = await makeUser();
    const bookkeeper = await makeUser();
    await getPool().query(
      `INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'readonly'),($1,$3,'accountant')`,
      [c.businessId, reader.userId, bookkeeper.userId],
    );
    expect((await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
      token: reader.token, body: { date: '2026-01-01' },
    })).status).toBe(403);
    expect((await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
      token: bookkeeper.token, body: { date: '2026-01-01', cash: '5.00' },
    })).status).toBe(200);
    expect((await call(app, 'DELETE', `/businesses/${c.businessId}/opening-balance`, {
      token: bookkeeper.token,
    })).status).toBe(403);
    expect((await call(app, 'DELETE', `/businesses/${c.businessId}/opening-balance`, {
      token: c.owner.token,
    })).status).toBe(200);
  });
});

// ─── journal ────────────────────────────────────────────────────────────────

describe('POST /journal', () => {
  it('creates a balanced entry, numbers it and audits it', async () => {
    const c = await ctx();
    const entry = await newEntry(c);
    expect(entry.ref).toBe('JE-1');
    expect(entry.date).toBe('2026-02-05');
    expect(entry.debits).toBe('800.00');
    expect(entry.credits).toBe('800.00');
    expect(entry.lines).toEqual([
      { lineNo: 0, kind: 'asset', account: 'Equipment', debit: '800.00', credit: '0.00' },
      { lineNo: 1, kind: 'liability', account: 'Notes Payable', debit: '0.00', credit: '800.00' },
    ]);

    const second = await newEntry(c, simpleEntry({ memo: 'again' }));
    expect(second.ref).toBe('JE-2');

    const { rows } = await getPool().query(
      `SELECT action, entity, entity_id FROM audit_log WHERE business_id=$1 AND action='journal.create' ORDER BY id`,
      [c.businessId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.entity).toBe('journal_entry');
    expect(rows[0]!.entity_id).toBe(entry.id);
  });

  it('rejects an unbalanced entry, stating both totals', async () => {
    const c = await ctx();
    const res = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: c.owner.token,
      body: simpleEntry({
        lines: [
          { kind: 'asset', account: 'Equipment', debit: '800.00' },
          { kind: 'liability', account: 'Notes Payable', credit: '750.00' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('800.00');
    expect(res.body.message).toContain('750.00');
    expect(res.body.message).toContain('50.00');
    // Nothing half-written: the entry and its lines roll back together.
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM journal_entries WHERE business_id=$1', [c.businessId]);
    expect(rows[0]!.n).toBe(0);
  });

  it('rejects a line carrying both a debit and a credit', async () => {
    const c = await ctx();
    const res = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: c.owner.token,
      body: simpleEntry({
        lines: [
          { kind: 'asset', account: 'Equipment', debit: '800.00', credit: '800.00' },
          { kind: 'liability', account: 'Notes Payable', credit: '800.00' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('one side or the other');
  });

  it('rejects a line carrying neither side, and a negative amount', async () => {
    const c = await ctx();
    const neither = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: c.owner.token,
      body: simpleEntry({
        lines: [
          { kind: 'asset', account: 'Equipment', debit: '0' },
          { kind: 'liability', account: 'Notes Payable', credit: '0' },
        ],
      }),
    });
    expect(neither.status).toBe(400);
    expect(neither.body.message).toContain('neither a debit nor a credit');

    const negative = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: c.owner.token,
      body: simpleEntry({
        lines: [
          { kind: 'asset', account: 'Equipment', debit: '-800.00' },
          { kind: 'liability', account: 'Notes Payable', credit: '-800.00' },
        ],
      }),
    });
    expect(negative.status).toBe(400);
    expect(negative.body.message).toContain('negative');
  });

  it('rejects a single-line entry, an unknown kind and an unknown field', async () => {
    const c = await ctx();
    const oneLine = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: c.owner.token,
      body: simpleEntry({ lines: [{ kind: 'asset', account: 'Equipment', debit: '800.00' }] }),
    });
    expect(oneLine.status).toBe(400);

    const badKind = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: c.owner.token,
      body: simpleEntry({
        lines: [
          { kind: 'contra', account: 'Equipment', debit: '800.00' },
          { kind: 'liability', account: 'Notes Payable', credit: '800.00' },
        ],
      }),
    });
    expect(badKind.status).toBe(400);

    const stray = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: c.owner.token, body: simpleEntry({ postedBy: 'me' }),
    });
    expect(stray.status).toBe(400);

    const badDate = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: c.owner.token, body: simpleEntry({ date: '5 Feb 2026' }),
    });
    expect(badDate.status).toBe(400);
  });

  it('refuses a duplicate reference within the business but allows it across businesses', async () => {
    const a = await ctx('A');
    const b = await ctx('B');
    await newEntry(a, simpleEntry({ ref: 'ADJ-1' }));
    const dupe = await call(app, 'POST', `/businesses/${a.businessId}/journal`, {
      token: a.owner.token, body: simpleEntry({ ref: 'ADJ-1' }),
    });
    expect(dupe.status).toBe(409);
    const elsewhere = await call(app, 'POST', `/businesses/${b.businessId}/journal`, {
      token: b.owner.token, body: simpleEntry({ ref: 'ADJ-1' }),
    });
    expect(elsewhere.status).toBe(201);
  });

  it('takes a many-line entry that balances in cents', async () => {
    const c = await ctx();
    const entry = await newEntry(c, simpleEntry({
      lines: [
        { kind: 'expense', account: 'Software', debit: '33.33' },
        { kind: 'expense', account: 'Hosting', debit: '33.33' },
        { kind: 'expense', account: 'Support', debit: '33.34' },
        { kind: 'asset', account: 'Cash', credit: '100.00' },
      ],
    }));
    expect(entry.debits).toBe('100.00');
    expect(entry.credits).toBe('100.00');
  });

  it('bumps the business version and rejects a stale one', async () => {
    const c = await ctx();
    const before = await getPool().query<{ version: string }>(
      'SELECT version::text AS version FROM businesses WHERE id=$1', [c.businessId],
    );
    const v = before.rows[0]!.version;
    expect((await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: c.owner.token, body: simpleEntry({ version: v }),
    })).status).toBe(201);
    const stale = await call(app, 'POST', `/businesses/${c.businessId}/journal`, {
      token: c.owner.token, body: simpleEntry({ version: v }),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale_write');
  });
});

describe('GET /journal', () => {
  it('filters, sorts, pages and caps the limit', async () => {
    const c = await ctx();
    await newEntry(c, simpleEntry({ ref: 'JE-A', date: '2026-01-10', type: 'Manual' }));
    await newEntry(c, simpleEntry({ ref: 'JE-B', date: '2026-02-10', type: 'Adjustment' }));
    await newEntry(c, simpleEntry({ ref: 'JE-C', date: '2026-03-10', type: 'Manual' }));

    const newest = await call(app, 'GET', `/businesses/${c.businessId}/journal`, { token: c.owner.token });
    expect(newest.body.entries.map((e: any) => e.ref)).toEqual(['JE-C', 'JE-B', 'JE-A']);
    expect(newest.body.count).toBe(3);

    const asc = await call(app, 'GET', `/businesses/${c.businessId}/journal?sort=dateAsc`, { token: c.owner.token });
    expect(asc.body.entries.map((e: any) => e.ref)).toEqual(['JE-A', 'JE-B', 'JE-C']);

    const ranged = await call(app, 'GET', `/businesses/${c.businessId}/journal?from=2026-02-01&to=2026-02-28`, {
      token: c.owner.token,
    });
    expect(ranged.body.entries.map((e: any) => e.ref)).toEqual(['JE-B']);

    const typed = await call(app, 'GET', `/businesses/${c.businessId}/journal?type=Adjustment`, { token: c.owner.token });
    expect(typed.body.entries.map((e: any) => e.ref)).toEqual(['JE-B']);

    const byAccount = await call(app, 'GET', `/businesses/${c.businessId}/journal?account=notes%20payable`, {
      token: c.owner.token,
    });
    expect(byAccount.body.count).toBe(3);

    const paged = await call(app, 'GET', `/businesses/${c.businessId}/journal?limit=1&offset=1&sort=dateAsc`, {
      token: c.owner.token,
    });
    expect(paged.body.entries.map((e: any) => e.ref)).toEqual(['JE-B']);
    expect(paged.body.count).toBe(3);

    expect((await call(app, 'GET', `/businesses/${c.businessId}/journal?limit=500`, { token: c.owner.token })).status).toBe(400);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/journal?from=2026-03-01&to=2026-01-01`, { token: c.owner.token })).status).toBe(400);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/journal?nope=1`, { token: c.owner.token })).status).toBe(400);
  });

  it('returns 404 for a malformed or missing entry id', async () => {
    const c = await ctx();
    expect((await call(app, 'GET', `/businesses/${c.businessId}/journal/not-a-uuid`, { token: c.owner.token })).status).toBe(404);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/journal/6c1d5f0e-2b2a-4c33-8a5f-9f1f2c3d4e5a`, {
      token: c.owner.token,
    })).status).toBe(404);
  });
});

describe('DELETE /journal/:entryId', () => {
  it('removes the entry with its lines and audits it', async () => {
    const c = await ctx();
    const entry = await newEntry(c);
    const res = await call(app, 'DELETE', `/businesses/${c.businessId}/journal/${entry.id}`, { token: c.owner.token });
    expect(res.status).toBe(200);
    const { rows } = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM journal_lines WHERE entry_id=$1', [entry.id],
    );
    expect(rows[0]!.n).toBe(0);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/journal/${entry.id}`, { token: c.owner.token })).status).toBe(404);
    const { rows: log } = await getPool().query(
      `SELECT 1 FROM audit_log WHERE business_id=$1 AND action='journal.delete'`, [c.businessId],
    );
    expect(log).toHaveLength(1);
  });
});

// ─── opening balance ────────────────────────────────────────────────────────

describe('opening balance', () => {
  it('is null until set, then upserts in place', async () => {
    const c = await ctx();
    const empty = await call(app, 'GET', `/businesses/${c.businessId}/opening-balance`, { token: c.owner.token });
    expect(empty.status).toBe(200);
    expect(empty.body.openingBalance).toBeNull();

    const set = await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
      token: c.owner.token, body: { date: '2026-01-01', cash: 1000, ar: '250.00', ap: '400.00' },
    });
    expect(set.status).toBe(200);
    expect(set.body.openingBalance).toMatchObject({ date: '2026-01-01', cash: '1000.00', ar: '250.00', ap: '400.00' });

    const again = await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
      token: c.owner.token, body: { date: '2026-02-01', cash: '2000.50' },
    });
    expect(again.body.openingBalance).toMatchObject({ date: '2026-02-01', cash: '2000.50', ar: '0.00', ap: '0.00' });

    const { rows } = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM opening_balances WHERE business_id=$1', [c.businessId],
    );
    expect(rows[0]!.n).toBe(1);

    const read = await call(app, 'GET', `/businesses/${c.businessId}/opening-balance`, { token: c.owner.token });
    expect(read.body.openingBalance.cash).toBe('2000.50');
  });

  it('rejects a malformed body and a bad amount', async () => {
    const c = await ctx();
    expect((await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
      token: c.owner.token, body: { cash: '10.00' },
    })).status).toBe(400);
    expect((await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
      token: c.owner.token, body: { date: '2026-01-01', cash: 'lots' },
    })).status).toBe(400);
    expect((await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
      token: c.owner.token, body: { date: '2026-01-01', reserve: '1.00' },
    })).status).toBe(400);
  });

  it('accepts an accountant\'s parenthesised negative and keeps the sign', async () => {
    const c = await ctx();
    const res = await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
      token: c.owner.token, body: { date: '2026-01-01', cash: '(125.75)' },
    });
    expect(res.body.openingBalance.cash).toBe('-125.75');
  });

  it('404s a delete when there is nothing to clear', async () => {
    const c = await ctx();
    const res = await call(app, 'DELETE', `/businesses/${c.businessId}/opening-balance`, { token: c.owner.token });
    expect(res.status).toBe(404);
  });

  it('does not read another business\'s opening balance', async () => {
    const a = await ctx('A');
    const b = await ctx('B');
    await call(app, 'PUT', `/businesses/${a.businessId}/opening-balance`, {
      token: a.owner.token, body: { date: '2026-01-01', cash: '999.00' },
    });
    const res = await call(app, 'GET', `/businesses/${b.businessId}/opening-balance`, { token: b.owner.token });
    expect(res.body.openingBalance).toBeNull();
  });
});

// ─── balance sheet ──────────────────────────────────────────────────────────

/**
 * The worked set, computed by hand:
 *   opening 2026-01-01: cash 1,000.00, ar 250.00, ap 400.00
 *   INV-1 2026-02-01  1,000.00 @ 8.25% = 1,082.50, Paid
 *   INV-2 2026-03-01    500.00           Sent
 *   INV-3 2026-03-05    200.00           Draft
 *   expenses 2026-02-10 300.00 and 2026-03-02 45.50
 *   JE 2026-02-05  Equipment 800 / Notes Payable 800
 *   JE 2026-02-06  Cash 2,000 / Owner's Equity 2,000
 *   JE 2026-03-15  Accounting Fees 120 / Accounts Payable 120
 */
async function workedSet(c: Ctx): Promise<void> {
  await seedAccounts(c.businessId);
  await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
    token: c.owner.token, body: { date: '2026-01-01', cash: '1000.00', ar: '250.00', ap: '400.00' },
  });
  await seedInvoice(c.businessId, 'INV-1', '2026-02-01', '1000.00', 'Paid', 8.25);
  await seedInvoice(c.businessId, 'INV-2', '2026-03-01', '500.00', 'Sent');
  await seedInvoice(c.businessId, 'INV-3', '2026-03-05', '200.00', 'Draft');
  await seedExpense(c.businessId, '2026-02-10', '300.00');
  await seedExpense(c.businessId, '2026-03-02', '45.50');
  await newEntry(c, simpleEntry({ date: '2026-02-05' }));
  await newEntry(c, simpleEntry({
    date: '2026-02-06', memo: 'Owner puts money in',
    lines: [
      { kind: 'asset', account: 'Cash', debit: '2000.00' },
      { kind: 'equity', account: "Owner's Equity", credit: '2000.00' },
    ],
  }));
  await newEntry(c, simpleEntry({
    date: '2026-03-15', memo: 'Accrued accountancy fee',
    lines: [
      { kind: 'expense', account: 'Accounting Fees', debit: '120.00' },
      { kind: 'liability', account: 'Accounts Payable', credit: '120.00' },
    ],
  }));
}

describe('GET /balance-sheet', () => {
  it('is all zeroes for an empty business, and balances', async () => {
    const c = await ctx();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/balance-sheet`, { token: c.owner.token });
    expect(res.status).toBe(200);
    expect(res.body.assets).toEqual({ cash: '0.00', accountsReceivable: '0.00', other: [], total: '0.00' });
    expect(res.body.liabilities.total).toBe('0.00');
    expect(res.body.equity.total).toBe('0.00');
    expect(res.body.balanced).toBe(true);
  });

  it('adds up the worked set exactly, and Assets = Liabilities + Equity', async () => {
    const c = await ctx();
    await workedSet(c);
    const res = await call(app, 'GET', `/businesses/${c.businessId}/balance-sheet`, { token: c.owner.token });
    expect(res.status).toBe(200);
    const bs = res.body;

    // cash = 1,000 opening + 1,082.50 paid - 345.50 spent + 2,000 journal
    expect(bs.assets.cash).toBe('3737.00');
    // ar = 700 unpaid (Sent + Draft) + 250 opening
    expect(bs.assets.accountsReceivable).toBe('950.00');
    expect(bs.assets.other).toEqual([{ name: 'Equipment', amount: '800.00' }]);
    expect(bs.assets.total).toBe('5487.00');

    // ap = 400 opening + 120 accrued
    expect(bs.liabilities.accountsPayable).toBe('520.00');
    expect(bs.liabilities.other).toEqual([{ name: 'Notes Payable', amount: '800.00' }]);
    expect(bs.liabilities.total).toBe('1320.00');

    expect(bs.equity.ownersEquity).toBe('2000.00');
    // (1,782.50 invoiced - 345.50 spent) - 120 journal expense
    expect(bs.equity.retainedEarnings).toBe('1317.00');
    // 1,000 + 250 - 400
    expect(bs.equity.openingBalanceEquity).toBe('850.00');
    expect(bs.equity.other).toEqual([]);
    expect(bs.equity.total).toBe('4167.00');

    // The whole point: to the cent, with no rounding slack.
    const cents = (s: string) => Math.round(Number(s) * 100);
    expect(cents(bs.assets.total)).toBe(cents(bs.liabilities.total) + cents(bs.equity.total));
    expect(bs.balanced).toBe(true);
    expect(bs.difference).toBe('0.00');
  });

  it('honours asOf, and still balances there', async () => {
    const c = await ctx();
    await workedSet(c);
    const res = await call(app, 'GET', `/businesses/${c.businessId}/balance-sheet?asOf=2026-02-28`, {
      token: c.owner.token,
    });
    const bs = res.body;
    expect(bs.asOf).toBe('2026-02-28');
    // March's invoices, expense and accrual are all out of scope.
    expect(bs.assets.cash).toBe('3782.50');
    expect(bs.assets.accountsReceivable).toBe('250.00');
    expect(bs.liabilities.accountsPayable).toBe('400.00');
    expect(bs.equity.retainedEarnings).toBe('782.50');
    expect(bs.assets.total).toBe('4832.50');
    expect(bs.liabilities.total).toBe('1200.00');
    expect(bs.equity.total).toBe('3632.50');
    expect(bs.balanced).toBe(true);
  });

  it('leaves out an opening balance dated after the asOf', async () => {
    const c = await ctx();
    await call(app, 'PUT', `/businesses/${c.businessId}/opening-balance`, {
      token: c.owner.token, body: { date: '2026-06-01', cash: '1000.00', ar: '250.00', ap: '400.00' },
    });
    const before = await call(app, 'GET', `/businesses/${c.businessId}/balance-sheet?asOf=2026-05-31`, {
      token: c.owner.token,
    });
    expect(before.body.assets.total).toBe('0.00');
    expect(before.body.equity.openingBalanceEquity).toBe('0.00');

    const after = await call(app, 'GET', `/businesses/${c.businessId}/balance-sheet?asOf=2026-06-30`, {
      token: c.owner.token,
    });
    expect(after.body.assets.cash).toBe('1000.00');
    expect(after.body.equity.openingBalanceEquity).toBe('850.00');
    expect(after.body.balanced).toBe(true);
  });

  it('says so when a journal line names an account outside the chart of accounts', async () => {
    const c = await ctx();
    await seedAccounts(c.businessId);
    // "Prepaid Rent" is not in the categories table, so its balance has nowhere
    // to be shown — the sheet reports the difference rather than hiding it.
    await newEntry(c, simpleEntry({
      date: '2026-04-01',
      lines: [
        { kind: 'asset', account: 'Prepaid Rent', debit: '600.00' },
        { kind: 'asset', account: 'Cash', credit: '600.00' },
      ],
    }));
    const res = await call(app, 'GET', `/businesses/${c.businessId}/balance-sheet`, { token: c.owner.token });
    expect(res.body.assets.cash).toBe('-600.00');
    expect(res.body.assets.other).toEqual([{ name: 'Equipment', amount: '0.00' }]);
    expect(res.body.balanced).toBe(false);
    expect(res.body.difference).toBe('-600.00');
  });

  it('keeps two businesses\' sheets apart', async () => {
    const a = await ctx('A');
    const b = await ctx('B');
    await workedSet(a);
    const res = await call(app, 'GET', `/businesses/${b.businessId}/balance-sheet`, { token: b.owner.token });
    expect(res.body.assets.total).toBe('0.00');
    expect(res.body.equity.total).toBe('0.00');
  });

  it('rejects a malformed asOf and an unknown query key', async () => {
    const c = await ctx();
    expect((await call(app, 'GET', `/businesses/${c.businessId}/balance-sheet?asOf=yesterday`, {
      token: c.owner.token,
    })).status).toBe(400);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/balance-sheet?asAt=2026-01-01`, {
      token: c.owner.token,
    })).status).toBe(400);
  });
});
