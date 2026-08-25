import type { FastifyInstance } from 'fastify';
import type { QueryResult, QueryResultRow } from 'pg';
import { z } from 'zod';
import { authenticate } from '../app.js';
import { requireBusinessAccess, bumpVersion, isUuid } from '../lib/authz.js';
import { tx, getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';

/**
 * Clients: the address book invoices are written against.
 *
 * Invoices carry `client_name` as well as `client_id` because the front end has
 * always keyed them by name and a migrated book may reference a client that was
 * never created as a row. That denormalisation is deliberate, and it is why a
 * rename here has to rewrite the invoices that quote the old name — otherwise
 * renaming "Acme" to "Acme Ltd" silently splits one client's ledger in two.
 */

const MAX_LIMIT = 200;

const clientBody = z.object({
  name: z.string().trim().min(1).max(300),
  email: z.string().max(300).default(''),
  phone: z.string().max(80).default(''),
  address: z.string().max(1000).default(''),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  version: z.union([z.string(), z.number()]).nullable().optional(),
}).strict();

const clientPatch = z.object({
  name: z.string().trim().min(1).max(300).optional(),
  email: z.string().max(300).optional(),
  phone: z.string().max(80).optional(),
  address: z.string().max(1000).optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  version: z.union([z.string(), z.number()]).nullable().optional(),
}).strict();

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  // Sort keys are matched against a fixed map; the string never reaches the SQL.
  sort: z.enum(['name', 'created']).default('name'),
}).strict();

const SORT_SQL: Record<'name' | 'created', string> = {
  name: 'name ASC',
  created: 'created_at DESC, name ASC',
};

type ClientRow = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  tax_rate: string;
  created_at: Date | string;
};

