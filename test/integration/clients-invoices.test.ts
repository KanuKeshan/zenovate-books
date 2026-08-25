import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import clientsRoutes from '../../src/routes/clients.js';
import invoicesRoutes from '../../src/routes/invoices.js';
import { getPool } from '../../src/db/pool.js';
import {
  setupDb, truncateAll, teardown, makeUser, makeFirm, makeBusiness, call,
  type TestUser,
} from '../helpers.js';

let app: FastifyInstance;

async function build(): Promise<FastifyInstance> {
  const a = await buildApp({ logger: false });
  await a.register(clientsRoutes);
  await a.register(invoicesRoutes);
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

async function newClient(c: Ctx, name: string, extra: Record<string, unknown> = {}) {
  const res = await call(app, 'POST', `/businesses/${c.businessId}/clients`, {
    token: c.owner.token, body: { name, ...extra },
  });
  expect(res.status).toBe(201);
  return res.body.client;
}

async function newInvoice(c: Ctx, body: Record<string, unknown>) {
  const res = await call(app, 'POST', `/businesses/${c.businessId}/invoices`, {
    token: c.owner.token, body,
  });
  expect(res.status).toBe(201);
  return res.body.invoice;
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
  it('gets 404 from every clients and invoices endpoint', async () => {
    const c = await ctx();
    const stranger = await makeUser();
    const client = await newClient(c, 'Acme');
    const inv = await newInvoice(c, { client: 'Acme', date: '2026-01-10', amount: '100.00' });

    const b = c.businessId;
    const attempts: [string, string, unknown?][] = [
      ['GET', `/businesses/${b}/clients`],
      ['GET', `/businesses/${b}/clients/${client.id}`],
      ['POST', `/businesses/${b}/clients`, { name: 'Sneak' }],
      ['PATCH', `/businesses/${b}/clients/${client.id}`, { name: 'Sneak' }],
      ['DELETE', `/businesses/${b}/clients/${client.id}`],
      ['GET', `/businesses/${b}/invoices`],
      ['GET', `/businesses/${b}/invoices/${inv.id}`],
      ['POST', `/businesses/${b}/invoices`, { client: 'Acme', date: '2026-01-10', amount: '5.00' }],
      ['PATCH', `/businesses/${b}/invoices/${inv.id}`, { amount: '9.00' }],
      ['DELETE', `/businesses/${b}/invoices/${inv.id}`],
      ['GET', `/businesses/${b}/aging`],
    ];

    for (const [method, url, body] of attempts) {
      const res = await call(app, method as 'GET', url, { token: stranger.token, body });
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.body.error, `${method} ${url}`).toBe('not_found');
      // The message must not distinguish "not yours" from "does not exist".
      expect(String(res.body.message)).not.toMatch(/Acme/);
    }

    // and nothing was written
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM clients WHERE business_id=$1', [b]);
    expect(rows[0].n).toBe(1);
  });

  it('is rejected without a token at all', async () => {
    const c = await ctx();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/clients`);
    expect(res.status).toBe(401);
  });
});

describe('cross-tenant ids', () => {
  it('will not read another business\'s invoice through a business the caller can reach', async () => {
    const a = await ctx();
    const b = await ctx();
    const theirs = await newInvoice(a, { client: 'Acme', date: '2026-02-01', amount: '400.00' });

    const res = await call(app, 'GET', `/businesses/${b.businessId}/invoices/${theirs.id}`, {
      token: b.owner.token,
    });
    expect(res.status).toBe(404);

    const patched = await call(app, 'PATCH', `/businesses/${b.businessId}/invoices/${theirs.id}`, {
      token: b.owner.token, body: { amount: '1.00' },
    });
    expect(patched.status).toBe(404);

    const { rows } = await getPool().query('SELECT amount FROM invoices WHERE id=$1', [theirs.id]);
    expect(rows[0].amount).toBe('400.00');
  });

  it('will not delete another business\'s client through a reachable business', async () => {
    const a = await ctx();
    const b = await ctx();
    const theirs = await newClient(a, 'Acme');
    const res = await call(app, 'DELETE', `/businesses/${b.businessId}/clients/${theirs.id}`, {
      token: b.owner.token,
    });
    expect(res.status).toBe(404);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM clients WHERE id=$1', [theirs.id]);
    expect(rows[0].n).toBe(1);
  });

  it('answers 404 rather than 500 for a non-uuid nested id', async () => {
    const c = await ctx();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/clients/not-a-uuid`, { token: c.owner.token });
    expect(res.status).toBe(404);
    const inv = await call(app, 'GET', `/businesses/${c.businessId}/invoices/not-a-uuid`, { token: c.owner.token });
    expect(inv.status).toBe(404);
  });
});

