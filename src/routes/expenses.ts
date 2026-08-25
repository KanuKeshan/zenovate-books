import type { FastifyInstance } from 'fastify';
import type { QueryResult, QueryResultRow } from 'pg';
import { z } from 'zod';
import { authenticate } from '../app.js';
import { requireBusinessAccess, bumpVersion, isUuid } from '../lib/authz.js';
import { tx, getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parseMoney, toDecimal, fromDb, type Cents } from '../lib/money.js';

/**
 * Expenses, and the profit-and-loss built from them alongside the invoices.
 *
 * Every statement here is constrained by business_id as well as by the row's own
 * id. An expense id is a UUID, but "hard to guess" is not an access control, and
 * the P&L is exactly the endpoint where one leaked row is another firm's margin.
 */

const MAX_LIMIT = 200;

/**
 * What counts as revenue on the P&L.
 *
 * A draft has not been sent and a pending one has not been agreed, so neither is
 * income anybody can stand behind. Paid and Sent are what the business has
 * actually billed, which is the number this report exists to state.
 */
const REVENUE_STATUSES = ['Paid', 'Sent'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const money = z.union([z.number(), z.string().max(40)]);
const versionIn = z.union([z.string(), z.number()]).nullable().optional();

const expenseBody = z.object({
  date: isoDate,
  vendor: z.string().trim().max(300).default(''),
  desc: z.string().max(2000).default(''),
  cat: z.string().trim().max(120).default('Other'),
  amount: money,
  deductible: z.boolean().default(true),
  hasReceipt: z.boolean().default(false),
  receiptKey: z.string().max(1024).nullable().optional(),
  version: versionIn,
}).strict();

const expensePatch = z.object({
  date: isoDate.optional(),
  vendor: z.string().trim().max(300).optional(),
  desc: z.string().max(2000).optional(),
  cat: z.string().trim().max(120).optional(),
  amount: money.optional(),
  deductible: z.boolean().optional(),
  hasReceipt: z.boolean().optional(),
  receiptKey: z.string().max(1024).nullable().optional(),
  version: versionIn,
}).strict();

const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: z.string().max(120).optional(),
  vendor: z.string().max(300).optional(),
  deductible: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  sort: z.enum(['date', 'dateAsc', 'amount', 'vendor']).default('date'),
}).strict();

// Sort keys map to fixed SQL. Nothing a caller sends is ever interpolated.
const SORT_SQL: Record<'date' | 'dateAsc' | 'amount' | 'vendor', string> = {
  date: 'e.spend_date DESC, e.created_at DESC, e.id DESC',
  dateAsc: 'e.spend_date ASC, e.created_at ASC, e.id ASC',
  amount: 'e.amount DESC, e.spend_date DESC, e.id DESC',
  vendor: 'lower(e.vendor) ASC, e.spend_date DESC, e.id DESC',
};

const plQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() }).strict();

type ExpenseRow = {
  id: string;
  spend_date: Date | string;
  vendor: string;
  description: string;
  category: string;
  amount: string;
  deductible: boolean;
  has_receipt: boolean;
  receipt_key: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const COLS = `e.id, e.spend_date, e.vendor, e.description, e.category, e.amount,
              e.deductible, e.has_receipt, e.receipt_key, e.created_at, e.updated_at`;

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);

