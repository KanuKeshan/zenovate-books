import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import snapshotRoutes from '../../src/routes/snapshot.js';
import emailRoutes from '../../src/routes/email.js';
import { getPool } from '../../src/db/pool.js';
import { setupDb, teardown, makeUser, makeFirm, makeBusiness, call, type TestUser } from '../helpers.js';

let app: FastifyInstance;
let owner: TestUser;
let businessId: string;

beforeAll(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.register(snapshotRoutes);
  await app.register(emailRoutes);
  await app.ready();

  owner = await makeUser();
  const firmId = await makeFirm(owner);
  businessId = await makeBusiness(firmId, { user: owner, role: 'owner' });
  await getPool().query(`UPDATE businesses SET name='Corner <Market>', email='billing@corner.test' WHERE id=$1`, [businessId]);
  const put = await call(app, 'PUT', `/businesses/${businessId}/snapshot`, {
    token: owner.token,
    body: {
      invoices: [{
        id: 'INV-1', client: 'Acme <script>alert(1)</script>', date: '2026-10-01', due: '2026-10-31', desc: 'Two things + 1 more',
        cat: 'Revenue', amount: 350, taxRate: 10, status: 'Pending',
        lines: [{ desc: 'Design work', qty: 2, rate: 150, amount: 300 }, { desc: 'Hosting', qty: 1, rate: 50, amount: 50 }],
        payment: { include: true, bankName: 'Test Bank', accountNumber: '000123' },
      }],
    },
  });
  expect(put.status).toBe(200);
});
afterAll(async () => {
  await app.close();
  await teardown();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['RESEND_API_KEY'];
  delete process.env['EMAIL_FROM'];
});

function configure() {
  process.env['RESEND_API_KEY'] = 're_test_key';
  process.env['EMAIL_FROM'] = 'Invoices <invoices@sender.test>';
}
const send = (token: string, body: unknown) =>
  call(app, 'POST', `/businesses/${businessId}/invoices/send`, { token, body });

describe('emailing an invoice', () => {
  it('answers 501 until an email service is configured, so the app can fall back', async () => {
    const res = await send(owner.token, { invoiceRef: 'INV-1', to: 'customer@example.test' });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('email_not_configured');
  });

  it('builds the message from the stored invoice, escapes it, and sends it', async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const res = await send(owner.token, { invoiceRef: 'INV-1', to: 'customer@example.test', message: 'Thanks <b>so</b> much' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.authorization).toBe('Bearer re_test_key');
    const sent = JSON.parse(init.body);
    expect(sent.to).toEqual(['customer@example.test']);
    expect(sent.from).toBe('Invoices <invoices@sender.test>');
    expect(sent.reply_to).toBe('billing@corner.test');
    expect(sent.subject).toBe('Invoice INV-1 from Corner <Market>');
    // line items, totals (350 + 10% tax = 385) and payment details come from storage
    expect(sent.html).toContain('Design work');
    expect(sent.html).toContain('$385.00');
    expect(sent.html).toContain('Test Bank');
    expect(sent.text).toContain('TOTAL DUE: 385.00');
    // nothing user-controlled reaches the HTML unescaped
    expect(sent.html).toContain('Corner &lt;Market&gt;');
    expect(sent.html).toContain('Thanks &lt;b&gt;so&lt;/b&gt; much');
    expect(sent.html).not.toContain('<b>so</b>');
    expect(sent.html).not.toContain('<script>');

    // without a custom message the greeting uses the customer's name, escaped too
    const second = await send(owner.token, { invoiceRef: 'INV-1', to: 'customer@example.test' });
    expect(second.status).toBe(200);
    const greeting = JSON.parse(fetchMock.mock.calls[1]![1].body).html as string;
    expect(greeting).toContain('Hi Acme &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(greeting).not.toContain('<script>');
    // the key never appears in what goes to the customer
    expect(sent.html).not.toContain('re_test_key');
  });

  it('refuses read-only members, strangers, bad addresses and unknown invoices', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }));

    const viewer = await makeUser();
    await getPool().query(`INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'readonly')`, [businessId, viewer.userId]);
    expect((await send(viewer.token, { invoiceRef: 'INV-1', to: 'a@b.test' })).status).toBe(403);

    const stranger = await makeUser();
    expect((await send(stranger.token, { invoiceRef: 'INV-1', to: 'a@b.test' })).status).toBe(404);

    expect((await send(owner.token, { invoiceRef: 'INV-1', to: 'not-an-email' })).status).toBe(400);
    expect((await send(owner.token, { invoiceRef: 'NOPE', to: 'a@b.test' })).status).toBe(404);
    // arbitrary HTML from the caller is not accepted at all
    expect((await send(owner.token, { invoiceRef: 'INV-1', to: 'a@b.test', html: '<p>phish</p>' })).status).toBe(400);
  });

  it('reports a provider failure without leaking the key or provider detail', async () => {
    configure();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'domain not verified re_test_key' }));
    const res = await send(owner.token, { invoiceRef: 'INV-1', to: 'customer@example.test' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('re_test_key');
    expect(JSON.stringify(res.body)).not.toContain('domain not verified');
  });
});
