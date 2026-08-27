import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../app.js';
import { requireBusinessAccess, bumpVersion } from '../lib/authz.js';
import { tx, getPool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, staleWrite } from '../lib/errors.js';
import { parseMoney, toDecimal, fromDb } from '../lib/money.js';

/**
 * The bridge between the normalised tables and the single-file front end.
 *
 * The front end has ~1,150 assertions written against one shape: a business is
 * an object with arrays of invoices, expenses, clients and so on. Rewriting all
 * of that to speak REST is how you lose a year and reintroduce bugs that were
 * already found. So the database keeps the real relational shape — which is what
 * gives concurrency, querying and integrity — and this projects between the two.
 *
 * The granular endpoints are the future and are used for reporting today. This
 * is what lets the app ship before the UI is rewritten, not instead of it.
 */

const money = z.union([z.number(), z.string()]);
const dateish = z.string().max(32);

const invoiceIn = z.object({
  id: z.string().max(120).optional(),
  client: z.string().max(300).default(''),
  date: dateish,
  due: dateish.optional().nullable(),
  desc: z.string().max(2000).default(''),
  cat: z.string().max(120).default('Revenue'),
  amount: money,
  taxRate: z.union([z.number(), z.string()]).optional(),
  status: z.string().max(20).default('Pending'),
  migrated: z.boolean().optional(),
}).passthrough();

const expenseIn = z.object({
  id: z.string().max(120).optional(),
  date: dateish,
  vendor: z.string().max(300).default(''),
  desc: z.string().max(2000).default(''),
  cat: z.string().max(120).default('Other'),
  amount: money,
  deductible: z.boolean().optional(),
  hasReceipt: z.boolean().optional(),
}).passthrough();

const clientIn = z.object({
  name: z.string().min(1).max(300),
  email: z.string().max(300).default(''),
  phone: z.string().max(80).default(''),
  address: z.string().max(1000).default(''),
  taxRate: z.union([z.number(), z.string()]).optional(),
}).passthrough();

const jeIn = z.object({
  id: z.string().max(120).optional(),
  date: dateish,
  type: z.string().max(60).default('Manual'),
  memo: z.string().max(2000).default(''),
  lines: z.array(z.object({
    kind: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
    account: z.string().min(1).max(200),
    debit: money.optional(),
    credit: money.optional(),
  })).min(2),
}).passthrough();

const bankIn = z.object({
  date: dateish,
  desc: z.string().max(2000).default(''),
  // The front end's native shape for a bank row is debit/credit (see every
  // bank-import call site in web/index.html — none of them ever set .amount),
  // not a single signed amount. `amount` is accepted too, for anything that
  // already sends one, but at least one of the three must resolve to a value
  // or the row is rejected below rather than silently becoming $0.
  amount: money.optional(),
  debit: money.optional(),
  credit: money.optional(),
  balance: money.optional().nullable(),
  cat: z.string().max(120).optional().nullable(),
  // The front end stores this as the string 'matched' / 'unmatched', never a
  // boolean — accept both instead of rejecting every real bank row.
  matched: z.union([z.boolean(), z.string()]).optional(),
  posted: z.boolean().optional(),
  // What the front end actually calls this flag; posted is the column name.
  postedToBS: z.boolean().optional(),
  source: z.string().max(300).optional(),
}).passthrough();

