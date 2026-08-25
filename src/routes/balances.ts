import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../app.js';
import { requireBusinessAccess, bumpVersion } from '../lib/authz.js';
import { tx, getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parseMoney, toDecimal, fromDb, type Cents } from '../lib/money.js';

/**
 * Opening balances and the balance sheet built on top of them.
 *
 * The arithmetic here mirrors the front end's computeBalanceSheet exactly,
 * because the two have to agree to the cent or the person reading them has no
 * way to tell which one is lying. Every figure is integer cents in memory and a
 * decimal string on the wire; nothing is ever a float.
 *
 * Why the sheet balances, in one paragraph: a journal entry's debits equal its
 * credits, so the assets it moves equal the liabilities plus equity plus income
 * minus expenses it moves, and income-minus-expense lands in Retained Earnings.
 * An invoice's total sits in Cash when paid and in AR when not, and in Retained
 * Earnings either way. An expense leaves Cash and reduces Retained Earnings. The
 * opening balance's cash and AR are assets, its AP a liability, and the
 * difference between them is the Opening Balance Equity plug. Add it up and
 * Assets = Liabilities + Equity, which the tests assert on a worked set.
 */

const MAX_ACCOUNTS = 200;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const money = z.union([z.number(), z.string().max(40)]);

const openingBody = z.object({
  date: isoDate,
  cash: money.nullable().optional(),
  ar: money.nullable().optional(),
  ap: money.nullable().optional(),
  version: z.union([z.string(), z.number()]).nullable().optional(),
}).strict();

const asOfQuery = z.object({ asOf: isoDate.optional() }).strict();

/** The three accounts the sheet computes itself; everything else is journal-driven. */
const CASH = 'Cash';
const AR = 'Accounts Receivable';
const AP = 'Accounts Payable';
const OWNERS_EQUITY = "Owner's Equity";

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);

function issues(err: z.ZodError): string {
  return err.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');
}

function amountCents(v: unknown, field: string): Cents {
  try {
    return parseMoney(v, field);
  } catch (err) {
    throw badRequest(`That opening balance was rejected: ${(err as Error).message}.`);
  }
}

type OpeningRow = { as_of: Date | string; cash: string; ar: string; ap: string; set_at: Date | string };

function shapeOpening(r: OpeningRow): Record<string, unknown> {
  return {
    date: iso(r.as_of),
    cash: toDecimal(fromDb(r.cash)),
    ar: toDecimal(fromDb(r.ar)),
    ap: toDecimal(fromDb(r.ap)),
    setAt: r.set_at instanceof Date ? r.set_at.toISOString() : String(r.set_at),
  };
}

async function loadOpening(businessId: string): Promise<OpeningRow | null> {
  const { rows } = await getPool().query<OpeningRow>(
    'SELECT as_of, cash, ar, ap, set_at FROM opening_balances WHERE business_id=$1',
    [businessId],
  );
  return rows[0] ?? null;
}

