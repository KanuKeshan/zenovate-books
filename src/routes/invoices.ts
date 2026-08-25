import type { FastifyInstance } from 'fastify';
import type { QueryResult, QueryResultRow } from 'pg';
import { z } from 'zod';
import { authenticate } from '../app.js';
import { requireBusinessAccess, bumpVersion, isUuid } from '../lib/authz.js';
import { tx, getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';
import { parseMoney, toDecimal, fromDb, type Cents } from '../lib/money.js';

/**
 * Invoices, and the accounts-receivable aging built from the unpaid ones.
 *
 * Every query here is constrained by business_id as well as by the row's own id.
 * An invoice id is a UUID, but "hard to guess" is not an access control, and the
 * aging report is precisely the endpoint where one leaked row would be a whole
 * client's revenue.
 */

const MAX_LIMIT = 200;

/** The statuses the schema's CHECK constraint allows. */
const STATUSES = ['Paid', 'Sent', 'Pending', 'Overdue', 'Draft'] as const;
type Status = (typeof STATUSES)[number];

/**
 * What counts as accounts receivable.
 *
 * A draft has not been sent, so nobody owes it yet; counting drafts as AR
 * overstates what the business can expect to collect, which is the one number an
 * aging report exists to get right.
 */
const UNPAID: Status[] = ['Sent', 'Pending', 'Overdue'];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const money = z.union([z.number(), z.string().max(40)]);

const invoiceBody = z.object({
  ref: z.string().trim().min(1).max(120).optional(),
  client: z.string().trim().max(300).default(''),
  date: isoDate,
  due: isoDate.nullable().optional(),
  desc: z.string().max(2000).default(''),
  cat: z.string().max(120).default('Revenue'),
  amount: money,
  taxRate: z.coerce.number().min(0).max(100).default(0),
  status: z.enum(STATUSES).default('Pending'),
  version: z.union([z.string(), z.number()]).nullable().optional(),
}).strict();

const invoicePatch = z.object({
  ref: z.string().trim().min(1).max(120).optional(),
  client: z.string().trim().max(300).optional(),
  date: isoDate.optional(),
  due: isoDate.nullable().optional(),
  desc: z.string().max(2000).optional(),
  cat: z.string().max(120).optional(),
  amount: money.optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  status: z.enum(STATUSES).optional(),
  version: z.union([z.string(), z.number()]).nullable().optional(),
}).strict();

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  client: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  sort: z.enum(['date', 'dateAsc', 'ref', 'amount']).default('date'),
}).strict();

// Sort keys map to fixed SQL. Nothing a caller sends is ever interpolated.
const SORT_SQL: Record<'date' | 'dateAsc' | 'ref' | 'amount', string> = {
  date: 'i.issue_date DESC, i.ref DESC',
  dateAsc: 'i.issue_date ASC, i.ref ASC',
  ref: 'i.ref ASC',
  amount: 'i.amount DESC, i.ref ASC',
};

const agingQuery = z.object({ asOf: isoDate.optional() }).strict();

type InvoiceRow = {
  id: string;
  ref: string;
  client_name: string;
  client_id: string | null;
  issue_date: Date | string;
  due_date: Date | string | null;
  description: string;
  category: string;
  amount: string;
  tax_rate: string;
  status: Status;
  migrated: boolean;
  created_at: Date | string;
  updated_at: Date | string;
};

const COLS = `i.id, i.ref, i.client_name, i.client_id, i.issue_date, i.due_date, i.description,
              i.category, i.amount, i.tax_rate, i.status, i.migrated, i.created_at, i.updated_at`;

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);

/**
 * total = amount * (1 + taxRate/100), in integer cents.
 *
 * The rate has four decimal places, so it is scaled to an integer first and the
 * whole thing stays integer arithmetic: 8.25% of $1,000.10 has to be the same
 * number every time it is computed, and float multiplication does not promise
 * that.
 */
export function invoiceTotalCents(amountCents: Cents, taxRatePercent: number): Cents {
  const scaled = Math.round(taxRatePercent * 10_000);       // percent, 4 dp → integer
  const tax = Math.round((amountCents * scaled) / 1_000_000); // /100 for percent, /10_000 for scale
  return amountCents + tax;
}

