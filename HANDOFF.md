# ClaraBooks — handoff

A multi-business accounting application. The front end is a single 11,800-line
HTML file; the back end is a Fastify + TypeScript + PostgreSQL API. This document
is the state of it, honestly.

## Run it locally

```bash
npm install

# PostgreSQL 16 must be running. Create two databases:
createdb clarabooks
createdb clarabooks_test

cp .env.example .env          # then edit DATABASE_URL
npm run migrate
DEV_AUTH_SECRET=local-only npm run dev
```

Open http://localhost:8080. With `DEV_AUTH_SECRET` set and `NODE_ENV` not
`production`, sign-in accepts any email without a password. That path is disabled
two independent ways in production: `devAuthEnabled()` returns false when
`NODE_ENV=production`, and `assertProductionAuthSane()` makes the server refuse
to boot if the secret is set there at all.

## Gates, and what each one actually proves

```bash
npm run typecheck                                   # clean
DATABASE_URL=...clarabooks_test npm test            # 178 integration tests, real Postgres
bash scripts/e2e.sh                                 # 25 end-to-end, real browser + API + DB
```

The integration suite exercises the API against a real database — not a mock.
The end-to-end journey drives the actual UI in Chromium against the running
server: sign in, create a business, save a full set of books, wipe localStorage,
reload, and confirm the books come back from the database. It is the only gate
that fails when the product is broken rather than when the code is.

## Architecture, and the one decision that shaped everything

The front end already funnelled every read and write through four functions
(`loadMeta`, `saveMeta`, `loadBizData`, `saveBizData`) which in turn called a
small surface named `window.CB_FIREBASE`. Rather than rewrite 11,800 lines to
speak REST, that one module block was replaced with an API-backed adapter
exposing the identical surface. Every existing call site works untouched.

- **Core entities** (businesses, users, access, clients, invoices, expenses,
  journal entries and lines, bank transactions, opening balances, categories)
  are real Postgres tables with foreign keys and constraints.
- **Deferred features** (payroll, reimbursements, FP&A settings, statement data,
  checklists) ride in a JSONB `extras` column, so nothing in the app breaks
  while they wait for a proper schema.
- `src/routes/snapshot.ts` projects between the two shapes. It is the bridge.

### Rules the code holds to

- **Money is never a float.** `NUMERIC(18,2)` in the database, integer cents in
  memory, decimal strings on the wire. See `src/lib/money.ts`.
- **One authorization choke point.** `requireBusinessAccess()` returns the
  business id; handlers use the returned value, never the path parameter. A
  route cannot skip the check because it has no usable id until it runs.
- **Unauthorised reads answer 404, not 403.** "Forbidden" confirms a record
  exists, which across an API is enough to enumerate another firm's client list.
- **Access comes from `business_access` alone.** Firm membership grants nothing,
  so adding a bookkeeper for one client cannot expose the others.
- **Optimistic locking** via `businesses.version` — a stale write is rejected,
  not silently applied over someone else's change.
- **Passwords never touch this server.** Cognito hosted UI with PKCE; the
  refresh token returns only as an httpOnly cookie.

## What is NOT done

1. **QuickBooks import endpoint** (`POST /workspace/import`). The browser-side
   migration is complete and tested; the server endpoint that receives a backup
   export is not written.
2. **Observability endpoints and status page.** `src/lib/metrics.ts` already
   emits CloudWatch Embedded Metric Format and keeps a RED window in memory.
   `/health`, `/status` and `web/status.html` are not written. **`/health` does
   not exist yet, so the ALB health check in any infra will fail until it does.**
3. **Terraform and Dockerfile.** Not written. Target was ECS Fargate + RDS + ALB
   + Cognito + S3 in us-east-1.
4. **Adversarial security pass.** Not run. The code follows the rules above and
   the integration tests cover the obvious cross-tenant cases, but nobody has
   actively tried to break it.
5. **The original 1,150 browser assertions are LOST.** They covered the
   accounting engine, the statement importer, the QuickBooks migration and the
   FP&A module. They lived in an ephemeral sandbox that was reclaimed. The code
   they tested is intact and unchanged; the tests are gone. This is the largest
   gap and the reason to move to a machine with a git repository.

## Known rough edges

- Charts emit `NaN` SVG attribute warnings when rendered before data arrives.
  Cosmetic, but it is noise in the console that will hide a real error one day.
- `DbLatency` is always 0 in the metric line — the per-request database timer is
  emitted but never populated.
- `disableRequestLogging` is deprecated in Fastify 5 and removed in 6.
- `escH()` in the front end does not escape single quotes. Flagged repeatedly,
  never fixed. It matters more now that data crosses a network.

## Deploying

Nothing has been deployed. Whoever does it needs to: create the AWS account,
write or generate the Terraform, `terraform apply` with their own credentials,
create the first two Cognito users by hand (self-signup is deliberately
disabled), and then use the in-app backup export to import existing data.
