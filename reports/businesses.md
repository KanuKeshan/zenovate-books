# businesses — businesses and access control

## Files written

- `/home/claude/clarabooks/src/routes/businesses.ts` — `export default async function businessesRoutes(app: FastifyInstance): Promise<void>`
- `/home/claude/clarabooks/test/integration/businesses.test.ts`

No file outside those two was touched.

## Endpoints

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/businesses` | authenticated | Businesses reachable through `business_access` only. `limit` (1–200, default 200) and `offset`, both `.strict()`; `ORDER BY b.name, b.id` is a literal. Archived rows excluded. `logo` omitted (up to 2 MB per row). |
| POST | `/businesses` | authenticated | 201. Creates the business, grants the caller `owner`, lazily creates a firm via `firm_members` if they have none, seeds default categories, writes `business.create` — all in one `tx()`. |
| GET | `/businesses/:id` | readonly | Full detail including `version` and the caller's `role`. |
| PATCH | `/businesses/:id` | accountant | Body carries a **required** `version`; `bumpVersion()` runs first so a stale write touches no column. Stale → 409 `stale_write`. Audits `business.update`. |
| DELETE | `/businesses/:id` | owner | Soft delete via `archived_at`, plus a version bump. Optional `?version=` guard. Audits `business.archive`. |
| GET | `/businesses/:id/access` | owner | Grants joined to `users`, `LIMIT 200`. |
| POST | `/businesses/:id/access` | owner | `{ email, role }`. Unknown email → 404 `user_not_found` telling them to sign in once first. Upsert on `(business_id, user_id)`. Last owner cannot be demoted → 409. Audits `business.access.grant` / `.change`. |
| DELETE | `/businesses/:id/access/:userId` | owner | Last owner cannot be removed → 409. Audits `business.access.revoke`. |

### Default categories seeded on create

- asset: `Cash`, `Accounts Receivable`
- liability: `Accounts Payable`, `Employee Reimbursements Payable`
- equity: `Owner's Equity`
- income: `Revenue`, `Consulting`, `Product Sales`, `Interest Income`, `Other Income`
- expense: `Advertising & Marketing`, `Bank Fees`, `Contractors`, `Insurance`, `Meals & Entertainment`, `Office Supplies`, `Professional Fees`, `Rent`, `Software & Subscriptions`, `Travel`, `Utilities`, `Other`

## Conventions honoured

- Every handler opens with `const p = await authenticate(req)`; every business-scoped handler then calls `requireBusinessAccess(p, id, role)` and uses the **returned** `businessId` in all subsequent SQL. The raw path param is never used in a query.
- Nested `business_access` rows are always constrained by `business_id` **and** `user_id` (`user_id::text = $2`, which also makes a malformed uuid a clean 404 rather than a 22P02).
- All SQL parameterised. The only dynamic SQL is the PATCH `SET` list, whose column names come from a static `COLUMNS` map, never from the request. `ORDER BY` is literal everywhere.
- All writes go through `tx()` with an `audit()` row on the same client.
- Bodies and query strings validated with zod, `.strict()` throughout.
- Both access-mutating endpoints take `SELECT id FROM businesses WHERE id=$1 FOR UPDATE` first, so two concurrent demotions cannot both pass the last-owner check.
- No money is involved in this file, so `parseMoney`/`toDecimal`/`fromDb` are not imported.

## Tests

`DATABASE_URL='postgres://claude@127.0.0.1:5433/cb_test_1' npx vitest run test/integration/businesses.test.ts`

**34 passing, 0 failing** (two consecutive clean runs). `npx tsc --noEmit -p tsconfig.json` is clean; the test file also typechecks standalone under the same strict settings (`tsconfig.json` only includes `src/**`).

Coverage includes: access-row-only listing (a same-firm business with no grant is invisible), limit clamping and a 400 above 200, 401 without a token, create → owner + firm + categories + audit row, firm reuse on a second business, detail with version and role, version bump and 409 on stale PATCH with the row provably unchanged, role gates (403 for readonly on PATCH, 403 for accountant on DELETE and on the access list), archive keeping the row and hiding it, grant by email case-insensitively, 404 + "sign in" message for an unknown email, role change, last-owner demote and revoke both 409 with state unchanged, owner stepping down once a second owner exists, and a revoke naming a user whose grant is on a *different* business returning 404 with that other grant intact.

**The required cross-tenant test** is `describe('a user with no business_access row')`: a real, active user with their own firm and business hits all six business-scoped endpoints and gets `404 not_found` from every one, after which the target business's name, `archived_at`, `version` and access-row count are asserted unchanged and their own list still shows only their own business.

## Notes and decisions

- **Access changes do not bump `businesses.version`.** That column is the optimistic lock for the business record and for snapshot saves; bumping it when a bookkeeper is added would reject an unrelated in-flight save with a confusing "someone changed this" error. Access changes are recorded in `audit_log` instead. Flag this if the front end expects otherwise.
- **`logo` is omitted from the list response** and present in the detail response, because 200 × 2 MB data URIs is not a list payload. `shape()` only emits the key when the row actually selected it.
- **No invitation flow.** Granting access to an address nobody has signed in with would let the first person to claim that address at Cognito inherit someone's books, so the endpoint refuses with a 404 that says what to do. This is a deliberate product gap, not an omission.
- `ensureFirm` is duplicated (a small private copy) from `src/routes/snapshot.ts`, which does not export it and which I do not own. Worth hoisting into `src/lib/` in a later pass, by whoever owns that file.

## Schema gaps worked around

None. Everything the spec asked for is expressible against `001_init.sql` as written. Two things are worth recording:

- There is no `business_access` audit or history table, so who-granted-what over time is only reconstructable from `audit_log`. That is adequate but means the retention policy on `audit_log` is now also the retention policy for access history.
- The last-owner rule is enforced in the application, not by a constraint. Postgres cannot express "at least one row with `role='owner'` per `business_id`" as a simple constraint, so the `SELECT … FOR UPDATE` on the parent business row is what makes it safe under concurrency. Any future code path that writes `business_access` must take the same lock or the invariant can be broken from outside this file.