const snapshotIn = z.object({
  version: z.union([z.string(), z.number()]).optional().nullable(),
  invoices: z.array(invoiceIn).max(20000).default([]),
  expenses: z.array(expenseIn).max(20000).default([]),
  clients: z.array(clientIn).max(5000).default([]),
  journalEntries: z.array(jeIn).max(20000).default([]),
  bankTxns: z.array(bankIn).max(50000).default([]),
  categories: z.record(z.string(), z.array(z.string().max(200))).optional(),
  openingBalance: z.object({
    date: dateish, cash: money.optional(), ar: money.optional(), ap: money.optional(),
  }).nullable().optional(),
  // Everything the MVP does not model relationally rides here untouched.
  extras: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const KNOWN_KEYS = new Set([
  'version', 'invoices', 'expenses', 'clients', 'journalEntries', 'bankTxns',
  'categories', 'openingBalance', 'extras',
]);

/** Stable fingerprint for a bank row so re-importing a statement cannot double it. */
function dedupeKey(date: string, amountCents: number, desc: string): string {
  return [date, amountCents, desc.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120)].join('|');
}

export default async function snapshotRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The business list, in the shape the front end's META object already uses.
   * Only businesses the caller has an explicit access row for are ever returned,
   * so the list itself cannot be used to discover another firm's clients.
   */
  app.get('/workspace/meta', async (req) => {
    const p = await authenticate(req);
    const { rows } = await getPool().query(
      `SELECT b.id, b.name, b.type, b.data_source, b.currency, b.color, b.logo,
              b.address, b.email, b.payment_instructions, b.bank_name, b.account_name,
              b.account_number, b.routing_number, b.account_type, b.version::text AS version,
              ba.role
         FROM businesses b
         JOIN business_access ba ON ba.business_id = b.id AND ba.user_id = $1
        WHERE b.archived_at IS NULL
        ORDER BY b.name`,
      [p.userId],
    );
    return {
      businesses: (rows as any[]).map((r) => ({
        id: r.id, name: r.name, type: r.type, dataSource: r.data_source, currency: r.currency,
        color: r.color, logo: r.logo, address: r.address, email: r.email,
        paymentInstructions: r.payment_instructions, bankName: r.bank_name,
        accountName: r.account_name, accountNumber: r.account_number,
        routingNumber: r.routing_number, accountType: r.account_type,
        version: r.version, role: r.role,
      })),
    };
  });

  const metaIn = z.object({
    businesses: z.array(z.object({
      id: z.string().max(120).optional(),
      name: z.string().min(1).max(300),
      type: z.string().max(120).optional(),
      dataSource: z.enum(['ledger', 'statements']).optional(),
      currency: z.string().max(8).optional(),
      color: z.string().max(32).optional(),
      logo: z.string().max(2_000_000).nullable().optional(),
      address: z.string().max(1000).optional(),
      email: z.string().max(300).optional(),
      paymentInstructions: z.string().max(4000).optional(),
      bankName: z.string().max(200).optional(),
      accountName: z.string().max(200).optional(),
      accountNumber: z.string().max(64).optional(),
      routingNumber: z.string().max(64).optional(),
      accountType: z.string().max(64).optional(),
    }).passthrough()).max(500),
  }).strict();

  /**
   * Upserts the business list. A business the caller cannot reach is skipped
   * silently rather than rejected: the front end sends whatever META holds, and
   * a stale local entry for a business whose access was revoked must not be able
   * to write to it — nor to learn that it still exists.
   */
  app.put('/workspace/meta', async (req) => {
    const p = await authenticate(req);
    const parsed = metaIn.safeParse(req.body);
    if (!parsed.success) throw badRequest('That business list was malformed.');
    const out = await tx(async (c) => {
      const created: Record<string, string> = {};
      const { rows: mine } = await c.query<{ business_id: string; role: string }>(
        `SELECT business_id, role FROM business_access WHERE user_id=$1`, [p.userId],
      );
      const access = new Map(mine.map((r) => [r.business_id, r.role]));
      let firmId: string | null = null;
      for (const b of parsed.data.businesses) {
        const known = b.id && access.has(b.id);
        if (known) {
          if (access.get(b.id!) === 'readonly') continue; // no write for read-only access
          await c.query(
            `UPDATE businesses SET name=$2, type=COALESCE($3,type), data_source=COALESCE($4,data_source),
                    currency=COALESCE($5,currency), color=COALESCE($6,color), logo=$7,
                    address=COALESCE($8,address), email=COALESCE($9,email),
                    payment_instructions=COALESCE($10,payment_instructions),
                    bank_name=COALESCE($11,bank_name), account_name=COALESCE($12,account_name),
                    account_number=COALESCE($13,account_number), routing_number=COALESCE($14,routing_number),
                    account_type=COALESCE($15,account_type), updated_at=now()
              WHERE id=$1`,
            [b.id, b.name, b.type ?? null, b.dataSource ?? null, b.currency ?? null, b.color ?? null,
             b.logo ?? null, b.address ?? null, b.email ?? null, b.paymentInstructions ?? null,
             b.bankName ?? null, b.accountName ?? null, b.accountNumber ?? null,
             b.routingNumber ?? null, b.accountType ?? null],
          );
          continue;
        }
        if (!firmId) firmId = await ensureFirm(c, p.userId, p.email);
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO businesses (firm_id,name,type,data_source,currency,color,logo,address,email,
                                   payment_instructions,bank_name,account_name,account_number,
                                   routing_number,account_type)
           VALUES ($1,$2,COALESCE($3,'Service-based'),COALESCE($4,'ledger'),COALESCE($5,'$'),
                   COALESCE($6,'#534AB7'),$7,COALESCE($8,''),COALESCE($9,''),COALESCE($10,''),
                   COALESCE($11,''),COALESCE($12,''),COALESCE($13,''),COALESCE($14,''),COALESCE($15,''))
           RETURNING id`,
          [firmId, b.name, b.type ?? null, b.dataSource ?? null, b.currency ?? null, b.color ?? null,
           b.logo ?? null, b.address ?? null, b.email ?? null, b.paymentInstructions ?? null,
           b.bankName ?? null, b.accountName ?? null, b.accountNumber ?? null,
           b.routingNumber ?? null, b.accountType ?? null],
        );
        const newId = rows[0]!.id;
        await c.query(
          `INSERT INTO business_access (business_id,user_id,role,granted_by) VALUES ($1,$2,'owner',$2)`,
          [newId, p.userId],
        );
        if (b.id) created[b.id] = newId;   // local id → server id, so the client can remap
        await audit({ userId: p.userId, businessId: newId, action: 'business.create', entity: 'business',
          entityId: newId, detail: { name: b.name }, ip: req.ip, requestId: String(req.id) }, c);
      }
      return created;
    });
    return { ok: true, idMap: out };
  });

  app.get('/businesses/:id/snapshot', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'readonly');
    return await readSnapshot(businessId);
  });

  app.put('/businesses/:id/snapshot', async (req) => {
    const p = await authenticate(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { businessId } = await requireBusinessAccess(p, id, 'accountant');
    const parsed = snapshotIn.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest('That save was rejected: ' + parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
    }
    const body = parsed.data as z.infer<typeof snapshotIn> & Record<string, unknown>;

    // Anything the front end sends that this endpoint does not model is preserved
    // rather than dropped. A future feature added in the browser keeps working
    // against an older server instead of silently losing its data on first save.
    const passthrough: Record<string, unknown> = { ...(body.extras ?? {}) };
    for (const [k, v] of Object.entries(body)) if (!KNOWN_KEYS.has(k)) passthrough[k] = v;

    const written = await tx(async (c) => {
      const expected = body.version == null ? null : String(body.version);
      // Replace-in-place inside one transaction. A snapshot save is the whole
      // business or none of it; a partial write would leave books that balance
      // nowhere and nothing on screen saying so.
      await c.query('DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE business_id=$1)', [businessId]);
      await c.query('DELETE FROM journal_entries WHERE business_id=$1', [businessId]);
      await c.query('DELETE FROM invoices WHERE business_id=$1', [businessId]);
      await c.query('DELETE FROM expenses WHERE business_id=$1', [businessId]);
      await c.query('DELETE FROM bank_txns WHERE business_id=$1', [businessId]);
      await c.query('DELETE FROM clients WHERE business_id=$1', [businessId]);
      await c.query('DELETE FROM categories WHERE business_id=$1', [businessId]);
      await c.query('DELETE FROM opening_balances WHERE business_id=$1', [businessId]);

      for (const cl of body.clients) {
        await c.query(
          `INSERT INTO clients (business_id,name,email,phone,address,tax_rate) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (business_id,name) DO UPDATE SET email=EXCLUDED.email, phone=EXCLUDED.phone,
             address=EXCLUDED.address, tax_rate=EXCLUDED.tax_rate`,
          [businessId, cl.name, cl.email ?? '', cl.phone ?? '', cl.address ?? '', Number(cl.taxRate ?? 0)],
        );
      }
      if (body.categories) {
        for (const [kind, names] of Object.entries(body.categories)) {
          if (!['income', 'expense', 'asset', 'liability', 'equity', 'revenueReturn'].includes(kind)) continue;
          let sort = 0;
          for (const name of names) {
            if (!name) continue;
            await c.query(
              `INSERT INTO categories (business_id,kind,name,sort) VALUES ($1,$2,$3,$4)
               ON CONFLICT (business_id,kind,name) DO NOTHING`,
              [businessId, kind, name, sort++],
            );
          }
        }
      }
      let n = 0;
      for (const inv of body.invoices) {
        await c.query(
          `INSERT INTO invoices (business_id,ref,client_name,issue_date,due_date,description,category,amount,tax_rate,status,migrated)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [businessId, inv.id ?? `INV-${++n}`, inv.client ?? '', inv.date, inv.due || null, inv.desc ?? '',
           inv.cat ?? 'Revenue', toDecimal(parseMoney(inv.amount, 'invoice amount')), Number(inv.taxRate ?? 0),
           normaliseStatus(inv.status), inv.migrated ?? false],
        );
      }
      for (const e of body.expenses) {
        await c.query(
          `INSERT INTO expenses (business_id,spend_date,vendor,description,category,amount,deductible,has_receipt)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [businessId, e.date, e.vendor ?? '', e.desc ?? '', e.cat ?? 'Other',
           toDecimal(parseMoney(e.amount, 'expense amount')), e.deductible ?? true, e.hasReceipt ?? false],
        );
      }
      for (const je of body.journalEntries) {
        let dr = 0, cr = 0;
        const lines = je.lines.map((l) => {
          const d = l.debit == null ? 0 : parseMoney(l.debit, 'journal debit');
          const k = l.credit == null ? 0 : parseMoney(l.credit, 'journal credit');
          dr += d; cr += k;
          return { ...l, d, k };
        });
        if (dr !== cr) {
          throw badRequest(`Journal entry ${je.id ?? je.memo ?? ''} does not balance: debits ${toDecimal(dr)} against credits ${toDecimal(cr)}.`);
        }
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO journal_entries (business_id,ref,entry_date,entry_type,memo) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [businessId, je.id ?? `JE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, je.date, je.type ?? 'Manual', je.memo ?? ''],
        );
        let ln = 0;
        for (const l of lines) {
          if (l.d === 0 && l.k === 0) continue;
          await c.query(
            `INSERT INTO journal_lines (entry_id,line_no,kind,account,debit,credit) VALUES ($1,$2,$3,$4,$5,$6)`,
            [rows[0]!.id, ln++, l.kind, l.account, toDecimal(l.d), toDecimal(l.k)],
          );
        }
      }
      const seenKeys = new Set<string>();
      for (const b of body.bankTxns) {
        // amount wins if sent; otherwise derive it the way the front end
        // itself always has (see web/index.html's amountOf()): a credit is
        // positive, a debit is the same magnitude negated. Both absent is a
        // genuinely malformed row, not a silent $0.
        const debitCents = b.debit == null ? 0 : parseMoney(b.debit, 'bank debit');
        const creditCents = b.credit == null ? 0 : parseMoney(b.credit, 'bank credit');
        const cents = b.amount != null
          ? parseMoney(b.amount, 'bank amount')
          : (creditCents !== 0 ? creditCents : -debitCents);
        if (b.amount == null && b.debit == null && b.credit == null) {
          throw badRequest(`A bank transaction on ${b.date} has no amount, debit, or credit.`);
        }
        const matched = b.matched === true || b.matched === 'matched';
        const posted = b.posted ?? b.postedToBS ?? false;
        let key = dedupeKey(b.date, cents, b.desc ?? '');
        // A statement genuinely can hold two identical rows on the same day.
        // Suffixing keeps both rather than silently dropping the second.
        let suffix = 1;
        while (seenKeys.has(key)) key = `${dedupeKey(b.date, cents, b.desc ?? '')}#${++suffix}`;
        seenKeys.add(key);
        await c.query(
          `INSERT INTO bank_txns (business_id,txn_date,description,amount,balance,category,matched,posted,source,dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (business_id,dedupe_key) DO NOTHING`,
          [businessId, b.date, b.desc ?? '', toDecimal(cents),
           b.balance == null ? null : toDecimal(parseMoney(b.balance, 'bank balance')),
           b.cat ?? null, matched, posted, b.source ?? '', key],
        );
      }
      if (body.openingBalance && body.openingBalance.date) {
        await c.query(
          `INSERT INTO opening_balances (business_id,as_of,cash,ar,ap,set_by) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (business_id) DO UPDATE SET as_of=EXCLUDED.as_of, cash=EXCLUDED.cash,
             ar=EXCLUDED.ar, ap=EXCLUDED.ap, set_by=EXCLUDED.set_by, set_at=now()`,
          [businessId, body.openingBalance.date,
           toDecimal(parseMoney(body.openingBalance.cash ?? 0, 'opening cash')),
           toDecimal(parseMoney(body.openingBalance.ar ?? 0, 'opening ar')),
           toDecimal(parseMoney(body.openingBalance.ap ?? 0, 'opening ap')), p.userId],
        );
      }
      await c.query('UPDATE businesses SET extras=$2 WHERE id=$1', [businessId, JSON.stringify(passthrough)]);
      const version = await bumpVersion(c, businessId, expected);
      await audit({
        userId: p.userId, businessId, action: 'snapshot.save', entity: 'business', entityId: businessId,
        detail: { invoices: body.invoices.length, expenses: body.expenses.length, clients: body.clients.length,
                  journalEntries: body.journalEntries.length, bankTxns: body.bankTxns.length },
        ip: req.ip, requestId: String(req.id),
      }, c);
      return version;
    });

    return { ok: true, version: written };
  });
}

