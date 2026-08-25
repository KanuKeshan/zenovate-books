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
 * Bank transactions, and the statement importer.
 *
 * Every statement here is constrained by business_id as well as by the row's own
 * id. A transaction id is a UUID, but "hard to guess" is not an access control,
 * and a bank feed is the one table where a single leaked row is another firm's
 * cash position.
 *
 * Re-importing a statement is the normal case, not the exception: a bookkeeper
 * exports overlapping date ranges, or the same file twice, and the books must not
 * double. Dedupe is therefore a database constraint on a fingerprint computed the
 * same way everywhere, not a check the importer might forget to run.
 */

const MAX_LIMIT = 200;
const MAX_IMPORT = 10_000;

/** Rows per INSERT on import: 5 placeholders each, comfortably inside the 65535 cap. */
const IMPORT_BATCH = 500;

/** How many `#n` variants a deliberate duplicate may claim before we give up. */
const MAX_KEY_VARIANTS = 200;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const money = z.union([z.number(), z.string().max(40)]);
const versionIn = z.union([z.string(), z.number()]).nullable().optional();

/**
 * Stable fingerprint for a bank row.
 *
 * Uniqueness is (business_id, dedupe_key) in the schema, so the business is part
 * of the fingerprint by construction and one firm's statement can never collide
 * with another's. The description is case- and whitespace-normalised because the
 * same transaction comes back from a CSV export and an OFX download spelled
 * differently, and a fingerprint that treats those as two rows dedupes nothing.
 * Identical to the one snapshot.ts uses, so the two write paths agree.
 */
export function dedupeKey(date: string, amountCents: Cents, desc: string): string {
  return [date, amountCents, desc.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120)].join('|');
}

const txnBody = z.object({
  date: isoDate,
  desc: z.string().max(2000).optional(),
  description: z.string().max(2000).optional(),
  amount: money,
  balance: money.nullable().optional(),
  cat: z.string().trim().max(120).nullable().optional(),
  matched: z.boolean().default(false),
  posted: z.boolean().default(false),
  source: z.string().max(300).default(''),
  version: versionIn,
}).strict();

const txnPatch = z.object({
  date: isoDate.optional(),
  desc: z.string().max(2000).optional(),
  description: z.string().max(2000).optional(),
  amount: money.optional(),
  balance: money.nullable().optional(),
  cat: z.string().trim().max(120).nullable().optional(),
  matched: z.boolean().optional(),
  posted: z.boolean().optional(),
  source: z.string().max(300).optional(),
  version: versionIn,
}).strict();

const importBody = z.object({
  transactions: z.array(z.object({
    date: isoDate,
    // The spec's field is `description`; `desc` is accepted because that is what
    // the front end calls it everywhere else and a 400 over a synonym is a bug
    // report, not a validation.
    description: z.string().max(2000).optional(),
    desc: z.string().max(2000).optional(),
    amount: money,
    balance: money.nullable().optional(),
  }).strict()).max(MAX_IMPORT),
  source: z.string().max(300).default(''),
  version: versionIn,
}).strict();

const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  category: z.string().max(120).optional(),
  q: z.string().max(300).optional(),
  matched: z.enum(['true', 'false']).optional(),
  posted: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  sort: z.enum(['date', 'dateAsc', 'amount', 'created']).default('date'),
}).strict();

// Sort keys map to fixed SQL. Nothing a caller sends is ever interpolated.
const SORT_SQL: Record<'date' | 'dateAsc' | 'amount' | 'created', string> = {
  date: 't.txn_date DESC, t.created_at DESC, t.id DESC',
  dateAsc: 't.txn_date ASC, t.created_at ASC, t.id ASC',
  amount: 't.amount DESC, t.txn_date DESC, t.id DESC',
  created: 't.created_at DESC, t.id DESC',
};

type TxnRow = {
  id: string;
  txn_date: Date | string;
  description: string;
  amount: string;
  balance: string | null;
  category: string | null;
  matched: boolean;
  posted: boolean;
  source: string;
  dedupe_key: string;
  created_at: Date | string;
};

