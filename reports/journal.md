# Journal & balances

## Files written

- `/home/claude/clarabooks/src/routes/journal.ts` — `journalRoutes`
- `/home/claude/clarabooks/src/routes/balances.ts` — `balancesRoutes`
- `/home/claude/clarabooks/test/integration/journal.test.ts`

No file owned by anyone else was touched.

## Endpoints

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/businesses/:id/journal` | readonly | filters `from`, `to`, `type`, `account`; `sort=date\|dateAsc\|ref`; `limit` 1–200 (default 50), `offset`; returns `count` from `count(*) OVER()` |
| GET | `/businesses/:id/journal/:entryId` | readonly | 404 for a non-uuid or an entry in another business |
| POST | `/businesses/:id/journal` | accountant | 201; auto `JE-n` ref when none given; 409 on duplicate ref within the business; optimistic `version` |
| DELETE | `/businesses/:id/journal/:entryId` | owner | lines go by `ON DELETE CASCADE` |
| GET | `/businesses/:id/opening-balance` | readonly | `{ openingBalance: null }` when unset |
| PUT | `/businesses/:id/opening-balance` | accountant | upsert on the `business_id` primary key (one per business) |
| DELETE | `/businesses/:id/opening-balance` | owner | 404 when there is nothing to clear |
| GET | `/businesses/:id/balance-sheet?asOf=YYYY-MM-DD` | readonly | `asOf` optional; response carries `balanced` and `difference` |

Conventions held: `authenticate` first on every handler, `requireBusinessAccess` returning the
business id used in every later query, every nested query constrained by `business_id` as well as
its own id, parameterised SQL throughout (sort keys map to fixed SQL; the categories `LIMIT` is a
bound parameter), all writes in `tx()` with an `audit()` row in the same transaction
(`journal.create`, `journal.delete`, `openingBalance.save`, `openingBalance.delete`), zod `.strict()`
on bodies and query strings, and `parseMoney`/`toDecimal`/`fromDb` for every amount.

### POST /journal validation

- Each line is debit XOR credit: both sides → `Line N on "Account" has both a debit and a credit;
  a line is one side or the other.`; neither → `…has neither a debit nor a credit.`; a negative
  amount is refused with a message naming the line.
- Unbalanced entries state **both** totals and the gap:
  `That entry does not balance: debits total 800.00 against credits total 750.00, a difference of 50.00.`
  Nothing is written — the whole entry rolls back with its lines.
- Minimum two lines, maximum 500.

### Balance sheet arithmetic (mirrors `computeBalanceSheet` in `web/index.html`)

```
cash  = opening.cash + paid invoice totals − all expenses + JE asset 'Cash'
ar    = unpaid invoice totals + opening.ar + JE asset 'Accounts Receivable'
ap    = opening.ap + JE liability 'Accounts Payable'
retainedEarnings   = (all invoice totals − all expenses) + (JE income − JE expense)
openingEquityPlug  = opening.cash + opening.ar − opening.ap   (only when as_of <= asOf)
ownersEquity       = JE equity "Owner's Equity"
other{Assets,Liabilities,Equity} = accounts in `categories` for this business and kind,
                                   excluding Cash / Accounts Receivable / Accounts Payable /
                                   Owner's Equity, valued at their JE normal balance
```

Invoice totals are `round(amount * (1 + tax_rate/100), 2)` summed in SQL — the same rounding the
aging report uses, so the two reports tie to the cent. "Unpaid" is `status <> 'Paid'`, drafts
included, exactly as the front end has it: a draft's total is already in Retained Earnings via
all-invoice income, so excluding it from AR would put the sheet out by its amount.

## Tests

`DATABASE_URL='postgres://claude@127.0.0.1:5433/cb_test_4' npx vitest run test/integration/journal.test.ts`

**29 passing, 0 failing.** `npx tsc --noEmit -p tsconfig.json` is clean.

Coverage includes: the required no-`business_access` test (404 + `not_found` on all nine
journal/opening-balance/balance-sheet routes, with a follow-up assertion that nothing was written
or deleted on the way past), unauthenticated 401, the cross-tenant case (a well-formed entry id
from business A returns 404 through business B even for a user who owns both, for read and for
delete), per-role gates for read/post/delete on both resources, ref auto-numbering and per-business
uniqueness, stale-version 409, list filters/sort/paging/limit cap and rejected query keys, the
worked-set balance sheet asserted line by line with `assets == liabilities + equity` to the cent,
the same at an `asOf` cut-off, an opening balance dated after the `asOf`, and the unbalanced case
below.

## Schema gaps worked around

- **No chart-of-accounts write path.** `categories` rows are only ever created by
  `PUT /businesses/:id/snapshot`, which I do not own, and the spec restricts `otherAssets` /
  `otherLiabilities` / `otherEquity` to accounts present in `categories`. The tests therefore seed
  `categories` with direct SQL. A journal line naming an account that is not in the table
  contributes to no balance-sheet row, so the sheet legitimately does not balance; rather than hide
  that, the response carries `balanced: false` and a signed `difference`, and a test asserts it.
  If a categories endpoint lands later, nothing here needs to change.
- **`opening_balances` is one row per business** (`business_id` is the primary key), so PUT is an
  upsert; there is no history of prior cutovers to expose.
- **No line-level update.** The schema has no soft-delete or revision on `journal_entries`, and an
  edited entry is a different entry in every accounting sense, so there is no PATCH: callers delete
  and re-post. The spec asked for GET/POST/DELETE only.
- **No `entry_type` vocabulary in the schema** — `type` is free text up to 60 chars, filtered
  exactly rather than fuzzily on list.