function shape(r: InvoiceRow): Record<string, unknown> {
  const amount = fromDb(r.amount);
  const taxRate = Number(r.tax_rate);
  const total = invoiceTotalCents(amount, taxRate);
  return {
    id: r.id,
    ref: r.ref,
    client: r.client_name,
    clientId: r.client_id,
    date: iso(r.issue_date),
    due: iso(r.due_date),
    desc: r.description,
    cat: r.category,
    amount: toDecimal(amount),
    taxRate,
    tax: toDecimal(total - amount),
    total: toDecimal(total),
    status: r.status,
    migrated: r.migrated,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

async function loadInvoice(q: Queryable, businessId: string, invoiceId: string): Promise<InvoiceRow> {
  const { rows } = await q.query<InvoiceRow>(
    `SELECT ${COLS} FROM invoices i WHERE i.business_id=$1 AND i.id=$2`,
    [businessId, invoiceId],
  );
  const row = rows[0];
  if (!row) throw notFound('That invoice');
  return row;
}

/** Resolves the client row for a name, if one exists in THIS business. */
async function clientIdFor(q: Queryable, businessId: string, name: string): Promise<string | null> {
  if (!name) return null;
  const { rows } = await q.query<{ id: string }>(
    'SELECT id FROM clients WHERE business_id=$1 AND name=$2',
    [businessId, name],
  );
  return rows[0]?.id ?? null;
}

/** Next free INV-n for a business, so a caller need not invent references. */
async function nextRef(q: Queryable, businessId: string): Promise<string> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(ref, '^INV-', ''), '')::bigint), 0) AS n
       FROM invoices
      WHERE business_id=$1 AND ref ~ '^INV-[0-9]+$'`,
    [businessId],
  );
  return `INV-${Number(rows[0]?.n ?? 0) + 1}`;
}

function issues(err: z.ZodError): string {
  return err.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');
}

function amountCents(v: unknown): Cents {
  try {
    return parseMoney(v, 'amount');
  } catch (err) {
    throw badRequest(`That invoice amount was rejected: ${(err as Error).message}.`);
  }
}

export default async function invoicesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/businesses/:id/invoices', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('That invoice query was rejected: ' + issues(parsed.error));
    const q = parsed.data;
    if (q.from && q.to && q.from > q.to) throw badRequest('The "from" date is after the "to" date.');

    const where: string[] = ['i.business_id=$1'];
    const args: unknown[] = [businessId];
    if (q.status) { args.push(q.status); where.push(`i.status=$${args.length}`); }
    if (q.from) { args.push(q.from); where.push(`i.issue_date >= $${args.length}::date`); }
    if (q.to) { args.push(q.to); where.push(`i.issue_date <= $${args.length}::date`); }
    if (q.client) {
      args.push(q.client);
      // A uuid means the client row; anything else is the name as shown on the
      // invoice, matched case-insensitively because that is how people type it.
      where.push(isUuid(q.client)
        ? `i.client_id = $${args.length}::uuid`
        : `lower(i.client_name) = lower($${args.length})`);
    }
    args.push(q.limit, q.offset);

    const { rows } = await getPool().query<InvoiceRow & { full_count: number }>(
      `SELECT ${COLS}, count(*) OVER() AS full_count
         FROM invoices i
        WHERE ${where.join(' AND ')}
        ORDER BY ${SORT_SQL[q.sort]}
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    return {
      invoices: rows.map(shape),
      count: rows[0]?.full_count ?? 0,
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get('/businesses/:id/invoices/:invoiceId', async (req) => {
    const p = await authenticate(req);
    const { id, invoiceId } = z.object({ id: z.string(), invoiceId: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    if (!isUuid(invoiceId)) throw notFound('That invoice');
    return { invoice: shape(await loadInvoice(getPool(), businessId, invoiceId)) };
  });

  app.post('/businesses/:id/invoices', async (req, reply) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    const parsed = invoiceBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That invoice was rejected: ' + issues(parsed.error));
    const b = parsed.data;
    const cents = amountCents(b.amount);
    if (b.due && b.due < b.date) throw badRequest('The due date is before the issue date.');

    const created = await tx(async (c) => {
      const ref = b.ref ?? await nextRef(c, businessId);
      const clientId = await clientIdFor(c, businessId, b.client);
      let row: InvoiceRow;
      try {
        const { rows } = await c.query<InvoiceRow>(
          `INSERT INTO invoices (business_id,ref,client_name,client_id,issue_date,due_date,
                                 description,category,amount,tax_rate,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING ${COLS.replace(/i\./g, '')}`,
          [businessId, ref, b.client, clientId, b.date, b.due ?? null, b.desc, b.cat,
           toDecimal(cents), b.taxRate, b.status],
        );
        row = rows[0]!;
      } catch (err) {
        if ((err as { code?: string })?.code === '23505') {
          throw conflict(`An invoice numbered "${ref}" already exists in this business.`);
        }
        throw err;
      }
      await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'invoice.create', entity: 'invoice', entityId: row.id,
        detail: { ref, client: b.client, amount: toDecimal(cents), status: b.status },
        ip: req.ip, requestId: String(req.id),
      }, c);
      return row;
    });

    reply.status(201);
    return { invoice: shape(created) };
  });

  app.patch('/businesses/:id/invoices/:invoiceId', async (req) => {
    const p = await authenticate(req);
    const { id, invoiceId } = z.object({ id: z.string(), invoiceId: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    if (!isUuid(invoiceId)) throw notFound('That invoice');
    const parsed = invoicePatch.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That invoice change was rejected: ' + issues(parsed.error));
    const b = parsed.data;

    const updated = await tx(async (c) => {
      const before = await loadInvoice(c, businessId, invoiceId);
      const next = {
        ref: b.ref ?? before.ref,
        client: b.client ?? before.client_name,
        date: b.date ?? iso(before.issue_date)!,
        due: b.due === undefined ? iso(before.due_date) : b.due,
        desc: b.desc ?? before.description,
        cat: b.cat ?? before.category,
        amount: b.amount === undefined ? fromDb(before.amount) : amountCents(b.amount),
        taxRate: b.taxRate ?? Number(before.tax_rate),
        status: b.status ?? before.status,
      };
      if (next.due && next.due < next.date) throw badRequest('The due date is before the issue date.');
      const clientId = b.client === undefined
        ? before.client_id
        : await clientIdFor(c, businessId, next.client);

      let row: InvoiceRow;
      try {
        const { rows } = await c.query<InvoiceRow>(
          `UPDATE invoices
              SET ref=$3, client_name=$4, client_id=$5, issue_date=$6, due_date=$7,
                  description=$8, category=$9, amount=$10, tax_rate=$11, status=$12, updated_at=now()
            WHERE business_id=$1 AND id=$2
            RETURNING ${COLS.replace(/i\./g, '')}`,
          [businessId, invoiceId, next.ref, next.client, clientId, next.date, next.due ?? null,
           next.desc, next.cat, toDecimal(next.amount), next.taxRate, next.status],
        );
        row = rows[0]!;
      } catch (err) {
        if ((err as { code?: string })?.code === '23505') {
          throw conflict(`An invoice numbered "${next.ref}" already exists in this business.`);
        }
        throw err;
      }
      await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'invoice.update', entity: 'invoice', entityId: invoiceId,
        detail: { ref: next.ref, status: next.status, amount: toDecimal(next.amount) },
        ip: req.ip, requestId: String(req.id),
      }, c);
      return row;
    });

    return { invoice: shape(updated) };
  });

  app.delete('/businesses/:id/invoices/:invoiceId', async (req) => {
    const p = await authenticate(req);
    const { id, invoiceId } = z.object({ id: z.string(), invoiceId: z.string() }).parse(req.params);
    // Destructive: owner only.
    const { businessId } = await requireBusinessAccess(p, id, 'owner');
    if (!isUuid(invoiceId)) throw notFound('That invoice');
    const parsed = z.object({ version: z.union([z.string(), z.number()]).nullable().optional() })
      .strict().safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That delete was malformed.');

    await tx(async (c) => {
      const before = await loadInvoice(c, businessId, invoiceId);
      await c.query('DELETE FROM invoices WHERE business_id=$1 AND id=$2', [businessId, invoiceId]);
      await bumpVersion(c, businessId, parsed.data.version == null ? null : String(parsed.data.version));
      await audit({
        userId: p.userId, businessId, action: 'invoice.delete', entity: 'invoice', entityId: invoiceId,
        detail: { ref: before.ref, client: before.client_name, amount: toDecimal(fromDb(before.amount)) },
        ip: req.ip, requestId: String(req.id),
      }, c);
    });

    return { ok: true };
  });

  /**
   * AR aging.
   *
   * Age runs from the due date where there is one and the issue date where there
   * is not — an invoice with no terms is due on issue, and treating it as
   * ageless is how a year-old receivable sits in "current" forever.
   *
   * The bucket sums are NUMERIC throughout, rounded to cents per invoice exactly
   * as invoiceTotalCents rounds, so the report ties to the invoice list rather
   * than being out by a rounding rule nobody wrote down.
   */
  app.get('/businesses/:id/aging', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    const parsed = agingQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('That aging query was rejected: ' + issues(parsed.error));

    const { rows } = await getPool().query<{ bucket: string; n: number; total: string }>(
      `WITH aged AS (
         SELECT CASE
                  WHEN ($2::date - COALESCE(i.due_date, i.issue_date)) <= 0  THEN 'current'
                  WHEN ($2::date - COALESCE(i.due_date, i.issue_date)) <= 30 THEN '1-30'
                  WHEN ($2::date - COALESCE(i.due_date, i.issue_date)) <= 60 THEN '31-60'
                  WHEN ($2::date - COALESCE(i.due_date, i.issue_date)) <= 90 THEN '61-90'
                  ELSE '90+'
                END AS bucket,
                round(i.amount * (1 + i.tax_rate / 100), 2) AS total
           FROM invoices i
          WHERE i.business_id = $1
            AND i.status = ANY($3::text[])
       )
       SELECT bucket, count(*)::bigint AS n, COALESCE(sum(total), 0)::text AS total
         FROM aged GROUP BY bucket`,
      [businessId, parsed.data.asOf ?? new Date().toISOString().slice(0, 10), UNPAID],
    );

    const buckets: Record<string, { count: number; total: string }> = {
      current: { count: 0, total: '0.00' },
      '1-30': { count: 0, total: '0.00' },
      '31-60': { count: 0, total: '0.00' },
      '61-90': { count: 0, total: '0.00' },
      '90+': { count: 0, total: '0.00' },
    };
    let allCents = 0;
    let allCount = 0;
    for (const r of rows) {
      const cents = fromDb(r.total);
      buckets[r.bucket] = { count: Number(r.n), total: toDecimal(cents) };
      allCents += cents;
      allCount += Number(r.n);
    }

    return {
      asOf: parsed.data.asOf ?? new Date().toISOString().slice(0, 10),
      statuses: UNPAID,
      buckets,
      total: { count: allCount, total: toDecimal(allCents) },
    };
  });
}