function shape(r: ExpenseRow): Record<string, unknown> {
  return {
    id: r.id,
    date: iso(r.spend_date),
    vendor: r.vendor,
    desc: r.description,
    cat: r.category,
    amount: toDecimal(fromDb(r.amount)),
    deductible: r.deductible,
    hasReceipt: r.has_receipt,
    receiptKey: r.receipt_key,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

async function loadExpense(q: Queryable, businessId: string, expenseId: string): Promise<ExpenseRow> {
  const { rows } = await q.query<ExpenseRow>(
    `SELECT ${COLS} FROM expenses e WHERE e.business_id=$1 AND e.id=$2`,
    [businessId, expenseId],
  );
  const row = rows[0];
  if (!row) throw notFound('That expense');
  return row;
}

function issues(err: z.ZodError): string {
  return err.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');
}

function amountCents(v: unknown): Cents {
  try {
    return parseMoney(v, 'amount');
  } catch (err) {
    throw badRequest(`That expense amount was rejected: ${(err as Error).message}.`);
  }
}

export default async function expensesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/businesses/:id/expenses', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('That expense query was rejected: ' + issues(parsed.error));
    const q = parsed.data;
    if (q.from && q.to && q.from > q.to) throw badRequest('The "from" date is after the "to" date.');

    const where: string[] = ['e.business_id=$1'];
    const args: unknown[] = [businessId];
    if (q.from) { args.push(q.from); where.push(`e.spend_date >= $${args.length}::date`); }
    if (q.to) { args.push(q.to); where.push(`e.spend_date <= $${args.length}::date`); }
    // Category and vendor are matched case-insensitively: they are typed by hand
    // on one screen and picked from a list on another, and "AWS" and "aws" are
    // the same supplier to everyone except a case-sensitive comparison.
    if (q.category) { args.push(q.category); where.push(`lower(e.category) = lower($${args.length})`); }
    if (q.vendor) { args.push(q.vendor); where.push(`lower(e.vendor) = lower($${args.length})`); }
    if (q.deductible) { args.push(q.deductible === 'true'); where.push(`e.deductible = $${args.length}`); }
    args.push(q.limit, q.offset);

    const { rows } = await getPool().query<ExpenseRow & { full_count: number }>(
      `SELECT ${COLS}, count(*) OVER() AS full_count
         FROM expenses e
        WHERE ${where.join(' AND ')}
        ORDER BY ${SORT_SQL[q.sort]}
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );

    // The page total is what the rows on screen add up to; the filtered total is
    // what the filter selected. Showing only the first is how someone reads a
    // 50-row page as if it were the year.
    const pageCents = rows.reduce((a, r) => a + fromDb(r.amount), 0);

    return {
      expenses: rows.map(shape),
      count: rows[0]?.full_count ?? 0,
      limit: q.limit,
      offset: q.offset,
      pageTotal: toDecimal(pageCents),
    };
  });

  app.get('/businesses/:id/expenses/:expenseId', async (req) => {
    const p = await authenticate(req);
    const { id, expenseId } = z.object({ id: z.string(), expenseId: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    if (!isUuid(expenseId)) throw notFound('That expense');
    return { expense: shape(await loadExpense(getPool(), businessId, expenseId)) };
  });

  app.post('/businesses/:id/expenses', async (req, reply) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    const parsed = expenseBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That expense was rejected: ' + issues(parsed.error));
    const b = parsed.data;
    const cents = amountCents(b.amount);

    const created = await tx(async (c) => {
      const { rows } = await c.query<ExpenseRow>(
        `INSERT INTO expenses (business_id,spend_date,vendor,description,category,amount,
                               deductible,has_receipt,receipt_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING ${COLS.replace(/e\./g, '')}`,
        [businessId, b.date, b.vendor, b.desc, b.cat, toDecimal(cents),
         b.deductible, b.hasReceipt, b.receiptKey ?? null],
      );
      const row = rows[0]!;
      await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'expense.create', entity: 'expense', entityId: row.id,
        detail: { date: b.date, vendor: b.vendor, category: b.cat, amount: toDecimal(cents) },
        ip: req.ip, requestId: String(req.id),
      }, c);
      return row;
    });

    reply.status(201);
    return { expense: shape(created) };
  });

  app.patch('/businesses/:id/expenses/:expenseId', async (req) => {
    const p = await authenticate(req);
    const { id, expenseId } = z.object({ id: z.string(), expenseId: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    if (!isUuid(expenseId)) throw notFound('That expense');
    const parsed = expensePatch.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That expense change was rejected: ' + issues(parsed.error));
    const b = parsed.data;

    const updated = await tx(async (c) => {
      const before = await loadExpense(c, businessId, expenseId);
      const next = {
        date: b.date ?? iso(before.spend_date)!,
        vendor: b.vendor ?? before.vendor,
        desc: b.desc ?? before.description,
        cat: b.cat ?? before.category,
        amount: b.amount === undefined ? fromDb(before.amount) : amountCents(b.amount),
        deductible: b.deductible ?? before.deductible,
        hasReceipt: b.hasReceipt ?? before.has_receipt,
        receiptKey: b.receiptKey === undefined ? before.receipt_key : b.receiptKey,
      };
      const { rows } = await c.query<ExpenseRow>(
        `UPDATE expenses
            SET spend_date=$3, vendor=$4, description=$5, category=$6, amount=$7,
                deductible=$8, has_receipt=$9, receipt_key=$10, updated_at=now()
          WHERE business_id=$1 AND id=$2
          RETURNING ${COLS.replace(/e\./g, '')}`,
        [businessId, expenseId, next.date, next.vendor, next.desc, next.cat,
         toDecimal(next.amount), next.deductible, next.hasReceipt, next.receiptKey],
      );
      const row = rows[0]!;
      await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'expense.update', entity: 'expense', entityId: expenseId,
        detail: { date: next.date, vendor: next.vendor, category: next.cat, amount: toDecimal(next.amount) },
        ip: req.ip, requestId: String(req.id),
      }, c);
      return row;
    });

    return { expense: shape(updated) };
  });

  app.delete('/businesses/:id/expenses/:expenseId', async (req) => {
    const p = await authenticate(req);
    const { id, expenseId } = z.object({ id: z.string(), expenseId: z.string() }).parse(req.params);
    // Destructive: owner only.
    const { businessId } = await requireBusinessAccess(p, id, 'owner');
    if (!isUuid(expenseId)) throw notFound('That expense');
    const parsed = z.object({ version: versionIn }).strict().safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That delete was malformed.');

    await tx(async (c) => {
      const before = await loadExpense(c, businessId, expenseId);
      await c.query('DELETE FROM expenses WHERE business_id=$1 AND id=$2', [businessId, expenseId]);
      await bumpVersion(c, businessId, parsed.data.version == null ? null : String(parsed.data.version));
      await audit({
        userId: p.userId, businessId, action: 'expense.delete', entity: 'expense', entityId: expenseId,
        detail: { date: iso(before.spend_date), vendor: before.vendor, category: before.category,
                  amount: toDecimal(fromDb(before.amount)) },
        ip: req.ip, requestId: String(req.id),
      }, c);
    });

    return { ok: true };
  });

  /**
   * Profit and loss for a date range.
   *
   * Revenue is the invoiced amount excluding tax: sales tax collected on behalf
   * of a revenue authority is a liability the business is holding, and counting
   * it as income overstates the profit the owner is about to be taxed on.
   *
   * Both sides are summed in Postgres as NUMERIC and only then converted, so the
   * figures tie to the invoice and expense lists rather than drifting by a
   * rounding rule that lives in JavaScript and nowhere else.
   */
  app.get('/businesses/:id/pl', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    const parsed = plQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('That P&L query was rejected: ' + issues(parsed.error));
    const { from = null, to = null } = parsed.data;
    if (from && to && from > to) throw badRequest('The "from" date is after the "to" date.');

    const [rev, exp] = await Promise.all([
      getPool().query<{ category: string; n: number; total: string }>(
        `SELECT i.category AS category, count(*)::bigint AS n, COALESCE(sum(i.amount),0)::text AS total
           FROM invoices i
          WHERE i.business_id = $1
            AND i.status = ANY($4::text[])
            AND ($2::date IS NULL OR i.issue_date >= $2::date)
            AND ($3::date IS NULL OR i.issue_date <= $3::date)
          GROUP BY i.category
          ORDER BY i.category`,
        [businessId, from, to, REVENUE_STATUSES as unknown as string[]],
      ),
      getPool().query<{ category: string; n: number; total: string }>(
        `SELECT e.category AS category, count(*)::bigint AS n, COALESCE(sum(e.amount),0)::text AS total
           FROM expenses e
          WHERE e.business_id = $1
            AND ($2::date IS NULL OR e.spend_date >= $2::date)
            AND ($3::date IS NULL OR e.spend_date <= $3::date)
          GROUP BY e.category
          ORDER BY e.category`,
        [businessId, from, to],
      ),
    ]);

    const group = (rows: { category: string; n: number; total: string }[]) => {
      let total = 0;
      let count = 0;
      const byCategory = rows.map((r) => {
        const cents = fromDb(r.total);
        total += cents;
        count += Number(r.n);
        return { category: r.category, count: Number(r.n), total: toDecimal(cents) };
      });
      return { cents: total, out: { total: toDecimal(total), count, byCategory } };
    };

    const revenue = group(rev.rows);
    const expenses = group(exp.rows);

    return {
      from,
      to,
      revenueStatuses: REVENUE_STATUSES,
      revenue: revenue.out,
      expenses: expenses.out,
      net: toDecimal(revenue.cents - expenses.cents),
    };
  });
}
