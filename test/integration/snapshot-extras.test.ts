import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import snapshotRoutes from '../../src/routes/snapshot.js';
import businessesRoutes from '../../src/routes/businesses.js';
import { setupDb, teardown, makeUser, makeFirm, makeBusiness, call } from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.register(snapshotRoutes);
  await app.register(businessesRoutes);
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

describe('bank rows keep their account and posting details', () => {
  it('round-trips accountId, balance-sheet posting fields and transfer flags', async () => {
    const owner = await makeUser();
    const firmId = await makeFirm(owner);
    const businessId = await makeBusiness(firmId, { user: owner, role: 'owner' });
    const put = await call(app, 'PUT', `/businesses/${businessId}/snapshot`, {
      token: owner.token,
      body: {
        bankTxns: [
          { date: '2026-10-01', desc: 'Visa payment', debit: 500, credit: 0, balance: 1500, cat: 'Credit card payment',
            matched: 'matched', accountId: 'acct-checking', transfer: true, selected: true },
          { date: '2026-10-01', desc: 'Visa payment', debit: 0, credit: 500, balance: null, cat: 'Credit card payment',
            matched: 'matched', accountId: 'acct-card', transfer: true },
          { date: '2026-10-02', desc: 'Loan draw', debit: 0, credit: 2000, balance: 3500, cat: 'Loan Payable', matched: 'matched',
            postedToBS: true, bsKind: 'liability', bsAccount: 'Loan Payable', postedJeId: 'JE-1', accountId: 'acct-checking' },
        ],
      },
    });
    expect(put.status).toBe(200);
    const body = (await call(app, 'GET', `/businesses/${businessId}/snapshot`, { token: owner.token })).body;
    expect(body.bankTxns).toHaveLength(3);
    const byAcct = (id: string) => body.bankTxns.filter((t: any) => t.accountId === id);
    expect(byAcct('acct-checking')).toHaveLength(2);
    expect(byAcct('acct-card')[0].credit).toBe(500);
    const draw = body.bankTxns.find((t: any) => t.desc === 'Loan draw');
    expect(draw.postedToBS).toBe(true);
    expect(draw.bsAccount).toBe('Loan Payable');
    expect(draw.postedJeId).toBe('JE-1');
    expect(body.bankTxns.filter((t: any) => t.transfer)).toHaveLength(2);
    expect(body.bankTxns.some((t: any) => 'selected' in t)).toBe(false);
  });
});

describe('accounting basis', () => {
  it('is stored per business, defaults to unset, and round-trips through both routes', async () => {
    const owner = await makeUser();
    const created = await call(app, 'POST', '/businesses', { token: owner.token, body: { name: 'Cash Co', accountingBasis: 'cash' } });
    expect(created.status).toBe(201);
    expect(created.body.accountingBasis).toBe('cash');

    const unset = await call(app, 'POST', '/businesses', { token: owner.token, body: { name: 'Legacy Co' } });
    expect(unset.body.accountingBasis).toBeNull();

    // the workspace list the front end reads
    const meta = (await call(app, 'GET', '/workspace/meta', { token: owner.token })).body.businesses;
    expect(meta.find((b: any) => b.name === 'Cash Co').accountingBasis).toBe('cash');
    expect(meta.find((b: any) => b.name === 'Legacy Co').accountingBasis).toBeNull();

    // choosing a basis later, via the same call the Edit Business dialog makes
    const id = unset.body.id as string;
    const put = await call(app, 'PUT', '/workspace/meta', {
      token: owner.token,
      body: { businesses: [{ id, name: 'Legacy Co', accountingBasis: 'accrual' }] },
    });
    expect(put.status).toBe(200);
    const after = (await call(app, 'GET', '/workspace/meta', { token: owner.token })).body.businesses;
    expect(after.find((b: any) => b.id === id).accountingBasis).toBe('accrual');

    // a basis that is not cash/accrual is refused
    const bad = await call(app, 'POST', '/businesses', { token: owner.token, body: { name: 'Bad Co', accountingBasis: 'modified' } });
    expect(bad.status).toBe(400);
  });
});

describe('overlapping saves', () => {
  it('several saves of the same business at once all succeed and leave one consistent copy', async () => {
    const owner = await makeUser();
    const firmId = await makeFirm(owner);
    const businessId = await makeBusiness(firmId, { user: owner, role: 'owner' });
    const body = {
      invoices: Array.from({ length: 40 }, (_, i) => ({
        id: 'INV-' + (i + 1), client: 'Acme', date: '2026-10-01', due: '2026-10-31', desc: 'Work',
        cat: 'Revenue', amount: 100 + i, taxRate: 0, status: 'Pending',
      })),
      bankTxns: Array.from({ length: 40 }, (_, i) => ({ date: '2026-10-02', desc: 'Row ' + i, debit: 5 + i, credit: 0, cat: 'Other' })),
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => call(app, 'PUT', '/businesses/' + businessId + '/snapshot', { token: owner.token, body })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const got = (await call(app, 'GET', '/businesses/' + businessId + '/snapshot', { token: owner.token })).body;
    expect(got.invoices).toHaveLength(40);
    expect(got.bankTxns).toHaveLength(40);
  });
});
