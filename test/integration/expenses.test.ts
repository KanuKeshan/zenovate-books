import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import expensesRoutes from '../../src/routes/expenses.js';
import categoriesRoutes from '../../src/routes/categories.js';
import { getPool } from '../../src/db/pool.js';
import {
  setupDb, truncateAll, teardown, makeUser, makeFirm, makeBusiness, call,
  type TestUser,
} from '../helpers.js';

let app: FastifyInstance;

async function build(): Promise<FastifyInstance> {
  const a = await buildApp({ logger: false });
  await a.register(expensesRoutes);
  await a.register(categoriesRoutes);
  await a.ready();
  return a;
}

interface Ctx { owner: TestUser; firmId: string; businessId: string }

async function ctx(): Promise<Ctx> {
  const owner = await makeUser();
  const firmId = await makeFirm(owner);
  const businessId = await makeBusiness(firmId, { user: owner, role: 'owner' });
  return { owner, firmId, businessId };
}

async function newExpense(c: Ctx, body: Record<string, unknown>) {
  const res = await call(app, 'POST', `/businesses/${c.businessId}/expenses`, {
    token: c.owner.token, body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.expense;
}

async function newCategory(c: Ctx, kind: string, name: string) {
  const res = await call(app, 'POST', `/businesses/${c.businessId}/categories`, {
    token: c.owner.token, body: { kind, name },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.category;
}

/** Invoices are written directly: this suite owns the P&L, not the invoice API. */
async function seedInvoice(
  businessId: string, ref: string, date: string, amount: string, status: string,
  category = 'Revenue', taxRate = 0,
): Promise<void> {
  await getPool().query(
    `INSERT INTO invoices (business_id,ref,client_name,issue_date,description,category,amount,tax_rate,status)
     VALUES ($1,$2,'Acme',$3,'',$4,$5,$6,$7)`,
    [businessId, ref, date, category, amount, taxRate, status],
  );
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
  it('gets 404 from every expenses, categories and P&L endpoint', async () => {
    const c = await ctx();
    const stranger = await makeUser();
    const exp = await newExpense(c, { date: '2026-03-01', vendor: 'AWS', amount: '10.00', cat: 'Software' });
    const cat = await newCategory(c, 'expense', 'Software');

    const b = c.businessId;
    const attempts: [string, string, unknown?][] = [
      ['GET', `/businesses/${b}/expenses`],
      ['GET', `/businesses/${b}/expenses/${exp.id}`],
      ['POST', `/businesses/${b}/expenses`, { date: '2026-03-02', amount: '1.00' }],
      ['PATCH', `/businesses/${b}/expenses/${exp.id}`, { amount: '2.00' }],
      ['DELETE', `/businesses/${b}/expenses/${exp.id}`],
      ['GET', `/businesses/${b}/categories`],
      ['POST', `/businesses/${b}/categories`, { kind: 'expense', name: 'Sneak' }],
      ['DELETE', `/businesses/${b}/categories/${cat.id}`],
      ['GET', `/businesses/${b}/pl`],
      ['GET', `/businesses/${b}/pl?from=2026-01-01&to=2026-12-31`],
    ];

    for (const [method, url, body] of attempts) {
      const res = await call(app, method as 'GET', url, { token: stranger.token, body });
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.body.error, `${method} ${url}`).toBe('not_found');
    }

    // Nothing was created or removed by any of that.
    const still = await call(app, 'GET', `/businesses/${b}/expenses`, { token: c.owner.token });
    expect(still.body.count).toBe(1);
    const cats = await call(app, 'GET', `/businesses/${b}/categories`, { token: c.owner.token });
    expect(cats.body.count).toBe(1);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const c = await ctx();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/expenses`);
    expect(res.status).toBe(401);
  });
});

describe('cross-tenant ids', () => {
  it('will not read, patch or delete another business\'s expense through a business you can reach', async () => {
    const mine = await ctx();
    const theirs = await ctx();
    const victim = await newExpense(theirs, { date: '2026-02-02', vendor: 'Secret', amount: '999.00' });

    const get = await call(app, 'GET', `/businesses/${mine.businessId}/expenses/${victim.id}`, {
      token: mine.owner.token,
    });
    expect(get.status).toBe(404);

    const patch = await call(app, 'PATCH', `/businesses/${mine.businessId}/expenses/${victim.id}`, {
      token: mine.owner.token, body: { amount: '1.00' },
    });
    expect(patch.status).toBe(404);

    const del = await call(app, 'DELETE', `/businesses/${mine.businessId}/expenses/${victim.id}`, {
      token: mine.owner.token,
    });
    expect(del.status).toBe(404);

    // The victim row is untouched.
    const check = await call(app, 'GET', `/businesses/${theirs.businessId}/expenses/${victim.id}`, {
      token: theirs.owner.token,
    });
    expect(check.status).toBe(200);
    expect(check.body.expense.amount).toBe('999.00');
  });

  it('will not delete another business\'s category through a business you can reach', async () => {
    const mine = await ctx();
    const theirs = await ctx();
    const victim = await newCategory(theirs, 'expense', 'Confidential');

    const del = await call(app, 'DELETE', `/businesses/${mine.businessId}/categories/${victim.id}`, {
      token: mine.owner.token,
    });
    expect(del.status).toBe(404);

    const list = await call(app, 'GET', `/businesses/${theirs.businessId}/categories`, {
      token: theirs.owner.token,
    });
    expect(list.body.categories).toHaveLength(1);
  });

  it('keeps each business\'s expenses out of the other\'s list and P&L', async () => {
    const mine = await ctx();
    const theirs = await ctx();
    await newExpense(mine, { date: '2026-01-05', vendor: 'Mine', amount: '10.00' });
    await newExpense(theirs, { date: '2026-01-05', vendor: 'Theirs', amount: '5000.00' });

    const list = await call(app, 'GET', `/businesses/${mine.businessId}/expenses`, { token: mine.owner.token });
    expect(list.body.count).toBe(1);
    expect(list.body.expenses[0].vendor).toBe('Mine');

    const pl = await call(app, 'GET', `/businesses/${mine.businessId}/pl`, { token: mine.owner.token });
    expect(pl.body.expenses.total).toBe('10.00');
  });

  it('answers 404 for a malformed business id rather than leaking a 400', async () => {
    const c = await ctx();
    const res = await call(app, 'GET', '/businesses/not-a-uuid/expenses', { token: c.owner.token });
    expect(res.status).toBe(404);
  });
});

// ─── roles ──────────────────────────────────────────────────────────────────

describe('roles', () => {
  it('lets readonly read but not write', async () => {
    const c = await ctx();
    const reader = await makeUser();
    await getPool().query(
      `INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'readonly')`,
      [c.businessId, reader.userId],
    );
    const exp = await newExpense(c, { date: '2026-04-01', amount: '3.00' });

    expect((await call(app, 'GET', `/businesses/${c.businessId}/expenses`, { token: reader.token })).status).toBe(200);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/pl`, { token: reader.token })).status).toBe(200);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/categories`, { token: reader.token })).status).toBe(200);

    const post = await call(app, 'POST', `/businesses/${c.businessId}/expenses`, {
      token: reader.token, body: { date: '2026-04-02', amount: '1.00' },
    });
    expect(post.status).toBe(403);
    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/expenses/${exp.id}`, { token: reader.token });
    expect(del.status).toBe(403);
  });

  it('lets an accountant write but not delete', async () => {
    const c = await ctx();
    const acct = await makeUser();
    await getPool().query(
      `INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'accountant')`,
      [c.businessId, acct.userId],
    );

    const post = await call(app, 'POST', `/businesses/${c.businessId}/expenses`, {
      token: acct.token, body: { date: '2026-04-02', amount: '1.00' },
    });
    expect(post.status).toBe(201);

    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/expenses/${post.body.expense.id}`, {
      token: acct.token,
    });
    expect(del.status).toBe(403);

    const cat = await call(app, 'POST', `/businesses/${c.businessId}/categories`, {
      token: acct.token, body: { kind: 'expense', name: 'Travel' },
    });
    expect(cat.status).toBe(201);
    const catDel = await call(app, 'DELETE', `/businesses/${c.businessId}/categories/${cat.body.category.id}`, {
      token: acct.token,
    });
    expect(catDel.status).toBe(403);
  });
});

// ─── expense CRUD ───────────────────────────────────────────────────────────

describe('expense CRUD', () => {
  it('creates, reads back, updates and deletes', async () => {
    const c = await ctx();
    const created = await newExpense(c, {
      date: '2026-05-11', vendor: 'Staples', desc: 'Paper', cat: 'Office', amount: '42.50',
      deductible: true, hasReceipt: true,
    });
    expect(created.amount).toBe('42.50');
    expect(created.date).toBe('2026-05-11');
    expect(created.hasReceipt).toBe(true);

    const got = await call(app, 'GET', `/businesses/${c.businessId}/expenses/${created.id}`, {
      token: c.owner.token,
    });
    expect(got.status).toBe(200);
    expect(got.body.expense).toMatchObject({ vendor: 'Staples', cat: 'Office', amount: '42.50' });

    const patched = await call(app, 'PATCH', `/businesses/${c.businessId}/expenses/${created.id}`, {
      token: c.owner.token, body: { amount: 19.99, vendor: 'Staples Ltd' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.expense.amount).toBe('19.99');
    expect(patched.body.expense.vendor).toBe('Staples Ltd');
    // Untouched fields survive a partial patch.
    expect(patched.body.expense.cat).toBe('Office');
    expect(patched.body.expense.desc).toBe('Paper');

    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/expenses/${created.id}`, {
      token: c.owner.token,
    });
    expect(del.status).toBe(200);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/expenses/${created.id}`, {
      token: c.owner.token,
    })).status).toBe(404);
  });

  it('applies defaults and returns money as a decimal string, never a float', async () => {
    const c = await ctx();
    const e = await newExpense(c, { date: '2026-05-01', amount: 0.1 });
    expect(e.amount).toBe('0.10');
    expect(e.cat).toBe('Other');
    expect(e.vendor).toBe('');
    expect(e.deductible).toBe(true);
    expect(e.hasReceipt).toBe(false);

    const big = await newExpense(c, { date: '2026-05-01', amount: '$1,234.56' });
    expect(big.amount).toBe('1234.56');

    const negative = await newExpense(c, { date: '2026-05-01', amount: '(25.00)' });
    expect(negative.amount).toBe('-25.00');
  });

  it('rejects a bad body with 400, not 500', async () => {
    const c = await ctx();
    const bad: unknown[] = [
      { date: '11/05/2026', amount: '1.00' },
      { date: '2026-05-01', amount: 'twelve' },
      { date: '2026-05-01' },
      { date: '2026-05-01', amount: '1.00', nonsense: true },
      { date: '2026-05-01', amount: '1.00', deductible: 'yes' },
    ];
    for (const body of bad) {
      const res = await call(app, 'POST', `/businesses/${c.businessId}/expenses`, { token: c.owner.token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('404s a non-uuid or unknown expense id', async () => {
    const c = await ctx();
    expect((await call(app, 'GET', `/businesses/${c.businessId}/expenses/nope`, {
      token: c.owner.token,
    })).status).toBe(404);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/expenses/8b5cf0c0-0000-4000-8000-000000000000`, {
      token: c.owner.token,
    })).status).toBe(404);
  });

  it('bumps the business version and refuses a stale write', async () => {
    const c = await ctx();
    const { rows } = await getPool().query<{ version: string }>(
      'SELECT version::text AS version FROM businesses WHERE id=$1', [c.businessId],
    );
    const v0 = rows[0]!.version;

    const ok = await call(app, 'POST', `/businesses/${c.businessId}/expenses`, {
      token: c.owner.token, body: { date: '2026-06-01', amount: '5.00', version: v0 },
    });
    expect(ok.status).toBe(201);

    const stale = await call(app, 'POST', `/businesses/${c.businessId}/expenses`, {
      token: c.owner.token, body: { date: '2026-06-02', amount: '6.00', version: v0 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale_write');
  });

  it('writes an audit row in the same transaction as the change', async () => {
    const c = await ctx();
    const e = await newExpense(c, { date: '2026-06-03', vendor: 'Ink', amount: '7.00' });
    await call(app, 'DELETE', `/businesses/${c.businessId}/expenses/${e.id}`, { token: c.owner.token });

    const { rows } = await getPool().query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM audit_log WHERE business_id=$1 AND entity='expense' ORDER BY id`,
      [c.businessId],
    );
    expect(rows.map((r) => r.action)).toEqual(['expense.create', 'expense.delete']);
    expect(rows[0]!.entity_id).toBe(e.id);
  });
});

// ─── filters and paging ─────────────────────────────────────────────────────

describe('expense filters and paging', () => {
  async function seeded(): Promise<Ctx> {
    const c = await ctx();
    await newExpense(c, { date: '2026-01-10', vendor: 'AWS', cat: 'Software', amount: '100.00' });
    await newExpense(c, { date: '2026-02-10', vendor: 'AWS', cat: 'Software', amount: '200.00' });
    await newExpense(c, { date: '2026-03-10', vendor: 'Staples', cat: 'Office', amount: '30.00' });
    await newExpense(c, { date: '2026-04-10', vendor: 'Trainline', cat: 'Travel', amount: '45.25' });
    return c;
  }

  it('filters by from and to', async () => {
    const c = await seeded();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/expenses?from=2026-02-01&to=2026-03-31`, {
      token: c.owner.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.expenses.map((e: any) => e.date).sort()).toEqual(['2026-02-10', '2026-03-10']);
  });

  it('filters by category and vendor, case-insensitively', async () => {
    const c = await seeded();
    const byCat = await call(app, 'GET', `/businesses/${c.businessId}/expenses?category=software`, {
      token: c.owner.token,
    });
    expect(byCat.body.count).toBe(2);

    const byVendor = await call(app, 'GET', `/businesses/${c.businessId}/expenses?vendor=aws`, {
      token: c.owner.token,
    });
    expect(byVendor.body.count).toBe(2);

    const both = await call(app, 'GET', `/businesses/${c.businessId}/expenses?vendor=Staples&category=Office`, {
      token: c.owner.token,
    });
    expect(both.body.count).toBe(1);
    expect(both.body.expenses[0].amount).toBe('30.00');
  });

  it('pages with a limit, reports the full count, and caps the limit at 200', async () => {
    const c = await seeded();
    const page = await call(app, 'GET', `/businesses/${c.businessId}/expenses?limit=2&offset=0&sort=dateAsc`, {
      token: c.owner.token,
    });
    expect(page.body.expenses).toHaveLength(2);
    expect(page.body.count).toBe(4);
    expect(page.body.expenses[0].date).toBe('2026-01-10');

    const next = await call(app, 'GET', `/businesses/${c.businessId}/expenses?limit=2&offset=2&sort=dateAsc`, {
      token: c.owner.token,
    });
    expect(next.body.expenses).toHaveLength(2);
    expect(next.body.expenses[0].date).toBe('2026-03-10');

    const tooBig = await call(app, 'GET', `/businesses/${c.businessId}/expenses?limit=5000`, {
      token: c.owner.token,
    });
    expect(tooBig.status).toBe(400);
  });

  it('defaults to a bounded page even with no limit given', async () => {
    const c = await seeded();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/expenses`, { token: c.owner.token });
    expect(res.body.limit).toBeLessThanOrEqual(200);
  });

  it('rejects an unknown query parameter and an inverted range', async () => {
    const c = await seeded();
    expect((await call(app, 'GET', `/businesses/${c.businessId}/expenses?bogus=1`, {
      token: c.owner.token,
    })).status).toBe(400);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/expenses?from=2026-05-01&to=2026-01-01`, {
      token: c.owner.token,
    })).status).toBe(400);
  });

  it('does not let a sort parameter reach the SQL', async () => {
    const c = await seeded();
    const res = await call(
      app, 'GET',
      `/businesses/${c.businessId}/expenses?sort=${encodeURIComponent('amount; DROP TABLE expenses')}`,
      { token: c.owner.token },
    );
    expect(res.status).toBe(400);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM expenses');
    expect((rows[0] as any).n).toBe(4);
  });
});