function shape(r: ClientRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    address: r.address,
    taxRate: Number(r.tax_rate),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** A duplicate name is a user-fixable collision, not a server fault. */
function asConflict(err: unknown, message: string): never {
  if ((err as { code?: string })?.code === '23505') throw conflict(message);
  throw err;
}

/** Pool and PoolClient both satisfy this, so reads work in or out of a tx. */
interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

async function loadClient(q: Queryable, businessId: string, clientId: string): Promise<ClientRow> {
  // business_id in the WHERE clause as well as the id: an id alone is guessable
  // enough that "wrong tenant" must be unreachable, not merely unlikely.
  const { rows } = await q.query<ClientRow>(
    `SELECT id, name, email, phone, address, tax_rate, created_at
       FROM clients WHERE business_id=$1 AND id=$2`,
    [businessId, clientId],
  );
  const row = rows[0];
  if (!row) throw notFound('That client');
  return row;
}

export default async function clientsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/businesses/:id/clients', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('That client query was malformed.');
    const { limit, offset, sort } = parsed.data;

    const { rows } = await getPool().query<ClientRow & { full_count: number }>(
      `SELECT id, name, email, phone, address, tax_rate, created_at,
              count(*) OVER() AS full_count
         FROM clients
        WHERE business_id=$1
        ORDER BY ${SORT_SQL[sort]}
        LIMIT $2 OFFSET $3`,
      [businessId, limit, offset],
    );
    return {
      clients: rows.map(shape),
      count: rows[0]?.full_count ?? 0,
      limit,
      offset,
    };
  });

  app.get('/businesses/:id/clients/:clientId', async (req) => {
    const p = await authenticate(req);
    const { id, clientId } = z.object({ id: z.string(), clientId: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    if (!isUuid(clientId)) throw notFound('That client');
    return { client: shape(await loadClient(getPool(), businessId, clientId)) };
  });

  app.post('/businesses/:id/clients', async (req, reply) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    const parsed = clientBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest('That client was rejected: ' + issues(parsed.error));
    }
    const b = parsed.data;

    const created = await tx(async (c) => {
      let row: ClientRow;
      try {
        const { rows } = await c.query<ClientRow>(
          `INSERT INTO clients (business_id,name,email,phone,address,tax_rate)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id, name, email, phone, address, tax_rate, created_at`,
          [businessId, b.name, b.email, b.phone, b.address, b.taxRate],
        );
        row = rows[0]!;
      } catch (err) {
        asConflict(err, `A client named "${b.name}" already exists in this business.`);
      }
      // Adopt invoices that already quote this name but predate the client row —
      // migrated books are full of them, and without this a later rename misses
      // exactly the invoices the user can see on screen.
      await c.query(
        `UPDATE invoices SET client_id=$3, updated_at=now()
          WHERE business_id=$1 AND client_id IS NULL AND client_name=$2`,
        [businessId, b.name, row.id],
      );
      await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'client.create', entity: 'client', entityId: row.id,
        detail: { name: b.name }, ip: req.ip, requestId: String(req.id),
      }, c);
      return row;
    });

    reply.status(201);
    return { client: shape(created) };
  });

  app.patch('/businesses/:id/clients/:clientId', async (req) => {
    const p = await authenticate(req);
    const { id, clientId } = z.object({ id: z.string(), clientId: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    if (!isUuid(clientId)) throw notFound('That client');
    const parsed = clientPatch.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That client change was rejected: ' + issues(parsed.error));
    const b = parsed.data;

    const out = await tx(async (c) => {
      const before = await loadClient(c, businessId, clientId);
      const next = {
        name: b.name ?? before.name,
        email: b.email ?? before.email,
        phone: b.phone ?? before.phone,
        address: b.address ?? before.address,
        taxRate: b.taxRate ?? Number(before.tax_rate),
      };
      let row: ClientRow;
      try {
        const { rows } = await c.query<ClientRow>(
          `UPDATE clients SET name=$3, email=$4, phone=$5, address=$6, tax_rate=$7
            WHERE business_id=$1 AND id=$2
            RETURNING id, name, email, phone, address, tax_rate, created_at`,
          [businessId, clientId, next.name, next.email, next.phone, next.address, next.taxRate],
        );
        row = rows[0]!;
      } catch (err) {
        asConflict(err, `A client named "${next.name}" already exists in this business.`);
      }
      let renamed = 0;
      if (next.name !== before.name) {
        // Match on either link: the id catches adopted invoices, the old name
        // catches the ones that were never linked.
        const res = await c.query(
          `UPDATE invoices SET client_name=$3, client_id=$2, updated_at=now()
            WHERE business_id=$1 AND (client_id=$2 OR client_name=$4)`,
          [businessId, clientId, next.name, before.name],
        );
        renamed = res.rowCount ?? 0;
      }
      await bumpVersion(c, businessId, b.version == null ? null : String(b.version));
      await audit({
        userId: p.userId, businessId, action: 'client.update', entity: 'client', entityId: clientId,
        detail: { from: before.name, to: next.name, invoicesRenamed: renamed },
        ip: req.ip, requestId: String(req.id),
      }, c);
      return { row, renamed };
    });

    return { client: shape(out.row), invoicesRenamed: out.renamed };
  });

  app.delete('/businesses/:id/clients/:clientId', async (req) => {
    const p = await authenticate(req);
    const { id, clientId } = z.object({ id: z.string(), clientId: z.string() }).parse(req.params);
    // Destructive: owner only.
    const { businessId } = await requireBusinessAccess(p, id, 'owner');
    if (!isUuid(clientId)) throw notFound('That client');
    const parsed = z.object({ version: z.union([z.string(), z.number()]).nullable().optional() })
      .strict().safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('That delete was malformed.');

    await tx(async (c) => {
      const before = await loadClient(c, businessId, clientId);
      const { rows } = await c.query<{ n: number }>(
        `SELECT count(*)::bigint AS n FROM invoices
          WHERE business_id=$1 AND (client_id=$2 OR client_name=$3)`,
        [businessId, clientId, before.name],
      );
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) {
        // Deleting would orphan the invoices' only record of who owed the money,
        // so the user is told what to do instead of losing it.
        throw conflict(
          `"${before.name}" still has ${n} invoice${n === 1 ? '' : 's'}. ` +
          `Delete or reassign those invoices first, then remove the client.`,
        );
      }
      await c.query('DELETE FROM clients WHERE business_id=$1 AND id=$2', [businessId, clientId]);
      await bumpVersion(c, businessId, parsed.data.version == null ? null : String(parsed.data.version));
      await audit({
        userId: p.userId, businessId, action: 'client.delete', entity: 'client', entityId: clientId,
        detail: { name: before.name }, ip: req.ip, requestId: String(req.id),
      }, c);
    });

    return { ok: true };
  });
}

function issues(err: z.ZodError): string {
  return err.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; ');
}