const COLS = `t.id, t.txn_date, t.description, t.amount, t.balance, t.category,
              t.matched, t.posted, t.source, t.dedupe_key, t.created_at`;
const BARE_COLS = COLS.replace(/t\./g, '');

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);

function shape(r: TxnRow): Record<string, unknown> {
  return {
    id: r.id,
    date: iso(r.txn_date),
    desc: r.description,
    amount: toDecimal(fromDb(r.amount)),
    balance: r.balance == null ? null : toDecimal(fromDb(r.balance)),
    cat: r.category,
    matched: r.matched,
    posted: r.posted,
    source: r.source,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

async function loadTxn(q: Queryable, businessId: string, txnId: string): Promise<TxnRow> {
  const { rows } = await q.query<TxnRow>(
    `SELECT ${COLS} FROM bank_txns t WHERE t.business_id=$1 AND t.id=$2`,
    [businessId, txnId],
  );
  const row = rows[0];
  if (!row) throw notFound('That bank transaction');
  return row;
}

function issues(err: z.ZodError): string {
  return err.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');
}

function cents(v: unknown, field: string): Cents {
  try {
    return parseMoney(v, field);
  } catch (err) {
    throw badRequest(`That bank ${field} was rejected: ${(err as Error).message}.`);
  }
}

/**
 * The first unused variant of a fingerprint, ignoring one row (itself, on edit).
 *
 * A statement genuinely can hold two identical rows on the same day — two £4.20
 * coffees — and a deliberate single entry must not be silently swallowed by the
 * dedupe that exists for re-imports. So a hand-created row that collides takes
 * `key#2`, leaving the base key owned by the first row, which is the one the
 * importer will keep matching against.
 */
async function freeKey(q: Queryable, businessId: string, base: string, excludeId?: string): Promise<string> {
  for (let n = 1; n <= MAX_KEY_VARIANTS; n++) {
    const key = n === 1 ? base : `${base}#${n}`;
    const { rows } = await q.query(
      `SELECT 1 FROM bank_txns
        WHERE business_id=$1 AND dedupe_key=$2 AND ($3::uuid IS NULL OR id <> $3::uuid)
        LIMIT 1`,
      [businessId, key, excludeId ?? null],
    );
    if (!rows[0]) return key;
  }
  throw conflict('That transaction already appears too many times on this account.');
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === '23505';
}

export default async function bankRoutes(app: FastifyInstance): Promise<void> {
  app.get('/businesses/:id/bank', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('That bank query was rejected: ' + issues(parsed.error));
    const q = parsed.data;
    if (q.from && q.to && q.from > q.to) throw badRequest('The "from" date is after the "to" date.');

    const where: string[] = ['t.business_id=$1'];
    const args: unknown[] = [businessId];
    if (q.from) { args.push(q.from); where.push(`t.txn_date >= $${args.length}::date`); }
    if (q.to) { args.push(q.to); where.push(`t.txn_date <= $${args.length}::date`); }
    if (q.category) { args.push(q.category); where.push(`lower(t.category) = lower($${args.length})`); }
    // Substring match by position() rather than LIKE: no pattern to escape, so a
    // description containing % or _ searches for itself and nothing else.
    if (q.q) { args.push(q.q); where.push(`position(lower($${args.length}) in lower(t.description)) > 0`); }
    if (q.matched) { args.push(q.matched === 'true'); where.push(`t.matched = $${args.length}`); }
    if (q.posted) { args.push(q.posted === 'true'); where.push(`t.posted = $${args.length}`); }
    args.push(q.limit, q.offset);

    const { rows } = await getPool().query<TxnRow & { full_count: number }>(
      `SELECT ${COLS}, count(*) OVER() AS full_count
         FROM bank_txns t
        WHERE ${where.join(' AND ')}
        ORDER BY ${SORT_SQL[q.sort]}
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );

    // The page total is what the rows on screen add up to. It is deliberately not
    // called a balance: a page of a filtered feed is not the account.
    const pageCents = rows.reduce((a, r) => a + fromDb(r.amount), 0);

    return {
      transactions: rows.map(shape),
      count: rows[0]?.full_count ?? 0,
      limit: q.limit,
      offset: q.offset,
      pageTotal: toDecimal(pageCents),
    };
  });

  app.get('/businesses/:id/bank/:txnId', async (req) => {
    const p = await authenticate(req);
    const { id, txnId } = z.object({ id: z.string(), txnId: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    if (!isUuid(txnId)) throw notFound('That bank transaction');
    return { transaction: shape(await loadTxn(getPool(), businessId, txnId)) };
  });

  app.post('/businesses/:id/bank', async (req, reply) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    const parsed = txnBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That bank transaction was rejected: ' + issues(parsed.error));
    const b = parsed.data;
    const desc = b.desc ?? b.description ?? '';
    const amount = cents(b.amount, 'amount');
    const balance = b.balance == null ? null : cents(b.balance, 'balance');

    const created = await tx(async (c) => {
      const key = await freeKey(c, businessId, dedupeKey(b.date, amount, desc));
      const { rows } = await c.query<TxnRow>(
        `INSERT INTO bank_txns (business_id,txn_date,description,amount,balance,category,
                                matched,posted,source,dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING ${BARE_COLS}`,
        [businessId, b.date, desc, toDecimal(amount), balance == null ? null : toDecimal(balance),
         b.cat ?? null, b.matched, b.posted, b.source, key],
      );
      const row = rows[0]!;
      await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'bank.create', entity: 'bank_txn', entityId: row.id,
        detail: { date: b.date, amount: toDecimal(amount), description: desc },
        ip: req.ip, requestId: String(req.id),
      }, c);
      return row;
    });

    reply.status(201);
    return { transaction: shape(created) };
  });

  app.patch('/businesses/:id/bank/:txnId', async (req) => {
    const p = await authenticate(req);
    const { id, txnId } = z.object({ id: z.string(), txnId: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    if (!isUuid(txnId)) throw notFound('That bank transaction');
    const parsed = txnPatch.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That bank change was rejected: ' + issues(parsed.error));
    const b = parsed.data;

    try {
      const updated = await tx(async (c) => {
        const before = await loadTxn(c, businessId, txnId);
        const next = {
          date: b.date ?? iso(before.txn_date)!,
          desc: b.desc ?? b.description ?? before.description,
          amount: b.amount === undefined ? fromDb(before.amount) : cents(b.amount, 'amount'),
          balance: b.balance === undefined
            ? (before.balance == null ? null : fromDb(before.balance))
            : (b.balance == null ? null : cents(b.balance, 'balance')),
          cat: b.cat === undefined ? before.category : b.cat,
          matched: b.matched ?? before.matched,
          posted: b.posted ?? before.posted,
          source: b.source ?? before.source,
        };
        // The fingerprint follows the row: edit the date, amount or description
        // and a later import of the ORIGINAL line must come back as new, because
        // it is no longer the row that is sitting in the ledger.
        const base = dedupeKey(next.date, next.amount, next.desc);
        const key = before.dedupe_key === base ? base : await freeKey(c, businessId, base, txnId);
        const { rows } = await c.query<TxnRow>(
          `UPDATE bank_txns
              SET txn_date=$3, description=$4, amount=$5, balance=$6, category=$7,
                  matched=$8, posted=$9, source=$10, dedupe_key=$11
            WHERE business_id=$1 AND id=$2
            RETURNING ${BARE_COLS}`,
          [businessId, txnId, next.date, next.desc, toDecimal(next.amount),
           next.balance == null ? null : toDecimal(next.balance), next.cat,
           next.matched, next.posted, next.source, key],
        );
        const row = rows[0]!;
        await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
        await audit({
          userId: p.userId, businessId, action: 'bank.update', entity: 'bank_txn', entityId: txnId,
          detail: { date: next.date, amount: toDecimal(next.amount), description: next.desc,
                    matched: next.matched, posted: next.posted },
          ip: req.ip, requestId: String(req.id),
        }, c);
        return row;
      });
      return { transaction: shape(updated) };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('Another bank transaction on this account already matches that date, amount and description.');
      }
      throw err;
    }
  });

  app.delete('/businesses/:id/bank/:txnId', async (req) => {
    const p = await authenticate(req);
    const { id, txnId } = z.object({ id: z.string(), txnId: z.string() }).parse(req.params);
    // Destructive: owner only.
    const { businessId } = await requireBusinessAccess(p, id, 'owner');
    if (!isUuid(txnId)) throw notFound('That bank transaction');
    const parsed = z.object({ version: versionIn }).strict().safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That delete was malformed.');

    await tx(async (c) => {
      const before = await loadTxn(c, businessId, txnId);
      await c.query('DELETE FROM bank_txns WHERE business_id=$1 AND id=$2', [businessId, txnId]);
      await bumpVersion(c, businessId, parsed.data.version == null ? null : String(parsed.data.version));
      await audit({
        userId: p.userId, businessId, action: 'bank.delete', entity: 'bank_txn', entityId: txnId,
        detail: { date: iso(before.txn_date), amount: toDecimal(fromDb(before.amount)),
                  description: before.description },
        ip: req.ip, requestId: String(req.id),
      }, c);
    });

    return { ok: true };
  });

  /**
   * Statement import.
   *
   * Idempotent by fingerprint: posting the same statement twice imports the rows
   * once. The skip is done by the unique index rather than by a pre-read, so two
   * imports racing each other cannot both decide a row is new. Rows repeated
   * WITHIN one payload collapse the same way — the same ON CONFLICT sees the row
   * its own transaction just inserted — which is what a statement with a
   * duplicated page should do.
   *
   * The whole import is one transaction: a file that fails halfway leaves the
   * books as they were, so the fix is to re-post the file rather than to work out
   * which half landed.
   */
  app.post('/businesses/:id/bank/import', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    const parsed = importBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That import was rejected: ' + issues(parsed.error));
    const b = parsed.data;

    // Parse every row before writing any of it: one unreadable amount rejects the
    // file rather than importing the rows either side of it and leaving a gap
    // nobody notices until the account does not reconcile.
    const rows = b.transactions.map((t, i) => {
      const desc = t.description ?? t.desc ?? '';
      const amount = cents(t.amount, `transactions[${i}].amount`);
      return {
        date: t.date,
        desc,
        amount,
        balance: t.balance == null ? null : cents(t.balance, `transactions[${i}].balance`),
        key: dedupeKey(t.date, amount, desc),
      };
    });

    if (rows.length === 0) return { imported: 0, skipped: 0, total: 0 };

    const out = await tx(async (c) => {
      let imported = 0;
      // Written in batches rather than row at a time: a year of statements is
      // tens of thousands of lines, and one round trip each turns an import into
      // a progress bar. The placeholders are generated from the row count, never
      // from anything the caller sent.
      for (let i = 0; i < rows.length; i += IMPORT_BATCH) {
        const batch = rows.slice(i, i + IMPORT_BATCH);
        const args: unknown[] = [businessId, b.source];
        const values = batch.map((r) => {
          args.push(r.date, r.desc, toDecimal(r.amount), r.balance == null ? null : toDecimal(r.balance), r.key);
          const n = args.length;
          return `($1,$${n - 4}::date,$${n - 3},$${n - 2}::numeric,$${n - 1}::numeric,NULL,false,false,$2,$${n})`;
        });
        const res = await c.query(
          `INSERT INTO bank_txns (business_id,txn_date,description,amount,balance,category,
                                  matched,posted,source,dedupe_key)
           VALUES ${values.join(',')}
           ON CONFLICT (business_id,dedupe_key) DO NOTHING
           RETURNING id`,
          args,
        );
        imported += res.rowCount ?? 0;
      }
      const skipped = rows.length - imported;
      const version = await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'bank.import', entity: 'bank_txn', entityId: null,
        detail: { imported, skipped, total: rows.length, source: b.source },
        ip: req.ip, requestId: String(req.id),
      }, c);
      return { imported, skipped, total: rows.length, version };
    });

    return out;
  });
}