// ─── categories ─────────────────────────────────────────────────────────────

describe('categories', () => {
  it('creates and lists categories grouped by kind', async () => {
    const c = await ctx();
    await newCategory(c, 'expense', 'Software');
    await newCategory(c, 'expense', 'Office');
    await newCategory(c, 'income', 'Consulting');

    const res = await call(app, 'GET', `/businesses/${c.businessId}/categories`, { token: c.owner.token });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.byKind.expense.sort()).toEqual(['Office', 'Software']);
    expect(res.body.byKind.income).toEqual(['Consulting']);

    const filtered = await call(app, 'GET', `/businesses/${c.businessId}/categories?kind=income`, {
      token: c.owner.token,
    });
    expect(filtered.body.count).toBe(1);
  });

  it('returns 409 for a duplicate name in the same kind, never a 500', async () => {
    const c = await ctx();
    await newCategory(c, 'expense', 'Software');
    const again = await call(app, 'POST', `/businesses/${c.businessId}/categories`, {
      token: c.owner.token, body: { kind: 'expense', name: 'Software' },
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('conflict');
    expect(again.body.message).toContain('Software');

    // The same name under a different kind is a different account and is allowed.
    const otherKind = await call(app, 'POST', `/businesses/${c.businessId}/categories`, {
      token: c.owner.token, body: { kind: 'income', name: 'Software' },
    });
    expect(otherKind.status).toBe(201);
  });

  it('lets two businesses each have a category of the same name', async () => {
    const a = await ctx();
    const b = await ctx();
    await newCategory(a, 'expense', 'Software');
    await newCategory(b, 'expense', 'Software');
    const list = await call(app, 'GET', `/businesses/${b.businessId}/categories`, { token: b.owner.token });
    expect(list.body.count).toBe(1);
  });

  it('rejects an unknown kind and an empty name with 400', async () => {
    const c = await ctx();
    for (const body of [{ kind: 'nonsense', name: 'X' }, { kind: 'expense', name: '' }, { kind: 'expense' }]) {
      const res = await call(app, 'POST', `/businesses/${c.businessId}/categories`, {
        token: c.owner.token, body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('deletes an unused category', async () => {
    const c = await ctx();
    const cat = await newCategory(c, 'expense', 'Unused');
    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/categories/${cat.id}`, {
      token: c.owner.token,
    });
    expect(del.status).toBe(200);
    const list = await call(app, 'GET', `/businesses/${c.businessId}/categories`, { token: c.owner.token });
    expect(list.body.count).toBe(0);
  });

  it('refuses to delete a category still used by expenses, naming the count', async () => {
    const c = await ctx();
    const cat = await newCategory(c, 'expense', 'Software');
    await newExpense(c, { date: '2026-01-01', cat: 'Software', amount: '10.00' });
    await newExpense(c, { date: '2026-01-02', cat: 'software', amount: '20.00' });

    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/categories/${cat.id}`, {
      token: c.owner.token,
    });
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('conflict');
    expect(del.body.message).toContain('2 expenses');

    // Still there.
    const list = await call(app, 'GET', `/businesses/${c.businessId}/categories`, { token: c.owner.token });
    expect(list.body.count).toBe(1);
    expect(list.body.categories[0].usedBy.expenses).toBe(2);
    expect(list.body.categories[0].inUse).toBe(true);
  });

  it('refuses to delete a category still used by invoices, naming the count', async () => {
    const c = await ctx();
    const cat = await newCategory(c, 'income', 'Consulting');
    await seedInvoice(c.businessId, 'INV-1', '2026-01-01', '500.00', 'Paid', 'Consulting');

    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/categories/${cat.id}`, {
      token: c.owner.token,
    });
    expect(del.status).toBe(409);
    expect(del.body.message).toContain('1 invoice');
  });

  it('counts only references inside the same business', async () => {
    const mine = await ctx();
    const theirs = await ctx();
    const cat = await newCategory(mine, 'expense', 'Software');
    // Another firm's expense in a same-named category must not pin mine open.
    await newExpense(theirs, { date: '2026-01-01', cat: 'Software', amount: '10.00' });

    const del = await call(app, 'DELETE', `/businesses/${mine.businessId}/categories/${cat.id}`, {
      token: mine.owner.token,
    });
    expect(del.status).toBe(200);
  });

  it('lets the delete go through once the last reference is gone', async () => {
    const c = await ctx();
    const cat = await newCategory(c, 'expense', 'Software');
    const e = await newExpense(c, { date: '2026-01-01', cat: 'Software', amount: '10.00' });

    expect((await call(app, 'DELETE', `/businesses/${c.businessId}/categories/${cat.id}`, {
      token: c.owner.token,
    })).status).toBe(409);

    await call(app, 'PATCH', `/businesses/${c.businessId}/expenses/${e.id}`, {
      token: c.owner.token, body: { cat: 'Other' },
    });

    expect((await call(app, 'DELETE', `/businesses/${c.businessId}/categories/${cat.id}`, {
      token: c.owner.token,
    })).status).toBe(200);
  });

  it('audits category create and delete', async () => {
    const c = await ctx();
    const cat = await newCategory(c, 'expense', 'Temp');
    await call(app, 'DELETE', `/businesses/${c.businessId}/categories/${cat.id}`, { token: c.owner.token });
    const { rows } = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_log WHERE business_id=$1 AND entity='category' ORDER BY id`,
      [c.businessId],
    );
    expect(rows.map((r) => r.action)).toEqual(['category.create', 'category.delete']);
  });
});

// ─── profit and loss ────────────────────────────────────────────────────────

describe('the P&L', () => {
  async function books(): Promise<Ctx> {
    const c = await ctx();
    // Revenue: Paid and Sent count; Draft, Pending and Overdue do not.
    await seedInvoice(c.businessId, 'INV-1', '2026-01-15', '1000.00', 'Paid', 'Consulting');
    await seedInvoice(c.businessId, 'INV-2', '2026-02-15', '500.50', 'Sent', 'Consulting');
    await seedInvoice(c.businessId, 'INV-3', '2026-02-20', '250.00', 'Paid', 'Retainer');
    await seedInvoice(c.businessId, 'INV-4', '2026-03-15', '9999.00', 'Draft', 'Consulting');
    await seedInvoice(c.businessId, 'INV-5', '2026-03-16', '8888.00', 'Pending', 'Consulting');
    await seedInvoice(c.businessId, 'INV-6', '2025-12-31', '777.00', 'Paid', 'Consulting');

    await newExpense(c, { date: '2026-01-20', cat: 'Software', amount: '100.00' });
    await newExpense(c, { date: '2026-02-20', cat: 'Software', amount: '50.25' });
    await newExpense(c, { date: '2026-02-21', cat: 'Office', amount: '20.00' });
    await newExpense(c, { date: '2025-12-30', cat: 'Office', amount: '5000.00' });
    return c;
  }

  it('sums Paid and Sent revenue in range, groups expenses by category, and nets', async () => {
    const c = await books();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/pl?from=2026-01-01&to=2026-03-31`, {
      token: c.owner.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.from).toBe('2026-01-01');
    expect(res.body.to).toBe('2026-03-31');

    expect(res.body.revenue.total).toBe('1750.50');
    const rev = Object.fromEntries(res.body.revenue.byCategory.map((r: any) => [r.category, r.total]));
    expect(rev).toEqual({ Consulting: '1500.50', Retainer: '250.00' });

    expect(res.body.expenses.total).toBe('170.25');
    const exp = Object.fromEntries(res.body.expenses.byCategory.map((r: any) => [r.category, r.total]));
    expect(exp).toEqual({ Software: '150.25', Office: '20.00' });

    // 1750.50 - 170.25
    expect(res.body.net).toBe('1580.25');
    // Every figure is a decimal string, never a float.
    for (const v of [res.body.revenue.total, res.body.expenses.total, res.body.net]) {
      expect(typeof v).toBe('string');
      expect(v).toMatch(/^-?\d+\.\d{2}$/);
    }
  });

  it('excludes anything outside the range', async () => {
    const c = await books();
    const feb = await call(app, 'GET', `/businesses/${c.businessId}/pl?from=2026-02-01&to=2026-02-28`, {
      token: c.owner.token,
    });
    expect(feb.body.revenue.total).toBe('750.50');
    expect(feb.body.expenses.total).toBe('70.25');
    expect(feb.body.net).toBe('680.25');
  });

  it('covers everything when no range is given', async () => {
    const c = await books();
    const all = await call(app, 'GET', `/businesses/${c.businessId}/pl`, { token: c.owner.token });
    expect(all.body.from).toBeNull();
    expect(all.body.to).toBeNull();
    expect(all.body.revenue.total).toBe('2527.50');   // includes the 2025 paid invoice
    expect(all.body.expenses.total).toBe('5170.25');
    expect(all.body.net).toBe('-2642.75');
  });

  it('reports zeroes for empty books rather than failing', async () => {
    const c = await ctx();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/pl?from=2026-01-01&to=2026-12-31`, {
      token: c.owner.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.revenue.total).toBe('0.00');
    expect(res.body.expenses.total).toBe('0.00');
    expect(res.body.net).toBe('0.00');
    expect(res.body.revenue.byCategory).toEqual([]);
  });

  it('excludes sales tax from revenue', async () => {
    const c = await ctx();
    await seedInvoice(c.businessId, 'INV-9', '2026-01-01', '100.00', 'Paid', 'Consulting', 20);
    const res = await call(app, 'GET', `/businesses/${c.businessId}/pl`, { token: c.owner.token });
    // The customer pays 120.00; 20.00 of it belongs to the revenue authority.
    expect(res.body.revenue.total).toBe('100.00');
  });

  it('adds up in cents rather than floats', async () => {
    const c = await ctx();
    for (let i = 0; i < 10; i++) {
      await newExpense(c, { date: '2026-01-01', cat: 'Office', amount: '0.10' });
    }
    const res = await call(app, 'GET', `/businesses/${c.businessId}/pl`, { token: c.owner.token });
    expect(res.body.expenses.total).toBe('1.00');
    expect(res.body.net).toBe('-1.00');
  });

  it('rejects a malformed or inverted range with 400', async () => {
    const c = await ctx();
    expect((await call(app, 'GET', `/businesses/${c.businessId}/pl?from=January`, {
      token: c.owner.token,
    })).status).toBe(400);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/pl?from=2026-05-01&to=2026-01-01`, {
      token: c.owner.token,
    })).status).toBe(400);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/pl?bogus=1`, {
      token: c.owner.token,
    })).status).toBe(400);
  });
});
