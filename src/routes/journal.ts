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
 * The double-entry journal.
 *
 * Two rules are enforced here rather than left to the caller, because an
 * accounting system that accepts a bad entry has already lost: an entry's
 * debits must equal its credits, and a single line is one side or the other.
 * The schema carries the same CHECK on the line, but a constraint violation
 * surfaces as a 500 with a Postgres sentence in the log; a person pasting a
 * trial balance needs to be told which line, and by how much it is out.
 *
 * Every read and write is constrained by business_id as well as by the entry's
 * own id. An entry id is a UUID, but "hard to guess" is not access control, and
 * a journal is the one place where every number in the books is visible at once.
 */

const MAX_LIMIT = 200;
const MAX_LINES = 500;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const money = z.union([z.number(), z.string().max(40)]);

const KINDS = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
type Kind = (typeof KINDS)[number];

const lineBody = z.object({
  kind: z.enum(KINDS),
  account: z.string().trim().min(1).max(200),
  debit: money.nullable().optional(),
  credit: money.nullable().optional(),
}).strict();

const entryBody = z.object({
  ref: z.string().trim().min(1).max(120).optional(),
  date: isoDate,
  type: z.string().trim().max(60).default('Manual'),
  memo: z.string().max(2000).default(''),
  lines: z.array(lineBody).min(2).max(MAX_LINES),
  version: z.union([z.string(), z.number()]).nullable().optional(),
}).strict();

const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  type: z.string().max(60).optional(),
  account: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  sort: z.enum(['date', 'dateAsc', 'ref']).default('date'),
}).strict();

// Sort keys map to fixed SQL. Nothing a caller sends is ever interpolated.
const SORT_SQL: Record<'date' | 'dateAsc' | 'ref', string> = {
  date: 'je.entry_date DESC, je.ref DESC',
  dateAsc: 'je.entry_date ASC, je.ref ASC',
  ref: 'je.ref ASC',
};

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

type EntryRow = {
  id: string;
  ref: string;
  entry_date: Date | string;
  entry_type: string;
  memo: string;
  created_at: Date | string;
};

type LineRow = {
  entry_id: string;
  line_no: number;
  kind: Kind;
  account: string;
  debit: string;
  credit: string;
};

const ENTRY_COLS = 'je.id, je.ref, je.entry_date, je.entry_type, je.memo, je.created_at';

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    : String(d).slice(0, 10);

function issues(err: z.ZodError): string {
  return err.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');
}

function shape(e: EntryRow, lines: LineRow[]): Record<string, unknown> {
  let debits = 0;
  let credits = 0;
  const out = lines.map((l) => {
    const d = fromDb(l.debit);
    const c = fromDb(l.credit);
    debits += d;
    credits += c;
    return { lineNo: l.line_no, kind: l.kind, account: l.account, debit: toDecimal(d), credit: toDecimal(c) };
  });
  return {
    id: e.id,
    ref: e.ref,
    date: iso(e.entry_date),
    type: e.entry_type,
    memo: e.memo,
    createdAt: e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at),
    lines: out,
    debits: toDecimal(debits),
    credits: toDecimal(credits),
  };
}

/** Loads the lines for a set of entries, constrained by the business as well. */
async function linesFor(q: Queryable, businessId: string, entryIds: string[]): Promise<Map<string, LineRow[]>> {
  const byEntry = new Map<string, LineRow[]>();
  if (entryIds.length === 0) return byEntry;
  const { rows } = await q.query<LineRow>(
    `SELECT jl.entry_id, jl.line_no, jl.kind, jl.account, jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
      WHERE je.business_id = $1 AND jl.entry_id = ANY($2::uuid[])
      ORDER BY jl.entry_id, jl.line_no`,
    [businessId, entryIds],
  );
  for (const r of rows) {
    const arr = byEntry.get(r.entry_id) ?? [];
    arr.push(r);
    byEntry.set(r.entry_id, arr);
  }
  return byEntry;
}

async function loadEntry(q: Queryable, businessId: string, entryId: string): Promise<EntryRow> {
  const { rows } = await q.query<EntryRow>(
    `SELECT ${ENTRY_COLS} FROM journal_entries je WHERE je.business_id=$1 AND je.id=$2`,
    [businessId, entryId],
  );
  const row = rows[0];
  if (!row) throw notFound('That journal entry');
  return row;
}

