import type { FastifyInstance } from 'fastify';
import type { QueryResult, QueryResultRow } from 'pg';
import { z } from 'zod';
import { authenticate } from '../app.js';
import { requireBusinessAccess, bumpVersion, isUuid } from '../lib/authz.js';
import { tx, getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';

/**
 * The chart of accounts.
 *
 * Categories are the vocabulary every other screen spends: an expense's `cat`
 * and an invoice's `category` are the names held here. Nothing in the schema
 * enforces that link — the front end has always written free text — so this
 * module treats a category as referenced when a row anywhere in the SAME
 * business still spells its name, and refuses to delete it while that is true.
 * Deleting one out from under live rows does not tidy the books, it produces
 * expenses filed under a heading that no report knows about.
 */

const MAX_LIMIT = 200;

/** Exactly the kinds the schema's CHECK constraint allows. */
const KINDS = ['income', 'expense', 'asset', 'liability', 'equity', 'revenueReturn'] as const;
type Kind = (typeof KINDS)[number];

const versionIn = z.union([z.string(), z.number()]).nullable().optional();

const categoryBody = z.object({
  kind: z.enum(KINDS),
  name: z.string().trim().min(1).max(200),
  sort: z.coerce.number().int().min(0).max(100_000).optional(),
  version: versionIn,
}).strict();

const listQuery = z.object({
  kind: z.enum(KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(MAX_LIMIT),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict();

type CategoryRow = {
  id: string;
  kind: Kind;
  name: string;
  sort: number;
};

interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

function issues(err: z.ZodError): string {
  return err.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');
}

function shape(r: CategoryRow & { expense_count?: number; invoice_count?: number }): Record<string, unknown> {
  const used = { expenses: Number(r.expense_count ?? 0), invoices: Number(r.invoice_count ?? 0) };
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    sort: Number(r.sort),
    usedBy: used,
    inUse: used.expenses + used.invoices > 0,
  };
}

async function loadCategory(q: Queryable, businessId: string, categoryId: string): Promise<CategoryRow> {
  const { rows } = await q.query<CategoryRow>(
    'SELECT id, kind, name, sort FROM categories WHERE business_id=$1 AND id=$2',
    [businessId, categoryId],
  );
  const row = rows[0];
  if (!row) throw notFound('That category');
  return row;
}

/**
 * How many live rows still spell this name, in THIS business.
 *
 * Matched case-insensitively deliberately: "Software" and "software" are one
 * heading to the person reading the report, and a case-sensitive check would
 * happily delete the category out from under half its own rows.
 */
async function referenceCounts(
  q: Queryable, businessId: string, name: string,
): Promise<{ expenses: number; invoices: number; total: number }> {
  const { rows } = await q.query<{ expenses: number; invoices: number }>(
    `SELECT (SELECT count(*) FROM expenses e
              WHERE e.business_id=$1 AND lower(e.category)=lower($2))::bigint AS expenses,
            (SELECT count(*) FROM invoices i
              WHERE i.business_id=$1 AND lower(i.category)=lower($2))::bigint AS invoices`,
    [businessId, name],
  );
  const expenses = Number(rows[0]?.expenses ?? 0);
  const invoices = Number(rows[0]?.invoices ?? 0);
  return { expenses, invoices, total: expenses + invoices };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default async function categoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/businesses/:id/categories', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('That category query was rejected: ' + issues(parsed.error));
    const q = parsed.data;

    const args: unknown[] = [businessId, q.kind ?? null, q.limit, q.offset];
    const { rows } = await getPool().query<CategoryRow & {
      full_count: number; expense_count: number; invoice_count: number;
    }>(
      `WITH page AS (
         SELECT c.id, c.kind, c.name, c.sort, count(*) OVER() AS full_count
           FROM categories c
          WHERE c.business_id = $1
            AND ($2::text IS NULL OR c.kind = $2::text)
          ORDER BY c.kind, c.sort, c.name
          LIMIT $3 OFFSET $4
       )
       SELECT pc.id, pc.kind, pc.name, pc.sort, pc.full_count,
              (SELECT count(*) FROM expenses e
                WHERE e.business_id = $1 AND lower(e.category) = lower(pc.name))::bigint AS expense_count,
              (SELECT count(*) FROM invoices i
                WHERE i.business_id = $1 AND lower(i.category) = lower(pc.name))::bigint AS invoice_count
         FROM page pc
        ORDER BY pc.kind, pc.sort, pc.name`,
      args,
    );

    // The front end's category picker wants { expense: [...], income: [...] };
    // the flat list is what a table renders. Both come off the same query rather
    // than the client having to fetch twice and hope they agree.
    const byKind: Record<string, string[]> = {};
    for (const r of rows) (byKind[r.kind] ??= []).push(r.name);

    return {
      categories: rows.map(shape),
      byKind,
      count: rows[0]?.full_count ?? 0,
      limit: q.limit,
      offset: q.offset,
    };
  });

  app.post('/businesses/:id/categories', async (req, reply) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    const parsed = categoryBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That category was rejected: ' + issues(parsed.error));
    const b = parsed.data;

    const created = await tx(async (c) => {
      // The UNIQUE index is the real guard against a duplicate; this check only
      // turns the common case into a sentence a person can act on. A race that
      // slips past it still lands on the 23505 handler below rather than a 500.
      const { rows: dupe } = await c.query<{ id: string }>(
        'SELECT id FROM categories WHERE business_id=$1 AND kind=$2 AND name=$3',
        [businessId, b.kind, b.name],
      );
      if (dupe[0]) {
        throw conflict(`This business already has a ${b.kind} category named "${b.name}".`);
      }

      let row: CategoryRow;
      try {
        const { rows } = await c.query<CategoryRow>(
          `INSERT INTO categories (business_id, kind, name, sort)
           VALUES ($1,$2,$3,COALESCE($4::integer, (SELECT COALESCE(MAX(sort),-1)+1 FROM categories
                                           WHERE business_id=$1 AND kind=$2)))
           RETURNING id, kind, name, sort`,
          [businessId, b.kind, b.name, b.sort ?? null],
        );
        row = rows[0]!;
      } catch (err) {
        if ((err as { code?: string })?.code === '23505') {
          throw conflict(`This business already has a ${b.kind} category named "${b.name}".`);
        }
        throw err;
      }

      await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'category.create', entity: 'category', entityId: row.id,
        detail: { kind: row.kind, name: row.name }, ip: req.ip, requestId: String(req.id),
      }, c);
      return row;
    });

    reply.status(201);
    return { category: shape(created) };
  });

  app.delete('/businesses/:id/categories/:categoryId', async (req) => {
    const p = await authenticate(req);
    const { id, categoryId } = z.object({ id: z.string(), categoryId: z.string() }).parse(req.params);
    // Destructive: owner only.
    const { businessId } = await requireBusinessAccess(p, id, 'owner');
    if (!isUuid(categoryId)) throw notFound('That category');
    const parsed = z.object({ version: versionIn }).strict().safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That delete was malformed.');

    await tx(async (c) => {
      const before = await loadCategory(c, businessId, categoryId);
      const used = await referenceCounts(c, businessId, before.name);
      if (used.total > 0) {
        const parts: string[] = [];
        if (used.expenses) parts.push(plural(used.expenses, 'expense', 'expenses'));
        if (used.invoices) parts.push(plural(used.invoices, 'invoice', 'invoices'));
        throw conflict(
          `"${before.name}" is still used by ${parts.join(' and ')}. ` +
          'Move them to another category first, then delete this one.',
        );
      }
      await c.query('DELETE FROM categories WHERE business_id=$1 AND id=$2', [businessId, categoryId]);
      await bumpVersion(c, businessId, parsed.data.version == null ? null : String(parsed.data.version));
      await audit({
        userId: p.userId, businessId, action: 'category.delete', entity: 'category', entityId: categoryId,
        detail: { kind: before.kind, name: before.name }, ip: req.ip, requestId: String(req.id),
      }, c);
    });

    return { ok: true };
  });
}