function normaliseStatus(s: string): string {
  const v = String(s || '').trim();
  return ['Paid', 'Sent', 'Pending', 'Overdue', 'Draft'].includes(v) ? v : 'Pending';
}

export async function readSnapshot(businessId: string): Promise<Record<string, unknown>> {
  const pool = getPool();
  const [biz, invoices, expenses, clients, cats, entries, lines, bank, ob] = await Promise.all([
    pool.query(`SELECT extras, version::text AS version FROM businesses WHERE id=$1`, [businessId]),
    pool.query(`SELECT ref,client_name,issue_date,due_date,description,category,amount,tax_rate,status,migrated
                  FROM invoices WHERE business_id=$1 ORDER BY issue_date, ref`, [businessId]),
    pool.query(`SELECT spend_date,vendor,description,category,amount,deductible,has_receipt
                  FROM expenses WHERE business_id=$1 ORDER BY spend_date`, [businessId]),
    pool.query(`SELECT name,email,phone,address,tax_rate FROM clients WHERE business_id=$1 ORDER BY name`, [businessId]),
    pool.query(`SELECT kind,name FROM categories WHERE business_id=$1 ORDER BY kind,sort,name`, [businessId]),
    pool.query(`SELECT id,ref,entry_date,entry_type,memo FROM journal_entries WHERE business_id=$1 ORDER BY entry_date,ref`, [businessId]),
    pool.query(`SELECT jl.entry_id,jl.line_no,jl.kind,jl.account,jl.debit,jl.credit
                  FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
                 WHERE je.business_id=$1 ORDER BY jl.entry_id, jl.line_no`, [businessId]),
    pool.query(`SELECT txn_date,description,amount,balance,category,matched,posted,source
                  FROM bank_txns WHERE business_id=$1 ORDER BY txn_date`, [businessId]),
    pool.query(`SELECT as_of,cash,ar,ap FROM opening_balances WHERE business_id=$1`, [businessId]),
  ]);

  const byEntry = new Map<string, { kind: string; account: string; debit: number; credit: number }[]>();
  for (const l of lines.rows as any[]) {
    const arr = byEntry.get(l.entry_id) ?? [];
    arr.push({ kind: l.kind, account: l.account, debit: fromDb(l.debit) / 100, credit: fromDb(l.credit) / 100 });
    byEntry.set(l.entry_id, arr);
  }
  const categories: Record<string, string[]> = {};
  for (const c of cats.rows as any[]) (categories[c.kind] ??= []).push(c.name);

  const iso = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : '');
  const extras = (biz.rows[0] as any)?.extras ?? {};

  return {
    ...extras, // the deferred features, restored exactly as the browser left them
    version: (biz.rows[0] as any)?.version ?? null,
    invoices: (invoices.rows as any[]).map((r) => ({
      id: r.ref, client: r.client_name, date: iso(r.issue_date), due: iso(r.due_date),
      desc: r.description, cat: r.category, amount: fromDb(r.amount) / 100,
      taxRate: Number(r.tax_rate), status: r.status, ...(r.migrated ? { migrated: true } : {}),
    })),
    expenses: (expenses.rows as any[]).map((r, i) => ({
      id: `EXP-${i + 1}`, date: iso(r.spend_date), vendor: r.vendor, desc: r.description,
      cat: r.category, amount: fromDb(r.amount) / 100, deductible: r.deductible,
      ...(r.has_receipt ? { hasReceipt: true } : {}),
    })),
    clients: (clients.rows as any[]).map((r) => ({
      name: r.name, email: r.email, phone: r.phone, address: r.address, taxRate: Number(r.tax_rate),
    })),
    categories,
    journalEntries: (entries.rows as any[]).map((r) => ({
      id: r.ref, date: iso(r.entry_date), type: r.entry_type, memo: r.memo, lines: byEntry.get(r.id) ?? [],
    })),
    bankTxns: (bank.rows as any[]).map((r) => {
      // Mirror image of the write side: the front end reads .debit/.credit
      // and a 'matched'/'unmatched' string, never .amount or a boolean, on
      // every bank-import call site — so project the single signed column
      // back into that shape, or a restored row displays as a blank "—" and
      // $0 in money-in/out totals despite being stored correctly.
      const amt = fromDb(r.amount) / 100;
      return {
        date: iso(r.txn_date), desc: r.description,
        debit: amt < 0 ? -amt : 0, credit: amt > 0 ? amt : 0,
        balance: r.balance == null ? null : fromDb(r.balance) / 100,
        cat: r.category, matched: r.matched ? 'matched' : 'unmatched',
        posted: r.posted, postedToBS: r.posted, source: r.source,
      };
    }),
    openingBalance: ob.rows[0]
      ? { date: iso((ob.rows[0] as any).as_of), cash: fromDb((ob.rows[0] as any).cash) / 100,
          ar: fromDb((ob.rows[0] as any).ar) / 100, ap: fromDb((ob.rows[0] as any).ap) / 100 }
      : null,
  };
}

/**
 * Finds or creates the caller's firm. A first-time user signing in has no firm
 * yet; creating one lazily on their first business is what makes sign-in →
 * import → working books a single unbroken path with no setup screen.
 */
async function ensureFirm(c: import('pg').PoolClient, userId: string, email: string): Promise<string> {
  const { rows } = await c.query<{ firm_id: string }>(
    `SELECT firm_id FROM firm_members WHERE user_id=$1 ORDER BY added_at LIMIT 1`, [userId],
  );
  if (rows[0]) return rows[0].firm_id;
  const { rows: f } = await c.query<{ id: string }>(
    `INSERT INTO firms (name) VALUES ($1) RETURNING id`, [`${email.split('@')[0]}'s firm`],
  );
  const firmId = f[0]!.id;
  await c.query(`INSERT INTO firm_members (firm_id,user_id,role) VALUES ($1,$2,'owner')`, [firmId, userId]);
  return firmId;
}