export default async function balancesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/businesses/:id/opening-balance', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    const row = await loadOpening(businessId);
    return { openingBalance: row ? shapeOpening(row) : null };
  });

  /**
   * One opening balance per business, so this is an upsert rather than a create.
   * A second cutover date is not a second opening balance, it is a correction of
   * the first, and modelling it as an insert would leave two snapshots both
   * claiming to be the start of the books.
   */
  app.put('/businesses/:id/opening-balance', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    const parsed = openingBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That opening balance was rejected: ' + issues(parsed.error));
    const b = parsed.data;
    const cash = amountCents(b.cash ?? 0, 'opening cash');
    const ar = amountCents(b.ar ?? 0, 'opening ar');
    const ap = amountCents(b.ap ?? 0, 'opening ap');

    const saved = await tx(async (c) => {
      const { rows } = await c.query<OpeningRow>(
        `INSERT INTO opening_balances (business_id,as_of,cash,ar,ap,set_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (business_id) DO UPDATE
            SET as_of=EXCLUDED.as_of, cash=EXCLUDED.cash, ar=EXCLUDED.ar, ap=EXCLUDED.ap,
                set_by=EXCLUDED.set_by, set_at=now()
         RETURNING as_of, cash, ar, ap, set_at`,
        [businessId, b.date, toDecimal(cash), toDecimal(ar), toDecimal(ap), p.userId],
      );
      await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'openingBalance.save', entity: 'opening_balance',
        entityId: businessId,
        detail: { date: b.date, cash: toDecimal(cash), ar: toDecimal(ar), ap: toDecimal(ap) },
        ip: req.ip, requestId: String(req.id),
      }, c);
      return rows[0]!;
    });

    return { openingBalance: shapeOpening(saved) };
  });

  app.delete('/businesses/:id/opening-balance', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    // Destructive: clearing the cutover moves Cash, AR, AP and the equity plug.
    const { businessId } = await requireBusinessAccess(p, id, 'owner');
    const parsed = z.object({ version: z.union([z.string(), z.number()]).nullable().optional() })
      .strict().safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That delete was malformed.');

    await tx(async (c) => {
      const { rows } = await c.query<{ as_of: Date | string; cash: string; ar: string; ap: string }>(
        'DELETE FROM opening_balances WHERE business_id=$1 RETURNING as_of, cash, ar, ap',
        [businessId],
      );
      const before = rows[0];
      if (!before) throw notFound('That opening balance');
      await bumpVersion(c, businessId, parsed.data.version == null ? null : String(parsed.data.version));
      await audit({
        userId: p.userId, businessId, action: 'openingBalance.delete', entity: 'opening_balance',
        entityId: businessId,
        detail: { date: iso(before.as_of), cash: toDecimal(fromDb(before.cash)),
                  ar: toDecimal(fromDb(before.ar)), ap: toDecimal(fromDb(before.ap)) },
        ip: req.ip, requestId: String(req.id),
      }, c);
    });

    return { ok: true };
  });

  /**
   * The balance sheet, as of a date or as of everything.
   *
   * Aggregation happens in Postgres so a business with twenty thousand invoices
   * does not stream twenty thousand rows into this process to be added up; the
   * per-invoice tax rounding is done in SQL exactly as the aging report does it,
   * so the two reports tie to the cent.
   */
  app.get('/businesses/:id/balance-sheet', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    const parsed = asOfQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('That balance sheet query was rejected: ' + issues(parsed.error));
    const asOf = parsed.data.asOf ?? null;

    const pool = getPool();
    const [opening, invoices, expenses, journal, accounts] = await Promise.all([
      pool.query<{ cash: string; ar: string; ap: string }>(
        `SELECT cash, ar, ap FROM opening_balances
          WHERE business_id=$1 AND ($2::date IS NULL OR as_of <= $2::date)`,
        [businessId, asOf],
      ),
      // Paid against unpaid. "Unpaid" is everything that is not Paid, drafts
      // included: the draft's total is in Retained Earnings via all-invoice
      // income, so leaving it out of AR would put the sheet out by its amount.
      pool.query<{ paid: boolean; total: string }>(
        `SELECT (i.status = 'Paid') AS paid,
                COALESCE(sum(round(i.amount * (1 + i.tax_rate / 100), 2)), 0)::text AS total
           FROM invoices i
          WHERE i.business_id=$1 AND ($2::date IS NULL OR i.issue_date <= $2::date)
          GROUP BY 1`,
        [businessId, asOf],
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(sum(e.amount), 0)::text AS total
           FROM expenses e
          WHERE e.business_id=$1 AND ($2::date IS NULL OR e.spend_date <= $2::date)`,
        [businessId, asOf],
      ),
      pool.query<{ kind: string; account: string; debit: string; credit: string }>(
        `SELECT jl.kind, jl.account,
                COALESCE(sum(jl.debit), 0)::text AS debit,
                COALESCE(sum(jl.credit), 0)::text AS credit
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
          WHERE je.business_id=$1 AND ($2::date IS NULL OR je.entry_date <= $2::date)
          GROUP BY jl.kind, jl.account`,
        [businessId, asOf],
      ),
      pool.query<{ kind: string; name: string }>(
        `SELECT kind, name FROM categories
          WHERE business_id=$1 AND kind IN ('asset','liability','equity')
          ORDER BY kind, sort, name
          LIMIT $2`,
        [businessId, MAX_ACCOUNTS],
      ),
    ]);

    const ob = opening.rows[0];
    const obCash = ob ? fromDb(ob.cash) : 0;
    const obAr = ob ? fromDb(ob.ar) : 0;
    const obAp = ob ? fromDb(ob.ap) : 0;

    let paidInvoices = 0;
    let unpaidInvoices = 0;
    for (const r of invoices.rows) {
      if (r.paid) paidInvoices += fromDb(r.total);
      else unpaidInvoices += fromDb(r.total);
    }
    const allInvoices = paidInvoices + unpaidInvoices;
    const allExpenses = fromDb(expenses.rows[0]?.total);

    // A journal balance is the account's normal side: debit-positive for assets
    // and expenses, credit-positive for everything else.
    const balances = new Map<string, Cents>();
    let journalIncome = 0;
    let journalExpense = 0;
    for (const r of journal.rows) {
      const debit = fromDb(r.debit);
      const credit = fromDb(r.credit);
      const normal = r.kind === 'asset' || r.kind === 'expense' ? debit - credit : credit - debit;
      balances.set(`${r.kind}|||${r.account}`, (balances.get(`${r.kind}|||${r.account}`) ?? 0) + normal);
      if (r.kind === 'income') journalIncome += normal;
      if (r.kind === 'expense') journalExpense += normal;
    }
    const je = (kind: string, account: string): Cents => balances.get(`${kind}|||${account}`) ?? 0;

    const cash = obCash + paidInvoices - allExpenses + je('asset', CASH);
    const ar = unpaidInvoices + obAr + je('asset', AR);
    const ap = obAp + je('liability', AP);
    const ownersEquity = je('equity', OWNERS_EQUITY);
    const retainedEarnings = (allInvoices - allExpenses) + (journalIncome - journalExpense);
    // The plug is what keeps the pre-cutover position from landing nowhere: the
    // opening cash and AR are assets and the opening AP a liability, so the
    // difference has to sit in equity or the sheet is out by exactly that much.
    const openingBalanceEquity = ob ? obCash + obAr - obAp : 0;

    // Named accounts come from the chart of accounts for this business, so a
    // journal line typed against an account nobody defined does not silently
    // invent a balance-sheet row.
    const named = (kind: 'asset' | 'liability' | 'equity', exclude: string[]) =>
      accounts.rows
        .filter((a) => a.kind === kind && !exclude.includes(a.name))
        .map((a) => ({ name: a.name, amount: je(kind, a.name) }));

    const otherAssets = named('asset', [CASH, AR]);
    const otherLiabilities = named('liability', [AP]);
    const otherEquity = named('equity', [OWNERS_EQUITY]);

    const totalAssets = cash + ar + otherAssets.reduce((s, a) => s + a.amount, 0);
    const totalLiabilities = ap + otherLiabilities.reduce((s, a) => s + a.amount, 0);
    const totalEquity = ownersEquity + retainedEarnings + openingBalanceEquity
      + otherEquity.reduce((s, a) => s + a.amount, 0);
    const difference = totalAssets - (totalLiabilities + totalEquity);

    const named$ = (rows: { name: string; amount: Cents }[]) =>
      rows.map((r) => ({ name: r.name, amount: toDecimal(r.amount) }));

    return {
      asOf,
      assets: {
        cash: toDecimal(cash),
        accountsReceivable: toDecimal(ar),
        other: named$(otherAssets),
        total: toDecimal(totalAssets),
      },
      liabilities: {
        accountsPayable: toDecimal(ap),
        other: named$(otherLiabilities),
        total: toDecimal(totalLiabilities),
      },
      equity: {
        ownersEquity: toDecimal(ownersEquity),
        retainedEarnings: toDecimal(retainedEarnings),
        openingBalanceEquity: toDecimal(openingBalanceEquity),
        other: named$(otherEquity),
        total: toDecimal(totalEquity),
      },
      // Stated rather than assumed. When it is false the books need a human, and
      // a report that quietly hides that is worse than no report.
      balanced: difference === 0,
      difference: toDecimal(difference),
    };
  });
}