describe('roles', () => {
  it('lets readonly read but not write', async () => {
    const c = await ctx();
    const reader = await makeUser();
    await getPool().query(
      `INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'readonly')`,
      [c.businessId, reader.userId],
    );
    await newClient(c, 'Acme');

    expect((await call(app, 'GET', `/businesses/${c.businessId}/clients`, { token: reader.token })).status).toBe(200);
    const write = await call(app, 'POST', `/businesses/${c.businessId}/clients`, {
      token: reader.token, body: { name: 'Nope' },
    });
    expect(write.status).toBe(403);
    expect(write.body.error).toBe('insufficient_role');
  });

  it('requires owner to delete', async () => {
    const c = await ctx();
    const acct = await makeUser();
    await getPool().query(
      `INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'accountant')`,
      [c.businessId, acct.userId],
    );
    const inv = await newInvoice(c, { client: '', date: '2026-01-01', amount: '10.00' });

    const patched = await call(app, 'PATCH', `/businesses/${c.businessId}/invoices/${inv.id}`, {
      token: acct.token, body: { status: 'Paid' },
    });
    expect(patched.status).toBe(200);

    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/invoices/${inv.id}`, { token: acct.token });
    expect(del.status).toBe(403);
  });
});

// ─── clients ────────────────────────────────────────────────────────────────

describe('clients CRUD', () => {
  it('creates, reads, lists, updates and deletes', async () => {
    const c = await ctx();
    const created = await newClient(c, 'Acme Industries', {
      email: 'ap@acme.test', phone: '555-0100', address: '1 Way', taxRate: 8.25,
    });
    expect(created.name).toBe('Acme Industries');
    expect(created.taxRate).toBe(8.25);

    const got = await call(app, 'GET', `/businesses/${c.businessId}/clients/${created.id}`, { token: c.owner.token });
    expect(got.status).toBe(200);
    expect(got.body.client.email).toBe('ap@acme.test');

    await newClient(c, 'Beta Co');
    const list = await call(app, 'GET', `/businesses/${c.businessId}/clients`, { token: c.owner.token });
    expect(list.status).toBe(200);
    expect(list.body.clients.map((x: any) => x.name)).toEqual(['Acme Industries', 'Beta Co']);
    expect(list.body.count).toBe(2);

    const patched = await call(app, 'PATCH', `/businesses/${c.businessId}/clients/${created.id}`, {
      token: c.owner.token, body: { phone: '555-0199' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.client.phone).toBe('555-0199');
    expect(patched.body.client.name).toBe('Acme Industries');

    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/clients/${created.id}`, { token: c.owner.token });
    expect(del.status).toBe(200);
    const after = await call(app, 'GET', `/businesses/${c.businessId}/clients/${created.id}`, { token: c.owner.token });
    expect(after.status).toBe(404);
  });

  it('refuses a duplicate name in the same business but allows it in another', async () => {
    const c = await ctx();
    await newClient(c, 'Acme');
    const dup = await call(app, 'POST', `/businesses/${c.businessId}/clients`, {
      token: c.owner.token, body: { name: 'Acme' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(/already exists/);

    const other = await ctx();
    await newClient(other, 'Acme'); // different business, same name: fine
  });

  it('rejects a malformed body and unknown fields', async () => {
    const c = await ctx();
    expect((await call(app, 'POST', `/businesses/${c.businessId}/clients`, {
      token: c.owner.token, body: { name: '' },
    })).status).toBe(400);
    expect((await call(app, 'POST', `/businesses/${c.businessId}/clients`, {
      token: c.owner.token, body: { name: 'X', wat: 1 },
    })).status).toBe(400);
  });

  it('caps the list limit at 200', async () => {
    const c = await ctx();
    const over = await call(app, 'GET', `/businesses/${c.businessId}/clients?limit=500`, { token: c.owner.token });
    expect(over.status).toBe(400);
    const ok = await call(app, 'GET', `/businesses/${c.businessId}/clients?limit=200`, { token: c.owner.token });
    expect(ok.status).toBe(200);
    expect(ok.body.limit).toBe(200);
  });

  it('writes an audit row inside the same transaction as the write', async () => {
    const c = await ctx();
    const created = await newClient(c, 'Audited');
    const { rows } = await getPool().query(
      `SELECT action, entity_id, detail FROM audit_log WHERE business_id=$1 AND action='client.create'`,
      [c.businessId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_id).toBe(created.id);
    expect(rows[0].detail.name).toBe('Audited');
  });
});

describe('renaming a client', () => {
  it('rewrites the invoices that reference it by name', async () => {
    const c = await ctx();
    const client = await newClient(c, 'Acme');
    await newInvoice(c, { client: 'Acme', date: '2026-01-05', amount: '100.00' });
    await newInvoice(c, { client: 'Acme', date: '2026-02-05', amount: '200.00' });
    await newInvoice(c, { client: 'Beta', date: '2026-02-05', amount: '300.00' });

    const res = await call(app, 'PATCH', `/businesses/${c.businessId}/clients/${client.id}`, {
      token: c.owner.token, body: { name: 'Acme Ltd' },
    });
    expect(res.status).toBe(200);
    expect(res.body.invoicesRenamed).toBe(2);

    const list = await call(app, 'GET', `/businesses/${c.businessId}/invoices?client=Acme%20Ltd`, {
      token: c.owner.token,
    });
    expect(list.body.count).toBe(2);
    const beta = await call(app, 'GET', `/businesses/${c.businessId}/invoices?client=Beta`, { token: c.owner.token });
    expect(beta.body.count).toBe(1);
  });

  it('adopts invoices written before the client row existed, then renames those too', async () => {
    const c = await ctx();
    await newInvoice(c, { client: 'Ghost', date: '2026-01-05', amount: '50.00' });
    const client = await newClient(c, 'Ghost'); // created after the invoice
    const res = await call(app, 'PATCH', `/businesses/${c.businessId}/clients/${client.id}`, {
      token: c.owner.token, body: { name: 'Ghost LLC' },
    });
    expect(res.body.invoicesRenamed).toBe(1);
    const list = await call(app, 'GET', `/businesses/${c.businessId}/invoices?client=Ghost%20LLC`, {
      token: c.owner.token,
    });
    expect(list.body.count).toBe(1);
    expect(list.body.invoices[0].clientId).toBe(client.id);
  });

  it('does not touch another business\'s identically named client', async () => {
    const a = await ctx();
    const b = await ctx();
    const mine = await newClient(a, 'Shared Name');
    await newClient(b, 'Shared Name');
    await newInvoice(b, { client: 'Shared Name', date: '2026-01-01', amount: '10.00' });

    await call(app, 'PATCH', `/businesses/${a.businessId}/clients/${mine.id}`, {
      token: a.owner.token, body: { name: 'Renamed' },
    });
    const theirs = await call(app, 'GET', `/businesses/${b.businessId}/invoices`, { token: b.owner.token });
    expect(theirs.body.invoices[0].client).toBe('Shared Name');
  });

  it('refuses a rename that collides with another client', async () => {
    const c = await ctx();
    const one = await newClient(c, 'One');
    await newClient(c, 'Two');
    const res = await call(app, 'PATCH', `/businesses/${c.businessId}/clients/${one.id}`, {
      token: c.owner.token, body: { name: 'Two' },
    });
    expect(res.status).toBe(409);
  });
});

describe('deleting a client that has invoices', () => {
  it('is refused with a message naming the count, and leaves everything in place', async () => {
    const c = await ctx();
    const client = await newClient(c, 'Acme');
    const inv = await newInvoice(c, { client: 'Acme', date: '2026-01-05', amount: '100.00' });

    const res = await call(app, 'DELETE', `/businesses/${c.businessId}/clients/${client.id}`, {
      token: c.owner.token,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict');
    expect(res.body.message).toMatch(/Acme/);
    expect(res.body.message).toMatch(/1 invoice\b/);
    expect(res.body.message).toMatch(/reassign/i);

    expect((await call(app, 'GET', `/businesses/${c.businessId}/clients/${client.id}`, {
      token: c.owner.token,
    })).status).toBe(200);

    // remove the invoice and the delete goes through
    expect((await call(app, 'DELETE', `/businesses/${c.businessId}/invoices/${inv.id}`, {
      token: c.owner.token,
    })).status).toBe(200);
    expect((await call(app, 'DELETE', `/businesses/${c.businessId}/clients/${client.id}`, {
      token: c.owner.token,
    })).status).toBe(200);
  });
});

// ─── invoices ───────────────────────────────────────────────────────────────

describe('invoice totals', () => {
  it('computes total = amount * (1 + taxRate/100) in cents', async () => {
    const c = await ctx();
    const inv = await newInvoice(c, {
      client: 'Acme', date: '2026-03-01', amount: '1000.00', taxRate: 8.25,
    });
    expect(inv.amount).toBe('1000.00');
    expect(inv.taxRate).toBe(8.25);
    expect(inv.tax).toBe('82.50');
    expect(inv.total).toBe('1082.50');
  });

  it('does not lose a cent to float arithmetic', async () => {
    const c = await ctx();
    // 0.1 + 0.2 territory: 1000.10 at 8.25% is 82.508..., which must round to 82.51
    const inv = await newInvoice(c, { client: 'A', date: '2026-03-01', amount: '1000.10', taxRate: 8.25 });
    expect(inv.total).toBe('1082.61');

    const zero = await newInvoice(c, { ref: 'Z1', client: 'A', date: '2026-03-01', amount: '19.99' });
    expect(zero.total).toBe('19.99');

    const big = await newInvoice(c, { ref: 'Z2', client: 'A', date: '2026-03-01', amount: '12345678.91', taxRate: 20 });
    expect(big.total).toBe('14814814.69');
  });

  it('accepts accountant-style negatives and currency symbols', async () => {
    const c = await ctx();
    const credit = await newInvoice(c, { client: 'A', date: '2026-03-01', amount: '($250.00)', taxRate: 10 });
    expect(credit.amount).toBe('-250.00');
    expect(credit.total).toBe('-275.00');
  });

  it('rejects an unparseable amount with 400, not 500', async () => {
    const c = await ctx();
    const res = await call(app, 'POST', `/businesses/${c.businessId}/invoices`, {
      token: c.owner.token, body: { client: 'A', date: '2026-03-01', amount: 'twelve' },
    });
    expect(res.status).toBe(400);
  });
});

describe('invoice CRUD', () => {
  it('auto-numbers, reads back, updates and deletes', async () => {
    const c = await ctx();
    const a = await newInvoice(c, { client: 'A', date: '2026-01-01', amount: '10.00' });
    const b = await newInvoice(c, { client: 'A', date: '2026-01-02', amount: '20.00' });
    expect(a.ref).toBe('INV-1');
    expect(b.ref).toBe('INV-2');

    const got = await call(app, 'GET', `/businesses/${c.businessId}/invoices/${a.id}`, { token: c.owner.token });
    expect(got.status).toBe(200);
    expect(got.body.invoice.status).toBe('Pending');

    const patched = await call(app, 'PATCH', `/businesses/${c.businessId}/invoices/${a.id}`, {
      token: c.owner.token, body: { status: 'Paid', amount: '11.50' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.invoice.status).toBe('Paid');
    expect(patched.body.invoice.total).toBe('11.50');
    expect(patched.body.invoice.client).toBe('A'); // untouched fields survive

    const del = await call(app, 'DELETE', `/businesses/${c.businessId}/invoices/${a.id}`, { token: c.owner.token });
    expect(del.status).toBe(200);
    expect((await call(app, 'GET', `/businesses/${c.businessId}/invoices/${a.id}`, {
      token: c.owner.token,
    })).status).toBe(404);
  });

  it('links a new invoice to an existing client row', async () => {
    const c = await ctx();
    const client = await newClient(c, 'Acme');
    const inv = await newInvoice(c, { client: 'Acme', date: '2026-01-01', amount: '10.00' });
    expect(inv.clientId).toBe(client.id);
  });

  it('refuses a duplicate ref and an invalid status', async () => {
    const c = await ctx();
    await newInvoice(c, { ref: 'X-1', client: 'A', date: '2026-01-01', amount: '10.00' });
    const dup = await call(app, 'POST', `/businesses/${c.businessId}/invoices`, {
      token: c.owner.token, body: { ref: 'X-1', client: 'A', date: '2026-01-01', amount: '10.00' },
    });
    expect(dup.status).toBe(409);

    const bad = await call(app, 'POST', `/businesses/${c.businessId}/invoices`, {
      token: c.owner.token, body: { client: 'A', date: '2026-01-01', amount: '1.00', status: 'Screaming' },
    });
    expect(bad.status).toBe(400);
  });

  it('rejects a due date before the issue date and a malformed date', async () => {
    const c = await ctx();
    expect((await call(app, 'POST', `/businesses/${c.businessId}/invoices`, {
      token: c.owner.token, body: { client: 'A', date: '2026-03-01', due: '2026-02-01', amount: '1.00' },
    })).status).toBe(400);
    expect((await call(app, 'POST', `/businesses/${c.businessId}/invoices`, {
      token: c.owner.token, body: { client: 'A', date: '01/03/2026', amount: '1.00' },
    })).status).toBe(400);
  });

  it('audits create, update and delete', async () => {
    const c = await ctx();
    const inv = await newInvoice(c, { client: 'A', date: '2026-01-01', amount: '10.00' });
    await call(app, 'PATCH', `/businesses/${c.businessId}/invoices/${inv.id}`, {
      token: c.owner.token, body: { status: 'Sent' },
    });
    await call(app, 'DELETE', `/businesses/${c.businessId}/invoices/${inv.id}`, { token: c.owner.token });
    const { rows } = await getPool().query(
      `SELECT action FROM audit_log WHERE business_id=$1 AND entity='invoice' ORDER BY id`,
      [c.businessId],
    );
    expect(rows.map((r: any) => r.action)).toEqual(['invoice.create', 'invoice.update', 'invoice.delete']);
  });
});

describe('invoice listing', () => {
  async function seed(c: Ctx) {
    await newInvoice(c, { ref: 'A1', client: 'Acme', date: '2026-01-10', amount: '100.00', status: 'Paid' });
    await newInvoice(c, { ref: 'A2', client: 'Acme', date: '2026-02-10', amount: '200.00', status: 'Sent' });
    await newInvoice(c, { ref: 'B1', client: 'Beta', date: '2026-03-10', amount: '300.00', status: 'Sent' });
    await newInvoice(c, { ref: 'B2', client: 'Beta', date: '2026-04-10', amount: '400.00', status: 'Draft' });
  }

  it('filters by status, date range and client, and paginates', async () => {
    const c = await ctx();
    await seed(c);
    const base = `/businesses/${c.businessId}/invoices`;

    const sent = await call(app, 'GET', `${base}?status=Sent`, { token: c.owner.token });
    expect(sent.body.invoices.map((i: any) => i.ref).sort()).toEqual(['A2', 'B1']);

    const range = await call(app, 'GET', `${base}?from=2026-02-01&to=2026-03-31`, { token: c.owner.token });
    expect(range.body.invoices.map((i: any) => i.ref).sort()).toEqual(['A2', 'B1']);

    const acme = await call(app, 'GET', `${base}?client=acme`, { token: c.owner.token });
    expect(acme.body.count).toBe(2);

    const combined = await call(app, 'GET', `${base}?client=Acme&status=Sent&from=2026-01-01`, {
      token: c.owner.token,
    });
    expect(combined.body.invoices.map((i: any) => i.ref)).toEqual(['A2']);

    const page = await call(app, 'GET', `${base}?limit=2&offset=0&sort=dateAsc`, { token: c.owner.token });
    expect(page.body.invoices.map((i: any) => i.ref)).toEqual(['A1', 'A2']);
    expect(page.body.count).toBe(4);
    const page2 = await call(app, 'GET', `${base}?limit=2&offset=2&sort=dateAsc`, { token: c.owner.token });
    expect(page2.body.invoices.map((i: any) => i.ref)).toEqual(['B1', 'B2']);
  });

  it('caps the limit at 200 and rejects an unknown sort key', async () => {
    const c = await ctx();
    const base = `/businesses/${c.businessId}/invoices`;
    expect((await call(app, 'GET', `${base}?limit=201`, { token: c.owner.token })).status).toBe(400);
    const ok = await call(app, 'GET', `${base}?limit=200`, { token: c.owner.token });
    expect(ok.body.limit).toBe(200);
    expect((await call(app, 'GET', `${base}?sort=amount;DROP`, { token: c.owner.token })).status).toBe(400);
  });

  it('defaults to a bounded page even with no limit given', async () => {
    const c = await ctx();
    await seed(c);
    const res = await call(app, 'GET', `/businesses/${c.businessId}/invoices`, { token: c.owner.token });
    expect(res.body.limit).toBeLessThanOrEqual(200);
    expect(res.body.invoices.length).toBeLessThanOrEqual(res.body.limit);
  });

  it('never returns another business\'s invoices', async () => {
    const a = await ctx();
    const b = await ctx();
    await seed(a);
    const res = await call(app, 'GET', `/businesses/${b.businessId}/invoices`, { token: b.owner.token });
    expect(res.body.invoices).toHaveLength(0);
    expect(res.body.count).toBe(0);
  });

  it('treats a SQL-ish client filter as a literal, not as SQL', async () => {
    const c = await ctx();
    await seed(c);
    const res = await call(app, 'GET',
      `/businesses/${c.businessId}/invoices?client=${encodeURIComponent("Acme' OR '1'='1")}`,
      { token: c.owner.token });
    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(0);
  });
});

// ─── aging ──────────────────────────────────────────────────────────────────

describe('AR aging', () => {
  async function seedAging(c: Ctx) {
    // asOf is 2026-06-30 in the assertions below.
    await newInvoice(c, { ref: 'CUR', client: 'A', date: '2026-06-01', due: '2026-07-15', amount: '100.00', status: 'Sent' });
    await newInvoice(c, { ref: 'D15', client: 'A', date: '2026-05-01', due: '2026-06-15', amount: '200.00', taxRate: 10, status: 'Sent' });
    await newInvoice(c, { ref: 'D46', client: 'A', date: '2026-04-01', due: '2026-05-15', amount: '300.00', status: 'Overdue' });
    await newInvoice(c, { ref: 'D76', client: 'A', date: '2026-03-01', due: '2026-04-15', amount: '400.00', status: 'Pending' });
    await newInvoice(c, { ref: 'D166', client: 'A', date: '2026-01-01', due: '2026-01-15', amount: '500.00', status: 'Overdue' });
    // excluded: settled and not yet issued
    await newInvoice(c, { ref: 'PAID', client: 'A', date: '2026-01-01', due: '2026-01-15', amount: '900.00', status: 'Paid' });
    await newInvoice(c, { ref: 'DRAFT', client: 'A', date: '2026-01-01', due: '2026-01-15', amount: '900.00', status: 'Draft' });
  }

  it('buckets unpaid invoices by age at asOf', async () => {
    const c = await ctx();
    await seedAging(c);
    const res = await call(app, 'GET', `/businesses/${c.businessId}/aging?asOf=2026-06-30`, {
      token: c.owner.token,
    });
    expect(res.status).toBe(200);
    expect(res.body.asOf).toBe('2026-06-30');
    expect(res.body.buckets).toEqual({
      current: { count: 1, total: '100.00' },
      '1-30': { count: 1, total: '220.00' },   // 200.00 + 10% tax
      '31-60': { count: 1, total: '300.00' },
      '61-90': { count: 1, total: '400.00' },
      '90+': { count: 1, total: '500.00' },
    });
    expect(res.body.total).toEqual({ count: 5, total: '1520.00' });
  });

  it('moves invoices between buckets as asOf advances', async () => {
    const c = await ctx();
    await seedAging(c);
    const early = await call(app, 'GET', `/businesses/${c.businessId}/aging?asOf=2026-04-16`, {
      token: c.owner.token,
    });
    // Two months earlier the same books look very different: three invoices are
    // not yet due, the April one is a day late, and only January is 90+.
    expect(early.body.buckets.current.count).toBe(3);
    expect(early.body.buckets['1-30'].count).toBe(1);
    expect(early.body.buckets['31-60'].count).toBe(0);
    expect(early.body.buckets['61-90'].count).toBe(0);
    expect(early.body.buckets['90+'].count).toBe(1);
    expect(early.body.total.count).toBe(5);
  });

  it('ages from the issue date when there is no due date', async () => {
    const c = await ctx();
    await newInvoice(c, { ref: 'NODUE', client: 'A', date: '2026-01-01', amount: '100.00', status: 'Sent' });
    const res = await call(app, 'GET', `/businesses/${c.businessId}/aging?asOf=2026-06-30`, {
      token: c.owner.token,
    });
    expect(res.body.buckets['90+']).toEqual({ count: 1, total: '100.00' });
  });

  it('returns all-zero buckets for a business with nothing outstanding', async () => {
    const c = await ctx();
    await newInvoice(c, { client: 'A', date: '2026-01-01', amount: '100.00', status: 'Paid' });
    const res = await call(app, 'GET', `/businesses/${c.businessId}/aging?asOf=2026-06-30`, {
      token: c.owner.token,
    });
    expect(res.body.total).toEqual({ count: 0, total: '0.00' });
    expect(res.body.buckets.current).toEqual({ count: 0, total: '0.00' });
  });

  it('does not mix in another business\'s receivables', async () => {
    const a = await ctx();
    const b = await ctx();
    await seedAging(a);
    const res = await call(app, 'GET', `/businesses/${b.businessId}/aging?asOf=2026-06-30`, {
      token: b.owner.token,
    });
    expect(res.body.total.count).toBe(0);
  });

  it('ties to the invoice list on an amount that rounds', async () => {
    const c = await ctx();
    const inv = await newInvoice(c, {
      client: 'A', date: '2026-01-01', due: '2026-01-31', amount: '1000.10', taxRate: 8.25, status: 'Sent',
    });
    expect(inv.total).toBe('1082.61'); // tax is 82.508…, rounded once
    const res = await call(app, 'GET', `/businesses/${c.businessId}/aging?asOf=2026-06-30`, {
      token: c.owner.token,
    });
    // The report must agree with the invoice to the cent, not merely to the dollar.
    expect(res.body.total.total).toBe('1082.61');
  });

  it('rejects a malformed asOf', async () => {
    const c = await ctx();
    const res = await call(app, 'GET', `/businesses/${c.businessId}/aging?asOf=yesterday`, {
      token: c.owner.token,
    });
    expect(res.status).toBe(400);
  });
});
