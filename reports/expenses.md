# Expenses, chart of accounts and P&L

## Files written

- `/home/claude/clarabooks/src/routes/expenses.ts` — expense CRUD plus the P&L report.
- `/home/claude/clarabooks/src/routes/categories.ts` — chart of accounts.
- `/home/claude/clarabooks/test/integration/expenses.test.ts` — integration tests for both.

No file outside those three was touched.

## Endpoints

### Expenses (`expensesRoutes`)

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/businesses/:id/expenses` | readonly | Filters `?from=&to=&category=&vendor=&deductible=`, paging `?limit=&offset=` (default 50, max 200), `?sort=date\|dateAsc\|amount\|vendor`. Returns `{ expenses, count, limit, offset, pageTotal }`. |
| GET | `/businesses/:id/expenses/:expenseId` | readonly | |
| POST | `/businesses/:id/expenses` | accountant | 201. |
| PATCH | `/businesses/:id/expenses/:expenseId` | accountant | Partial; unset fields keep their prior value. |
| DELETE | `/businesses/:id/expenses/:expenseId` | owner | Destructive. |
| GET | `/businesses/:id/pl` | readonly | `?from=&to=` (both optional). |

`GET /pl` returns `{ from, to, revenueStatuses, revenue: { total, count, byCategory[] }, expenses: { total, count, byCategory[] }, net }`. Every amount is a decimal string (`"1750.50"`).

Revenue is invoices with status `Paid` or `Sent` whose `issue_date` falls in the range, summed on `amount` **excluding** `tax_rate` — sales tax collected is a liability held for the revenue authority, not income. Expenses are grouped by `category`. `net = revenue − expenses`. Both sides are summed as NUMERIC in Postgres and converted once through `fromDb`/`toDecimal`, so no float arithmetic touches a figure.

### Categories (`categoriesRoutes`)

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/businesses/:id/categories` | readonly | `?kind=` filter, `?limit=` (default and max 200), `?offset=`. Returns the flat list, a `byKind` map, and per-category `usedBy: { expenses, invoices }` / `inUse`. |
| POST | `/businesses/:id/categories` | accountant | 201; duplicate `(kind, name)` → **409 `conflict`**, never a 500. |
| DELETE | `/businesses/:id/categories/:categoryId` | owner | Refused with 409 while referenced, naming the counts. |

Delete refusal message, e.g.: `"Software" is still used by 2 expenses and 1 invoice. Move them to another category first, then delete this one.`

## Conventions honoured

- Every handler opens with `const p = await authenticate(req)` followed by `requireBusinessAccess(p, id, <role>)`; only the **returned** `businessId` reaches SQL.
- Every nested-resource query carries `business_id=$1 AND id=$2` — read, update and delete alike. Tests assert an id from another business 404s through a business the caller *can* reach.
- All SQL is parameterised. `sort` is a zod enum mapped to a fixed `SORT_SQL` table, so nothing user-supplied is ever interpolated — a test fires `sort=amount; DROP TABLE expenses` and asserts 400 with the table intact.
- Writes run inside `tx()`, call `bumpVersion` (honouring an optional `version` for optimistic locking → 409 `stale_write`), and write their `audit()` row on the same client.
- Bodies and query strings are zod `.strict()`; an unknown field or parameter is a 400.
- Money in through `parseMoney` (accepts `1234.56`, `$1,234.56`, `(25.00)` for negatives), stored via `toDecimal`, returned via `fromDb`/`toDecimal` as decimal strings.
- Both list endpoints are bounded at 200.

## Test counts

`DATABASE_URL='postgres://claude@127.0.0.1:5433/cb_test_3' npx vitest run test/integration/expenses.test.ts`

- **37 passing, 0 failing** (1 file).
- `npx tsc --noEmit -p tsconfig.json` — clean, no errors in any file.

Coverage includes: the no-`business_access` stranger getting **404 on all ten** expenses/categories/P&L endpoints (plus 401 unauthenticated); cross-tenant expense and category ids; role gates (readonly reads only, accountant writes but cannot delete); CRUD and partial patch; money parsing and decimal-string output; validation 400s; paging, full count and the 200 cap; category duplicate 409 and same-name-different-kind allowance; delete refusal naming the count for expenses and for invoices, and the delete succeeding once the last reference moves; per-business scoping of the reference count; audit rows for create and delete; and the P&L's status filter, range filter, empty books, tax exclusion and cent-exact addition.

Invoices are seeded with direct SQL in the P&L tests rather than through the invoice API, so this suite registers only its own two plugins as required.

## Schema gaps worked around

1. **Categories are not referenced by foreign key.** `expenses.category` and `invoices.category` are free `TEXT`; only `categories(business_id, kind, name)` is unique. So "still referenced" cannot be a FK constraint — it is a count of rows in the same business whose `category` spells the name, matched with `lower()` on both sides so `Software` and `software` are treated as one heading. Consequence: a name shared across kinds (an `income` "Software" and an `expense` "Software") is pinned open by either side's rows. That is the conservative direction — it refuses a delete that might orphan rows rather than allowing one that would.
2. **No `expenses.ref`.** Unlike invoices there is no human-facing expense number, so expenses are addressed by UUID. `readSnapshot` in `snapshot.ts` synthesises positional `EXP-n` ids for the front end; those are not stable and are deliberately not used here.
3. **P&L is invoice-basis, not journal-basis.** `journal_entries` exists but the front end's books are driven by invoices and expenses, so the report is built from those. Once journals are authoritative this endpoint should be revisited rather than extended.

## Not done

Nothing in the spec was left out. `PATCH /categories/:categoryId` was not implemented — the spec asks for GET/POST/DELETE only, and renaming a category without rewriting every row that spells its old name would silently orphan them given gap 1 above.
