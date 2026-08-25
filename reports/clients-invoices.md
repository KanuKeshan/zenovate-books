# Clients & Invoices

## Files written

- `/home/claude/clarabooks/src/routes/clients.ts`
- `/home/claude/clarabooks/src/routes/invoices.ts`
- `/home/claude/clarabooks/test/integration/clients-invoices.test.ts`

No file outside those three was touched. Exports are
`export default async function clientsRoutes(app)` and
`export default async function invoicesRoutes(app)`, both unprefixed.

## Endpoints

### Clients (`src/routes/clients.ts`)

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/businesses/:id/clients` | readonly | `limit` (1–200, default 50), `offset`, `sort=name\|created`; returns `{clients,count,limit,offset}` |
| GET | `/businesses/:id/clients/:clientId` | readonly | |
| POST | `/businesses/:id/clients` | accountant | 201; 409 on duplicate name in the same business |
| PATCH | `/businesses/:id/clients/:clientId` | accountant | rename rewrites invoices; returns `invoicesRenamed` |
| DELETE | `/businesses/:id/clients/:clientId` | owner | 409 if the client has invoices |

### Invoices (`src/routes/invoices.ts`)

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/businesses/:id/invoices` | readonly | `status`, `from`, `to`, `client`, `limit` (1–200, default 50), `offset`, `sort=date\|dateAsc\|ref\|amount` |
| GET | `/businesses/:id/invoices/:invoiceId` | readonly | |
| POST | `/businesses/:id/invoices` | accountant | 201; auto-numbers `INV-n` when no `ref` given; 409 on duplicate ref |
| PATCH | `/businesses/:id/invoices/:invoiceId` | accountant | partial; unspecified fields survive |
| DELETE | `/businesses/:id/invoices/:invoiceId` | owner | |
| GET | `/businesses/:id/aging` | readonly | `asOf` (defaults to today); buckets `current / 1-30 / 31-60 / 61-90 / 90+` |

## Conventions held

- Every handler opens with `const p = await authenticate(req)` then
  `requireBusinessAccess(p, id, <role>)`, and uses only the **returned**
  `businessId`. The raw path param is never used in a query.
- Every nested-resource query carries `business_id=$1 AND id=$2` — including the
  reads inside PATCH/DELETE, the `client_id` lookup, the `nextRef` scan, the
  duplicate-invoice check before a client delete, and the aging aggregate. Four
  tests specifically attempt a cross-tenant read/write/delete with a valid id and
  assert 404 plus an unchanged row.
- All SQL is parameterised. `ORDER BY` comes from a fixed `Record` keyed by a
  zod `enum`, so a caller's string never reaches the statement — `?sort=amount;DROP`
  is a 400. A `client=` filter containing `' OR '1'='1` is matched as a literal.
- Every write runs inside `tx()` and writes its `audit()` row on the same client:
  `client.create/update/delete`, `invoice.create/update/delete`. Each write also
  calls `bumpVersion(c, businessId, body.version ?? null)`, so a caller that sends
  the version it read gets optimistic locking and one that omits it does not.
- Bodies and query strings are zod-validated with `.strict()`; unknown fields are
  a 400.
- Money: `parseMoney()` in (so `($250.00)` and `$1,000.10` parse), `toDecimal()`
  to store, `fromDb()` out. No float arithmetic anywhere.
- Both list endpoints have a hard `LIMIT`, capped at 200 and defaulted to 50.

## Invoice total

`total = amount * (1 + taxRate/100)`, computed in integer cents in
`invoiceTotalCents()` (exported from `invoices.ts`). The rate has four decimal
places in the schema, so it is scaled to an integer first and the whole
computation stays integer:

```ts
const scaled = Math.round(taxRatePercent * 10_000);
const tax = Math.round((amountCents * scaled) / 1_000_000);
return amountCents + tax;
```

Checked cases: `1000.00 @ 8.25% → 1082.50`, `1000.10 @ 8.25% → 1082.61`
(tax 82.508… rounds once), `12345678.91 @ 20% → 14814814.69`,
`(250.00) @ 10% → -275.00`.

