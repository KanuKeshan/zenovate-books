/**
 * The functional gate: a real browser, driving the real single-file UI, against
 * the real API, against real PostgreSQL.
 *
 * Everything below this is unit and integration work that can pass while the
 * product is broken. This is the test that fails when the thing a person
 * actually does stops working.
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:8099';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const near = (a, b, m, tol = 0.01) => ok(a != null && Math.abs(a - b) <= tol, `${m} (want ${b}, got ${a})`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  // The isolation probes deliberately provoke 401s and 404s; those are the
  // assertion passing, not a fault. SVG NaN warnings come from charts drawn
  // before data lands and are tracked separately.
  const t = m.text();
  if (m.type() === 'error' && !/ERR_TUNNEL|pdf\.js|cdnjs|favicon|status of (401|404)|attribute \w+: Expected length/.test(t)) errors.push('CONSOLE: ' + t);
});

try {
  console.log('\n── the app loads from the API origin and knows it is online ──');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const adapter = await page.evaluate(() => ({
    configured: window.CB_FIREBASE?.configured,
    mode: window.CB_FIREBASE?.mode,
    hasSignIn: typeof window.CB_FIREBASE?.signIn === 'function',
    hasGetDoc: typeof window.CB_FIREBASE?.getDoc === 'function',
  }));
  ok(adapter.configured === true, 'the adapter detected the API and switched itself on');
  ok(adapter.mode === 'dev', 'it reports dev auth mode (Cognito is not reachable from here)');
  ok(adapter.hasSignIn && adapter.hasGetDoc, 'it exposes the surface the 11,000 lines below already call');

  console.log('\n── signing in ──');
  const signedIn = await page.evaluate(async () => {
    const u = await window.CB_FIREBASE.signIn('k@example.test', 'ignored-in-dev-mode');
    return { email: u?.email, uid: !!u?.uid };
  });
  ok(signedIn.email === 'k@example.test', 'sign-in returns the signed-in identity');
  ok(signedIn.uid, 'and a stable user id');

  console.log('\n── an authenticated round trip through the real database ──');
  const created = await page.evaluate(async () => {
    await window.CB_FIREBASE.setDoc('workspaces/w/meta/main', {
      businesses: [{ id: 'local-1', name: 'E2E Clinic', type: 'Service-based', currency: '$', color: '#534AB7' }],
    });
    const meta = await window.CB_FIREBASE.getDoc('workspaces/w/meta/main');
    return meta;
  });
  ok(Array.isArray(created?.businesses) && created.businesses.length === 1, 'the business was created server-side and read back');
  const serverId = created.businesses[0].id;
  ok(/^[0-9a-f-]{36}$/i.test(serverId), 'it came back with a real server-issued id, not the local one');
  ok(created.businesses[0].role === 'owner', 'the creator is the owner');

  console.log('\n── a full set of books saved and reloaded ──');
  const roundTrip = await page.evaluate(async (id) => {
    const blob = {
      invoices: [
        { id: 'INV-1', client: 'Acme', date: '2026-01-10', due: '2026-02-10', desc: 'Consulting', cat: 'Revenue', amount: 12000, taxRate: 0, status: 'Paid' },
        { id: 'INV-2', client: 'Acme', date: '2026-02-10', due: '2026-03-10', desc: 'Consulting', cat: 'Revenue', amount: 8000.55, taxRate: 0, status: 'Sent' },
      ],
      expenses: [
        { date: '2026-01-15', vendor: 'Landlord', desc: 'Rent', cat: 'Rent', amount: 2000, deductible: true },
        { date: '2026-02-15', vendor: 'Landlord', desc: 'Rent', cat: 'Rent', amount: 2000, deductible: true },
      ],
      clients: [{ name: 'Acme', email: 'a@acme.test', phone: '', address: '', taxRate: 0 }],
      categories: { asset: ['Cash', 'Accounts Receivable', 'Equipment'], liability: ['Accounts Payable'], equity: ["Owner's Equity"], income: ['Revenue'], expense: ['Rent'] },
      journalEntries: [
        { id: 'JE-1', date: '2026-01-01', type: 'Opening', memo: 'kit', lines: [
          { kind: 'asset', account: 'Equipment', debit: 5000, credit: 0 },
          { kind: 'equity', account: "Owner's Equity", debit: 0, credit: 5000 },
        ] },
      ],
      // No running balance: with one present the app treats it as ground truth
      // for cash, and a fixture whose bank balance disagrees with its own
      // ledger would be testing the arithmetic of a contradiction.
      bankTxns: [{ date: '2026-01-10', desc: 'ACME PAYMENT', amount: 12000 }],
      openingBalance: { date: '2025-12-31', cash: 500, ar: 0, ap: 0 },
      // A deferred feature's state, which must survive untouched.
      payroll: { employees: [{ id: 'e1', name: 'Someone', active: true }], runs: [] },
      fpaSettings: { cogsCategories: ['Rent'] },
    };
    await window.CB_FIREBASE.setDoc('workspaces/w/businesses/' + id, blob);
    return await window.CB_FIREBASE.getDoc('workspaces/w/businesses/' + id);
  }, serverId);

  ok(roundTrip.invoices?.length === 2, 'both invoices came back');
  near(roundTrip.invoices?.find((i) => i.id === 'INV-2')?.amount, 8000.55, 'the awkward cents survived the round trip exactly');
  ok(roundTrip.expenses?.length === 2, 'both expenses came back');
  ok(roundTrip.clients?.[0]?.email === 'a@acme.test', 'the client came back');
  ok(roundTrip.journalEntries?.[0]?.lines?.length === 2, 'the journal entry kept both of its lines');
  ok(roundTrip.bankTxns?.length === 1, 'the bank transaction came back');
  near(roundTrip.openingBalance?.cash, 500, 'the opening balance came back');
  ok(roundTrip.payroll?.employees?.[0]?.name === 'Someone', 'PAYROLL — a deferred feature — round-tripped untouched');
  ok(Array.isArray(roundTrip.fpaSettings?.cogsCategories), 'and so did the FP&A settings');

  console.log('\n── the app reloads and finds its books on the server, not in the browser ──');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const afterReload = await page.evaluate(async () => {
    const stillIn = !!(window.CB_FIREBASE && (await window.CB_FIREBASE.getDoc('workspaces/w/meta/main')));
    const meta = await window.CB_FIREBASE.getDoc('workspaces/w/meta/main');
    return { stillIn, count: meta?.businesses?.length ?? 0, name: meta?.businesses?.[0]?.name };
  });
  ok(afterReload.stillIn, 'the session survived a reload via the httpOnly refresh cookie');
  ok(afterReload.count === 1 && afterReload.name === 'E2E Clinic',
     'and the books came back from the database with localStorage wiped');

  console.log('\n── the accounting still computes correctly through the real UI ──');
  const bs = await page.evaluate(async (id) => {
    await openBusiness(id);
    const b = computeBalanceSheet('2026-12-31');
    return { cash: b.cash, ar: b.ar, ta: b.totalAssets, tl: b.totalLiabilities, te: b.totalEquity,
             balanced: Math.abs(b.totalAssets - (b.totalLiabilities + b.totalEquity)) < 0.01,
             invoices: S.invoices.length, expenses: S.expenses.length };
  }, serverId);
  ok(bs.invoices === 2 && bs.expenses === 2, 'the UI loaded the server data into its own state');
  near(bs.ar, 8000.55, 'accounts receivable is the unpaid invoice');
  ok(bs.balanced, `the balance sheet balances (assets ${bs.ta} = liabilities ${bs.tl} + equity ${bs.te})`);

  console.log('\n── pages still render ──');
  const thin = await page.evaluate(() => {
    const pages = ['dashboard','invoices','expenses','ledger','journal','pl','balancesheet','clients',
                   'categories','bank','migrate','aging','cashflow','fpa','tax'];
    const out = [];
    for (const pg of pages) {
      const el = document.querySelector(`.nav-item[onclick*="nav('${pg}'"]`);
      try { nav(pg, el); } catch (e) { out.push(pg + ':threw'); continue; }
      const node = document.getElementById('page-' + pg);
      const len = node ? node.innerText.trim().length : -1;
      if (len < 40) out.push(pg + ':' + len);
    }
    return out;
  });
  ok(thin.length === 0, 'every page renders content' + (thin.length ? ' — thin: ' + thin.join(', ') : ''));

  console.log('\n── a second user cannot see the first user\'s books ──');
  const isolation = await page.evaluate(async () => {
    await window.CB_FIREBASE.signOut().catch(() => {});
    await window.CB_FIREBASE.signIn('stranger@example.test', 'x');
    const meta = await window.CB_FIREBASE.getDoc('workspaces/w/meta/main');
    return { count: meta?.businesses?.length ?? 0 };
  });
  ok(isolation.count === 0, 'a different signed-in user sees zero businesses');

  const stranger = await page.evaluate(async (id) => {
    try {
      const doc = await window.CB_FIREBASE.getDoc('workspaces/w/businesses/' + id);
      // getDoc maps a 404 to null, so null is a refusal, not a leak. Anything
      // with actual books in it is the breach.
      if (doc && (doc.invoices?.length || doc.clients?.length)) return 'LEAKED:' + JSON.stringify(doc).slice(0, 120);
      return doc === null ? 'refused' : 'empty-doc';
    } catch (e) { return 'refused-' + e.status; }
  }, serverId);
  ok(stranger.startsWith('refused'), `a direct fetch of another user's business is refused (${stranger})`);
} catch (e) {
  fail++;
  console.log('  ✗ FATAL: ' + (e?.stack ?? e));
}

console.log('\n' + pass + ' passing, ' + fail + ' failing');
if (errors.length) { console.log('BROWSER ERRORS:\n  ' + errors.join('\n  ')); }
await browser.close();
process.exit(fail || errors.length ? 1 : 0);
