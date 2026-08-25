import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate } from '../app.js';
import { requireBusinessAccess, bumpVersion } from '../lib/authz.js';
import { tx, getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';

/**
 * Businesses and who may see them.
 *
 * Two rules carry the weight here. A business is only ever reachable through a
 * business_access row — firm membership grants nothing — so every read starts at
 * requireBusinessAccess and uses the id it hands back. And a business must never
 * be left with nobody who can administer it: the last owner cannot be demoted or
 * removed, because an orphaned set of books is a support ticket that cannot be
 * resolved from inside the product.
 */

/** Fields a client may set, mapped to their columns. The column name is only
 *  ever taken from this table, never from the request. */
const COLUMNS = {
  name: 'name',
  type: 'type',
  dataSource: 'data_source',
  currency: 'currency',
  color: 'color',
  logo: 'logo',
  address: 'address',
  email: 'email',
  paymentInstructions: 'payment_instructions',
  bankName: 'bank_name',
  accountName: 'account_name',
  accountNumber: 'account_number',
  routingNumber: 'routing_number',
  accountType: 'account_type',
} as const;

type Field = keyof typeof COLUMNS;

const businessFields = {
  name: z.string().min(1).max(300),
  type: z.string().max(120),
  dataSource: z.enum(['ledger', 'statements']),
  currency: z.string().max(8),
  color: z.string().max(32),
  logo: z.string().max(2_000_000).nullable(),
  address: z.string().max(1000),
  email: z.string().max(300),
  paymentInstructions: z.string().max(4000),
  bankName: z.string().max(200),
  accountName: z.string().max(200),
  accountNumber: z.string().max(64),
  routingNumber: z.string().max(64),
  accountType: z.string().max(64),
};

const createIn = z
  .object({
    name: businessFields.name,
    type: businessFields.type.optional(),
    dataSource: businessFields.dataSource.optional(),
    currency: businessFields.currency.optional(),
    color: businessFields.color.optional(),
    logo: businessFields.logo.optional(),
    address: businessFields.address.optional(),
    email: businessFields.email.optional(),
    paymentInstructions: businessFields.paymentInstructions.optional(),
    bankName: businessFields.bankName.optional(),
    accountName: businessFields.accountName.optional(),
    accountNumber: businessFields.accountNumber.optional(),
    routingNumber: businessFields.routingNumber.optional(),
    accountType: businessFields.accountType.optional(),
  })
  .strict();

const patchIn = z
  .object({
    // The version the caller had on screen. Required, not optional: a PATCH that
    // may skip the check is a PATCH that will skip the check.
    version: z.union([z.string().max(32), z.number()]),
    name: businessFields.name.optional(),
    type: businessFields.type.optional(),
    dataSource: businessFields.dataSource.optional(),
    currency: businessFields.currency.optional(),
    color: businessFields.color.optional(),
    logo: businessFields.logo.optional(),
    address: businessFields.address.optional(),
    email: businessFields.email.optional(),
    paymentInstructions: businessFields.paymentInstructions.optional(),
    bankName: businessFields.bankName.optional(),
    accountName: businessFields.accountName.optional(),
    accountNumber: businessFields.accountNumber.optional(),
    routingNumber: businessFields.routingNumber.optional(),
    accountType: businessFields.accountType.optional(),
  })
  .strict();

const listQuery = z
  .object({
    // Every list endpoint is bounded. 200 is the ceiling, not a suggestion.
    limit: z.coerce.number().int().min(1).max(200).default(200),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

const grantIn = z
  .object({
    email: z.string().min(3).max(300),
    role: z.enum(['owner', 'accountant', 'readonly']),
  })
  .strict();

const idParam = z.object({ id: z.string().max(64) });
const accessParams = z.object({ id: z.string().max(64), userId: z.string().max(64) });

/**
 * The chart of accounts a new set of books starts with.
 *
 * Every business needs somewhere to put cash, what it is owed and what it owes
 * before the first invoice is entered; starting empty means the first thing a
 * new user does is administration rather than accounting. The income and expense
 * lists are ordinary small-business defaults and are meant to be edited.
 */
const DEFAULT_CATEGORIES: Record<string, string[]> = {
  asset: ['Cash', 'Accounts Receivable'],
  liability: ['Accounts Payable', 'Employee Reimbursements Payable'],
  equity: ["Owner's Equity"],
  income: ['Revenue', 'Consulting', 'Product Sales', 'Interest Income', 'Other Income'],
  expense: [
    'Advertising & Marketing',
    'Bank Fees',
    'Contractors',
    'Insurance',
    'Meals & Entertainment',
    'Office Supplies',
    'Professional Fees',
    'Rent',
    'Software & Subscriptions',
    'Travel',
    'Utilities',
    'Other',
  ],
};

/** The columns a detail response is built from, named once. */
const DETAIL_COLUMNS = `id, firm_id, name, type, data_source, currency, color, logo,
         address, email, payment_instructions, bank_name, account_name,
         account_number, routing_number, account_type, version::text AS version,
         created_at, updated_at, archived_at`;

const SELECT_DETAIL = `SELECT ${DETAIL_COLUMNS} FROM businesses WHERE id = $1`;

function shape(r: Record<string, unknown>, role?: string): Record<string, unknown> {
  return {
    id: r['id'],
    firmId: r['firm_id'],
    name: r['name'],
    type: r['type'],
    dataSource: r['data_source'],
    currency: r['currency'],
    color: r['color'],
    ...(Object.prototype.hasOwnProperty.call(r, 'logo') ? { logo: r['logo'] } : {}),
    address: r['address'],
    email: r['email'],
    paymentInstructions: r['payment_instructions'],
    bankName: r['bank_name'],
    accountName: r['account_name'],
    accountNumber: r['account_number'],
    routingNumber: r['routing_number'],
    accountType: r['account_type'],
    version: r['version'],
    createdAt: r['created_at'],
    updatedAt: r['updated_at'],
    archivedAt: r['archived_at'] ?? null,
    role: role ?? r['role'],
  };
}

export default async function businessesRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The businesses the caller can see. Driven by business_access alone, so this
   * list can never be used to discover a business someone else's firm owns —
   * not even by counting rows.
   */
  app.get('/businesses', async (req) => {
    const p = await authenticate(req);
    const parsed = listQuery.safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('That list request was malformed: limit must be between 1 and 200.');
    const { limit, offset } = parsed.data;
    // The logo is up to two megabytes of data URI; it belongs in the detail
    // response, not in a list of two hundred.
    const { rows } = await getPool().query(
      `SELECT b.id, b.firm_id, b.name, b.type, b.data_source, b.currency, b.color,
              b.address, b.email, b.payment_instructions, b.bank_name, b.account_name,
              b.account_number, b.routing_number, b.account_type, b.version::text AS version,
              b.created_at, b.updated_at, b.archived_at, ba.role
         FROM businesses b
         JOIN business_access ba ON ba.business_id = b.id AND ba.user_id = $1
        WHERE b.archived_at IS NULL
        ORDER BY b.name, b.id
        LIMIT $2 OFFSET $3`,
      [p.userId, limit, offset],
    );
    return { businesses: (rows as Record<string, unknown>[]).map((r) => shape(r)) };
  });

  /**
   * Creates a business, makes the caller its owner and seeds the chart of
   * accounts — all in one transaction, so a failure half way through cannot
   * leave a business nobody has access to.
   */
  app.post('/businesses', async (req, reply) => {
    const p = await authenticate(req);
    const parsed = createIn.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'That business could not be created: ' +
          parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; '),
      );
    }
    const b = parsed.data;

    const created = await tx(async (c) => {
      const firmId = await ensureFirm(c, p.userId, p.email);
      const { rows } = await c.query(
        `INSERT INTO businesses (firm_id,name,type,data_source,currency,color,logo,address,email,
                                 payment_instructions,bank_name,account_name,account_number,
                                 routing_number,account_type)
         VALUES ($1,$2,COALESCE($3,'Service-based'),COALESCE($4,'ledger'),COALESCE($5,'$'),
                 COALESCE($6,'#534AB7'),$7,COALESCE($8,''),COALESCE($9,''),COALESCE($10,''),
                 COALESCE($11,''),COALESCE($12,''),COALESCE($13,''),COALESCE($14,''),COALESCE($15,''))
         RETURNING ${DETAIL_COLUMNS}`,
        [
          firmId, b.name, b.type ?? null, b.dataSource ?? null, b.currency ?? null, b.color ?? null,
          b.logo ?? null, b.address ?? null, b.email ?? null, b.paymentInstructions ?? null,
          b.bankName ?? null, b.accountName ?? null, b.accountNumber ?? null,
          b.routingNumber ?? null, b.accountType ?? null,
        ],
      );
      const row = rows[0] as Record<string, unknown>;
      const businessId = String(row['id']);
      await c.query(
        `INSERT INTO business_access (business_id,user_id,role,granted_by) VALUES ($1,$2,'owner',$2)`,
        [businessId, p.userId],
      );
      for (const [kind, names] of Object.entries(DEFAULT_CATEGORIES)) {
        let sort = 0;
        for (const name of names) {
          await c.query(
            `INSERT INTO categories (business_id,kind,name,sort) VALUES ($1,$2,$3,$4)
             ON CONFLICT (business_id,kind,name) DO NOTHING`,
            [businessId, kind, name, sort++],
          );
        }
      }
      await audit(
        {
          userId: p.userId, businessId, action: 'business.create', entity: 'business', entityId: businessId,
          detail: { name: b.name, firmId }, ip: req.ip, requestId: String(req.id),
        },
        c,
      );
      return row;
    });

    return reply.status(201).send(shape(created, 'owner'));
  });

  app.get('/businesses/:id', async (req) => {
    const p = await authenticate(req);
    const { id } = idParam.parse(req.params);
    const { businessId, role } = await requireBusinessAccess(p, id, 'readonly');
    const { rows } = await getPool().query(SELECT_DETAIL, [businessId]);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw notFound('That business');
    return shape(row, role);
  });

  /**
   * Updates the business record. The caller sends the version they were shown
   * and bumpVersion asserts it, so two people editing the same business at once
   * get a rejection rather than one of them silently losing their change.
   */
  app.patch('/businesses/:id', async (req) => {
    const p = await authenticate(req);
    const { id } = idParam.parse(req.params);
    const { businessId, role } = await requireBusinessAccess(p, id, 'accountant');
    const parsed = patchIn.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'That update was rejected: ' +
          parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'body'} ${i.message}`).join('; '),
      );
    }
    const body = parsed.data;
    const expected = String(body.version);
    if (!/^\d+$/.test(expected)) throw badRequest('That version is not a version number.');

    const sets: string[] = [];
    const vals: unknown[] = [businessId];
    for (const key of Object.keys(COLUMNS) as Field[]) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      vals.push((body as Record<string, unknown>)[key]);
      sets.push(`${COLUMNS[key]} = $${vals.length}`);
    }
    if (sets.length === 0) throw badRequest('That update named no fields to change.');

    const updated = await tx(async (c) => {
      // Version first: a stale write must not touch a single column.
      const version = await bumpVersion(c, businessId, expected);
      await c.query(`UPDATE businesses SET ${sets.join(', ')} WHERE id = $1`, vals);
      await audit(
        {
          userId: p.userId, businessId, action: 'business.update', entity: 'business', entityId: businessId,
          detail: { fields: sets.map((s) => s.split(' ')[0]), version }, ip: req.ip, requestId: String(req.id),
        },
        c,
      );
      const { rows } = await c.query(SELECT_DETAIL, [businessId]);
      return rows[0] as Record<string, unknown>;
    });

    return shape(updated, role);
  });

  /**
   * Archives rather than deletes. Books are records: a business someone stops
   * using still has to be produceable for a tax authority years later, and a
   * DELETE that takes the invoices with it is a compliance failure, not a
   * feature.
   */
  app.delete('/businesses/:id', async (req) => {
    const p = await authenticate(req);
    const { id } = idParam.parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'owner');
    const q = z.object({ version: z.union([z.string().max(32), z.number()]).optional() }).strict();
    const parsedQ = q.safeParse(req.query ?? {});
    if (!parsedQ.success) throw badRequest('That archive request was malformed.');
    const expected = parsedQ.data.version == null ? null : String(parsedQ.data.version);
    if (expected != null && !/^\d+$/.test(expected)) throw badRequest('That version is not a version number.');

    const version = await tx(async (c) => {
      const v = await bumpVersion(c, businessId, expected);
      await c.query(`UPDATE businesses SET archived_at = now() WHERE id = $1 AND archived_at IS NULL`, [businessId]);
      await audit(
        {
          userId: p.userId, businessId, action: 'business.archive', entity: 'business', entityId: businessId,
          detail: { version: v }, ip: req.ip, requestId: String(req.id),
        },
        c,
      );
      return v;
    });

    return { ok: true, id: businessId, archived: true, version };
  });

  /** Who can see this business. Owner only: the access list names people, and
   *  a read-only bookkeeper has no business enumerating their colleagues. */
  app.get('/businesses/:id/access', async (req) => {
    const p = await authenticate(req);
    const { id } = idParam.parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'owner');
    const { rows } = await getPool().query(
      `SELECT ba.user_id, ba.role, ba.granted_at, ba.granted_by,
              u.email, u.name, u.status
         FROM business_access ba
         JOIN users u ON u.id = ba.user_id
        WHERE ba.business_id = $1
        ORDER BY ba.granted_at, ba.user_id
        LIMIT 200`,
      [businessId],
    );
    return {
      access: (rows as Record<string, unknown>[]).map((r) => ({
        userId: r['user_id'],
        email: r['email'],
        name: r['name'],
        status: r['status'],
        role: r['role'],
        grantedAt: r['granted_at'],
        grantedBy: r['granted_by'] ?? null,
      })),
    };
  });

  /**
   * Grants or changes access by email.
   *
   * Deliberately no invitation flow: this cannot create a user. Granting access
   * to an address nobody has signed in with would mean the first person to claim
   * that address at Cognito inherits someone's books, so the answer is a 404 that
   * says exactly what to do instead.
   */
  app.post('/businesses/:id/access', async (req) => {
    const p = await authenticate(req);
    const { id } = idParam.parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'owner');
    const parsed = grantIn.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('That access grant was rejected: an email address and a role of owner, accountant or readonly are required.');
    }
    const { email, role } = parsed.data;

    const out = await tx(async (c) => {
      // Serialises every access change on this business against every other, so
      // two owners resigning at the same moment cannot both pass the last-owner
      // check and leave nobody behind.
      await c.query(`SELECT id FROM businesses WHERE id = $1 FOR UPDATE`, [businessId]);
      const { rows: users } = await c.query<{ id: string; email: string; name: string }>(
        `SELECT id, email, name FROM users WHERE lower(email) = lower($1)`,
        [email],
      );
      const target = users[0];
      if (!target) {
        const { HttpError } = await import('../lib/errors.js');
        throw new HttpError(
          404,
          'user_not_found',
          'Nobody has signed in with that email address yet. Ask them to sign in once, then grant them access.',
        );
      }
      const { rows: existing } = await c.query<{ role: string }>(
        `SELECT role FROM business_access WHERE business_id = $1 AND user_id = $2`,
        [businessId, target.id],
      );
      const was = existing[0]?.role ?? null;
      if (was === 'owner' && role !== 'owner' && (await ownerCount(c, businessId)) <= 1) {
        throw conflict('This is the last owner of this business. Make someone else an owner first.');
      }
      await c.query(
        `INSERT INTO business_access (business_id,user_id,role,granted_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (business_id,user_id) DO UPDATE SET role = EXCLUDED.role,
           granted_by = EXCLUDED.granted_by, granted_at = now()`,
        [businessId, target.id, role, p.userId],
      );
      await audit(
        {
          userId: p.userId, businessId, action: was ? 'business.access.change' : 'business.access.grant',
          entity: 'business_access', entityId: target.id,
          detail: { email: target.email, role, previousRole: was }, ip: req.ip, requestId: String(req.id),
        },
        c,
      );
      return { userId: target.id, email: target.email, name: target.name, role, previousRole: was };
    });

    return { ok: true, ...out };
  });

  /** Revokes access. The last owner cannot be removed, including by themselves. */
  app.delete('/businesses/:id/access/:userId', async (req) => {
    const p = await authenticate(req);
    const { id, userId } = accessParams.parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'owner');

    const out = await tx(async (c) => {
      await c.query(`SELECT id FROM businesses WHERE id = $1 FOR UPDATE`, [businessId]);
      // Constrained by business_id as well as user_id: an access row belongs to
      // one business, and naming a user from another one must find nothing.
      const { rows: existing } = await c.query<{ role: string }>(
        `SELECT ba.role FROM business_access ba
          WHERE ba.business_id = $1 AND ba.user_id::text = $2`,
        [businessId, userId],
      );
      const row = existing[0];
      if (!row) throw notFound('That access grant');
      if (row.role === 'owner' && (await ownerCount(c, businessId)) <= 1) {
        throw conflict('This is the last owner of this business. Make someone else an owner first.');
      }
      await c.query(`DELETE FROM business_access WHERE business_id = $1 AND user_id::text = $2`, [businessId, userId]);
      await audit(
        {
          userId: p.userId, businessId, action: 'business.access.revoke', entity: 'business_access',
          entityId: userId, detail: { previousRole: row.role }, ip: req.ip, requestId: String(req.id),
        },
        c,
      );
      return { userId, previousRole: row.role };
    });

    return { ok: true, ...out };
  });
}

async function ownerCount(c: PoolClient, businessId: string): Promise<number> {
  const { rows } = await c.query<{ n: number }>(
    `SELECT count(*)::bigint AS n FROM business_access WHERE business_id = $1 AND role = 'owner'`,
    [businessId],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Finds or creates the caller's firm. A first-time user has no firm yet, and
 * making them name one before they can enter a single invoice is a setup screen
 * nobody asked for; the firm is created lazily with their first business.
 */
async function ensureFirm(c: PoolClient, userId: string, email: string): Promise<string> {
  const { rows } = await c.query<{ firm_id: string }>(
    `SELECT firm_id FROM firm_members WHERE user_id = $1 ORDER BY added_at LIMIT 1`,
    [userId],
  );
  if (rows[0]) return rows[0].firm_id;
  const { rows: f } = await c.query<{ id: string }>(`INSERT INTO firms (name) VALUES ($1) RETURNING id`, [
    `${email.split('@')[0]}'s firm`,
  ]);
  const firmId = f[0]!.id;
  await c.query(`INSERT INTO firm_members (firm_id,user_id,role) VALUES ($1,$2,'owner')`, [firmId, userId]);
  return firmId;
}