The aging report sums `round(amount * (1 + tax_rate/100), 2)` in Postgres
NUMERIC — exact decimal, not float, and rounded per invoice with the same rule —
then converts with `fromDb()`. A test asserts the report agrees with the invoice
endpoint to the cent on a rounding-sensitive amount.

## Decisions worth flagging

- **What counts as AR.** Aging includes `Sent`, `Pending`, `Overdue` and excludes
  `Paid` and `Draft`. A draft has not been sent, so nobody owes it; counting
  drafts would overstate collectible AR. The chosen set is echoed back in the
  response as `statuses` so the caller is never guessing.
- **Age basis.** `asOf - COALESCE(due_date, issue_date)`. An invoice with no
  terms is due on issue; treating it as ageless parks year-old receivables in
  "current" forever.
- **Rename semantics.** `UPDATE invoices SET client_name=$new, client_id=$id
  WHERE business_id=$b AND (client_id=$id OR client_name=$old)` — the id catches
  linked invoices, the old name catches unlinked ones (migrated books are full of
  those). Creating a client also adopts existing invoices that already quote the
  name and have a null `client_id`, so a later rename does not miss exactly the
  rows the user can see on screen.
- **Delete refusal.** A client with invoices returns 409 `conflict` with a
  message naming the client and the count and telling the user to delete or
  reassign the invoices first — deleting would drop the only record of who owed
  the money.
- **Non-uuid nested ids** are turned into 404 before they reach Postgres, so a
  typo is a not-found rather than a 500 from `invalid input syntax for uuid`.

## Tests

`test/integration/clients-invoices.test.ts` — **38 passing, 0 failing.**

```
cd /home/claude/clarabooks && \
  DATABASE_URL='postgres://claude@127.0.0.1:5433/cb_test_2' \
  npx vitest run test/integration/clients-invoices.test.ts
#  Test Files  1 passed (1)
#       Tests  38 passed (38)
```

`npx tsc --noEmit -p tsconfig.json` is clean.

The required tenancy test is `a user with no business_access row > gets 404 from
every clients and invoices endpoint`: it loops all **11** endpoints (both
collections, both items, create/update/delete for each, and aging) with a valid
token for a user holding no `business_access` row, asserting 404 + `not_found`,
that the message leaks no client name, and that nothing was written. Companion
tests cover no-token → 401, readonly → 403 on write, accountant → 403 on delete,
and cross-tenant id reuse.

Coverage groups: tenancy (2), cross-tenant ids (3), roles (2), client CRUD (5),
rename (4), delete-with-invoices (1), totals/money (4), invoice CRUD (5),
listing/filtering/pagination/injection (5), aging (7).

## Could not do / worked around

- **Postgres was down when this task started.** The cluster at `/home/claude/pg`
  had died (stale `postmaster.pid`, unclean shutdown in the log). I restarted it
  as the `claude` user with the same options from `postmaster.opts`
  (`-p 5433 -k /tmp/pgsock -c listen_addresses=127.0.0.1`); it ran automatic
  recovery cleanly and all the `cb_test_*` databases were intact. No data was
  lost, but other agents sharing this cluster should know it restarted at
  08:05 UTC.
- **Schema gap: no payments or amount-paid column.** `invoices` records a
  `status` and nothing else about settlement, so "unpaid" can only mean "status
  is not Paid" and aging cannot handle partial payments — a half-paid invoice
  ages at its full total. Fixing that properly needs a `payments` table (or at
  minimum an `amount_paid NUMERIC(18,2)`) in a future migration. `migrations/`
  is fixed, so this is a documented limitation, not a workaround in code.
- **Schema gap: no line items.** An invoice is a single `amount` plus one
  `tax_rate`, so a mixed-rate invoice cannot be represented and the tax is a
  single rounding on the whole document rather than per line. That matches the
  current front end; it will need an `invoice_lines` table when the UI grows one.
- **Schema gap: no soft delete on invoices.** `DELETE` is a hard delete. The
  audit row preserves ref, client and amount, which is what makes the deletion
  answerable, but the invoice itself is gone.
- **`clients.tax_rate` is not used as a default for new invoices.** An invoice's
  `taxRate` must be supplied explicitly (default 0). Inheriting the client's rate
  silently would change totals on invoices the user did not touch; that belongs
  in the UI as a prefill, not in the API as a hidden default.
