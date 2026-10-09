import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import snapshotRoutes from '../../src/routes/snapshot.js';
import { setupDb, teardown, makeUser, makeFirm, makeBusiness, call } from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.register(snapshotRoutes);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await teardown();
});

describe('snapshot keeps fields that have no column of their own', () => {
  it('round-trips invoice and expense extras, and never lets them overwrite real columns', async () => {
    const owner = await makeUser();
    const firmId = await makeFirm(owner);
    const businessId = await makeBusiness(firmId, { user: owner, role: 'owner' });

    const lines = [
      { desc: 'Design work', qty: 2, rate: 150, amount: 300 },
      { desc: 'Hosting', qty: 1, rate: 50, amount: 50 },
    ];
    const payment = { include: true, bankName: 'Test Bank', accountNumber: '000123' };
    const put = await call(app, 'PUT', `/businesses/${businessId}/snapshot`, {
      token: owner.token,
      body: {
        invoices: [{
          id: 'INV-1', client: 'Acme', date: '2026-10-01', due: '2026-10-31', desc: 'Design work + 1 more',
          cat: 'Revenue', amount: 350, taxRate: 0, status: 'Pending',
          email: 'billing@acme.test', lines, payment, fromBank: true, bankFingerprint: '2026-10-01|350.00|acme',
          // A hostile or buggy payload must not be able to shadow a real column via extra:
          extra: { status: 'Paid' },
        }],
        expenses: [{
          date: '2026-10-02', vendor: 'Landlord', desc: 'Rent', cat: 'Rent', amount: 1000,
          bankFingerprint: '2026-10-02|1000.00|rent', accountId: 'acct-1',
        }],
      },
    });
    expect(put.status).toBe(200);

    const got = await call(app, 'GET', `/businesses/${businessId}/snapshot`, { token: owner.token });
    expect(got.status).toBe(200);
    const body = got.body;
    const inv = body.invoices[0];
    expect(inv.lines).toEqual(lines);
    expect(inv.payment).toEqual(payment);
    expect(inv.email).toBe('billing@acme.test');
    expect(inv.fromBank).toBe(true);
    expect(inv.bankFingerprint).toBe('2026-10-01|350.00|acme');
    expect(inv.status).toBe('Pending');
    expect(inv.amount).toBe(350);
    expect(body.expenses[0].bankFingerprint).toBe('2026-10-02|1000.00|rent');
    expect(body.expenses[0].accountId).toBe('acct-1');
    expect(body.expenses[0].amount).toBe(1000);
  });
});
