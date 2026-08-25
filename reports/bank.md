# bank — bank transactions and the statement importer

## Files written

- `/home/claude/clarabooks/src/routes/bank.ts` — `export default async function bankRoutes(app: FastifyInstance): Promise<void>`
- `/home/claude/clarabooks/test/integration/bank.test.ts`

No file owned by anyone else was touched.

## Endpoints

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/businesses/:id/bank` | readonly | Paginated list. `from`, `to`, `category`, `q`, `matched`, `posted`, `limit` (default 50, max 200), `offset`, `sort` (`date`, `dateAsc`, `amount`, `created`). Returns `{ transactions, count, limit, offset, pageTotal }`. |
| GET | `/businesses/:id/bank/:txnId` | readonly | `{ transaction }`. |
| POST | `/businesses/:id/bank` | accountant | 201 `{ transaction }`. |
| PATCH | `/businesses/:id/bank/:txnId` | accountant | Partial update; recomputes the fingerprint when date/amount/description change. |
| DELETE | `/businesses/:id/bank/:txnId` | owner | Destructive, so owner only. `{ ok: true }`. |
| POST | `/businesses/:id/bank/import` | accountant | `{ transactions: [{date, description, amount, balance?}], source?, version? }` → `{ imported, skipped, total, version }`. |

Wire shape for a transaction: `{ id, date, desc, amount, balance, cat, matched, posted, source, createdAt }`.
Money is always a decimal string (`parseMoney` in, `toDecimal` to store, `fromDb` out) — no float
arithmetic anywhere, including `pageTotal`, which is summed in cents.

## Dedupe

Fingerprint is `[date, amountCents, description.toLowerCase().replace(/\s+/g,' ').trim().slice(0,120)].join('|')`
— byte-identical to the one `src/routes/snapshot.ts` already uses, so the two write paths agree on
what "the same line" means. The business is part of uniqueness through the schema's existing
`UNIQUE (business_id, dedupe_key)`, so two firms importing the same statement never collide.

The skip is done by `ON CONFLICT (business_id, dedupe_key) DO NOTHING` rather than a pre-read, so
two concurrent imports cannot both conclude a row is new. That also makes rows repeated *within* one
payload collapse (Postgres detects speculative conflicts against rows inserted earlier in the same
statement — verified, and covered by a test).

Import writes in batches of 500 rows per INSERT (placeholders generated from the row count, never
from caller input) so a 10,000-line file is 20 round trips rather than 10,000. Cap is 10,000 rows
per call; the whole file is parsed before anything is written, so one unreadable amount rejects the
file instead of importing the rows either side of it.

A **hand-created** duplicate is deliberately kept rather than swallowed: a colliding POST/PATCH takes
`key#2`, leaving the base key with the first row so the importer still matches it. The dedupe
requirement in the spec is attached to the importer; a person typing the same coffee twice means it.

## Security posture

- Every handler opens with `const p = await authenticate(req)` then
  `const { businessId } = await requireBusinessAccess(p, id, '<role>')`, and uses the **returned**
  `businessId`. The raw path param is never used in a query.
- Every nested query is constrained by `business_id` **and** `id` — including the PATCH and DELETE
  `WHERE` clauses and the pre-read inside the transaction. A cross-tenant test asserts a valid txn id
  from business B is 404 on read, patch and delete through business A's path, and that B's row is
  untouched afterwards.
- All SQL is parameterised. `ORDER BY` comes from a fixed `SORT_SQL` lookup keyed by a zod enum.
  Description search uses `position(lower($n) in lower(description))` so `%` and `_` are literals with
  nothing to escape (tested).
- All writes go through `tx()`, bump the business version (optimistic locking, 409 `stale_write`) and
  write an `audit()` row on the same client — `bank.create`, `bank.update`, `bank.delete`,
  `bank.import`. Rollback of both is asserted by the stale-version tests.
- Bodies and query strings are zod `.strict()`; unknown fields are 400.

## Tests

`DATABASE_URL='postgres://claude@127.0.0.1:5433/cb_test_5' npx vitest run test/integration/bank.test.ts`

**40 passing, 0 failing.** Typecheck (`npx tsc --noEmit -p tsconfig.json`) is clean across the whole repo.

Coverage includes:
- A user with **no `business_access` row gets 404 from all six endpoints** (list, read, create, patch,
  delete, import) and nothing they attempted took effect; no token at all is 401.
- Cross-tenant read/patch/delete of another business's txn id → 404.
- The same fingerprint in two different businesses imports into both.
- Roles: readonly reads but cannot write or import (403); accountant writes and imports but cannot
  delete (403 `insufficient_role`).
- **Re-posting the identical payload imports 0 the second and third time** (3/0, then 0/3, then 0/3),
  plus overlapping ranges, case/whitespace-normalised descriptions, rows repeated within one payload,
  and a 600-row file that crosses the batch boundary and re-imports as 1 new / 600 skipped.
- Date, amount and description each being different makes a different line.
- Delete frees the fingerprint so the line imports again; PATCH moves the fingerprint with the row.
- Pagination (default 50, `limit=201` → 400, `limit=0` → 400, offset, both sort directions), filters,
  inverted range → 400, unknown query param → 400.
- Money exactness: `-84.31`/`5115.69` round-trip verbatim; ten `0.10` rows total `1.00`.
- Audit rows and their detail; version bump; stale version → 409 with the write rolled back.
- Malformed bodies, unknown fields, bad amounts, over-cap import (10,001 rows) → 400.

## Schema gaps worked around

None. `bank_txns` already carries `dedupe_key` with `UNIQUE (business_id, dedupe_key)` and an index on
`(business_id, txn_date)`, which is exactly what the importer and the list endpoint need. Two things
worth noting rather than working around:

- `bank_txns` has no `updated_at`, so the wire shape exposes `createdAt` only; PATCH does not pretend
  to report a modification time it cannot store.
- `category` is free text with no FK to `categories`, so a bank category is not validated against the
  chart of accounts. That is the schema's choice (statement categories are suggestions until posted);
  if the categories owner wants it enforced it needs a migration, not a route change.