/** Next free JE-n for a business, so a caller need not invent references. */
async function nextRef(q: Queryable, businessId: string): Promise<string> {
  const { rows } = await q.query<{ n: number }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(ref, '^JE-', ''), '')::bigint), 0) AS n
       FROM journal_entries
      WHERE business_id=$1 AND ref ~ '^JE-[0-9]+$'`,
    [businessId],
  );
  return `JE-${Number(rows[0]?.n ?? 0) + 1}`;
}

function amountCents(v: unknown, field: string, lineNo: number): Cents {
  let cents: Cents;
  try {
    cents = parseMoney(v, field);
  } catch (err) {
    throw badRequest(`Line ${lineNo + 1}: ${(err as Error).message}.`);
  }
  if (cents < 0) throw badRequest(`Line ${lineNo + 1}: a ${field} cannot be negative — use the other side instead.`);
  return cents;
}

/**
 * Turns the submitted lines into storable ones, refusing anything that is not a
 * genuine double entry.
 */
export function prepareLines(
  lines: z.infer<typeof lineBody>[],
): { kind: Kind; account: string; debit: Cents; credit: Cents }[] {
  const prepared = lines.map((l, i) => {
    const debit = l.debit == null ? 0 : amountCents(l.debit, 'debit', i);
    const credit = l.credit == null ? 0 : amountCents(l.credit, 'credit', i);
    // One side or the other. A line carrying both balances on paper and means
    // nothing in the ledger, and a line carrying neither is not an entry at all.
    if (debit > 0 && credit > 0) {
      throw badRequest(`Line ${i + 1} on "${l.account}" has both a debit and a credit; a line is one side or the other.`);
    }
    if (debit === 0 && credit === 0) {
      throw badRequest(`Line ${i + 1} on "${l.account}" has neither a debit nor a credit.`);
    }
    return { kind: l.kind, account: l.account, debit, credit };
  });

  const debits = prepared.reduce((s, l) => s + l.debit, 0);
  const credits = prepared.reduce((s, l) => s + l.credit, 0);
  if (debits !== credits) {
    throw badRequest(
      `That entry does not balance: debits total ${toDecimal(debits)} against credits total ${toDecimal(credits)}, ` +
      `a difference of ${toDecimal(Math.abs(debits - credits))}.`,
    );
  }
  return prepared;
}

export default async function journalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/businesses/:id/journal', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('That journal query was rejected: ' + issues(parsed.error));
    const q = parsed.data;
    if (q.from && q.to && q.from > q.to) throw badRequest('The "from" date is after the "to" date.');

    const where: string[] = ['je.business_id=$1'];
    const args: unknown[] = [businessId];
    if (q.from) { args.push(q.from); where.push(`je.entry_date >= $${args.length}::date`); }
    if (q.to) { args.push(q.to); where.push(`je.entry_date <= $${args.length}::date`); }
    if (q.type) { args.push(q.type); where.push(`je.entry_type = $${args.length}`); }
    if (q.account) {
      args.push(q.account);
      where.push(`EXISTS (SELECT 1 FROM journal_lines jl
                           WHERE jl.entry_id = je.id AND lower(jl.account) = lower($${args.length}))`);
    }
    args.push(q.limit, q.offset);

    const { rows } = await getPool().query<EntryRow & { full_count: number }>(
      `SELECT ${ENTRY_COLS}, count(*) OVER() AS full_count
         FROM journal_entries je
        WHERE ${where.join(' AND ')}
        ORDER BY ${SORT_SQL[q.sort]}
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    );
    const byEntry = await linesFor(getPool(), businessId, rows.map((r) => r.id));
    return {
      entries: rows.map((r) => shape(r, byEntry.get(r.id) ?? [])),
      count: rows[0]?.full_count ?? 0,
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.get('/businesses/:id/journal/:entryId', async (req) => {
    const p = await authenticate(req);
    const { id, entryId } = z.object({ id: z.string(), entryId: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    if (!isUuid(entryId)) throw notFound('That journal entry');
    const entry = await loadEntry(getPool(), businessId, entryId);
    const byEntry = await linesFor(getPool(), businessId, [entryId]);
    return { entry: shape(entry, byEntry.get(entryId) ?? []) };
  });

  app.post('/businesses/:id/journal', async (req, reply) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    const parsed = entryBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That journal entry was rejected: ' + issues(parsed.error));
    const b = parsed.data;
    const lines = prepareLines(b.lines);

    const created = await tx(async (c) => {
      const ref = b.ref ?? await nextRef(c, businessId);
      let entry: EntryRow;
      try {
        const { rows } = await c.query<EntryRow>(
          `INSERT INTO journal_entries (business_id,ref,entry_date,entry_type,memo,created_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, ref, entry_date, entry_type, memo, created_at`,
          [businessId, ref, b.date, b.type, b.memo, p.userId],
        );
        entry = rows[0]!;
      } catch (err) {
        if ((err as { code?: string })?.code === '23505') {
          throw conflict(`A journal entry numbered "${ref}" already exists in this business.`);
        }
        throw err;
      }
      let lineNo = 0;
      for (const l of lines) {
        await c.query(
          `INSERT INTO journal_lines (entry_id,line_no,kind,account,debit,credit)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [entry.id, lineNo++, l.kind, l.account, toDecimal(l.debit), toDecimal(l.credit)],
        );
      }
      await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'journal.create', entity: 'journal_entry', entityId: entry.id,
        detail: {
          ref, date: b.date, type: b.type, lines: lines.length,
          debits: toDecimal(lines.reduce((s, l) => s + l.debit, 0)),
        },
        ip: req.ip, requestId: String(req.id),
      }, c);
      return entry;
    });

    const byEntry = await linesFor(getPool(), businessId, [created.id]);
    reply.status(201);
    return { entry: shape(created, byEntry.get(created.id) ?? []) };
  });

  app.delete('/businesses/:id/journal/:entryId', async (req) => {
    const p = await authenticate(req);
    const { id, entryId } = z.object({ id: z.string(), entryId: z.string() }).parse(req.params);
    // Destructive: owner only. Removing an entry moves every downstream total.
    const { businessId } = await requireBusinessAccess(p, id, 'owner');
    if (!isUuid(entryId)) throw notFound('That journal entry');
    const parsed = z.object({ version: z.union([z.string(), z.number()]).nullable().optional() })
      .strict().safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That delete was malformed.');

    await tx(async (c) => {
      const before = await loadEntry(c, businessId, entryId);
      // The lines go with the entry by ON DELETE CASCADE; the business_id in the
      // predicate is what stops a well-formed id from another firm deleting one.
      await c.query('DELETE FROM journal_entries WHERE business_id=$1 AND id=$2', [businessId, entryId]);
      await bumpVersion(c, businessId, parsed.data.version == null ? null : String(parsed.data.version));
      await audit({
        userId: p.userId, businessId, action: 'journal.delete', entity: 'journal_entry', entityId: entryId,
        detail: { ref: before.ref, date: iso(before.entry_date), memo: before.memo },
        ip: req.ip, requestId: String(req.id),
      }, c);
    });

    return { ok: true };
  });
}
