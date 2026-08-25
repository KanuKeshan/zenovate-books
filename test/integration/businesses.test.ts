import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import businessesRoutes from '../../src/routes/businesses.js';
import { getPool } from '../../src/db/pool.js';
import { setupDb, truncateAll, teardown, makeUser, makeFirm, makeBusiness, call, type TestUser } from '../helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.register(businessesRoutes);
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await app.close();
  await teardown();
});

/** An owner with a business already in place, the common starting point. */
async function ownerWithBusiness(name = 'Acme Ltd'): Promise<{ owner: TestUser; firmId: string; businessId: string }> {
  const owner = await makeUser();
  const firmId = await makeFirm(owner);
  const businessId = await makeBusiness(firmId, { user: owner, role: 'owner' }, name);
  return { owner, firmId, businessId };
}

async function versionOf(businessId: string): Promise<string> {
  const { rows } = await getPool().query<{ version: string }>(
    `SELECT version::text AS version FROM businesses WHERE id = $1`,
    [businessId],
  );
  return rows[0]!.version;
}

describe('GET /businesses', () => {
  it('lists only businesses the caller has an access row for', async () => {
    const { owner, firmId } = await ownerWithBusiness('Mine');
    // Same firm, no access row: firm membership alone must grant nothing.
    await makeBusiness(firmId, undefined, 'Not Mine');
    const res = await call(app, 'GET', '/businesses', { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.businesses.map((b: any) => b.name)).toEqual(['Mine']);
    expect(res.body.businesses[0].role).toBe('owner');
    expect(res.body.businesses[0].version).toBe('1');
  });

  it('returns an empty list for a user with no access anywhere', async () => {
    await ownerWithBusiness();
    const stranger = await makeUser();
    const res = await call(app, 'GET', '/businesses', { token: stranger.token });
    expect(res.status).toBe(200);
    expect(res.body.businesses).toEqual([]);
  });

  it('excludes archived businesses', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    await getPool().query(`UPDATE businesses SET archived_at = now() WHERE id = $1`, [businessId]);
    const res = await call(app, 'GET', '/businesses', { token: owner.token });
    expect(res.body.businesses).toEqual([]);
  });

  it('honours limit and rejects a limit above 200', async () => {
    const owner = await makeUser();
    const firmId = await makeFirm(owner);
    for (const n of ['A', 'B', 'C']) await makeBusiness(firmId, { user: owner, role: 'readonly' }, n);
    const one = await call(app, 'GET', '/businesses?limit=2', { token: owner.token });
    expect(one.body.businesses).toHaveLength(2);
    const tooMany = await call(app, 'GET', '/businesses?limit=500', { token: owner.token });
    expect(tooMany.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await call(app, 'GET', '/businesses');
    expect(res.status).toBe(401);
  });
});

describe('POST /businesses', () => {
  it('creates a business, makes the caller owner, creates a firm and seeds categories', async () => {
    const user = await makeUser();
    const res = await call(app, 'POST', '/businesses', {
      token: user.token,
      body: { name: 'Fresh Books Ltd', type: 'Retail', currency: '£' },
    });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Fresh Books Ltd');
    expect(res.body.type).toBe('Retail');
    expect(res.body.currency).toBe('£');
    expect(res.body.role).toBe('owner');
    expect(res.body.version).toBe('1');

    const id = res.body.id;
    const access = await getPool().query(`SELECT role FROM business_access WHERE business_id=$1 AND user_id=$2`, [
      id,
      user.userId,
    ]);
    expect(access.rows[0]).toEqual({ role: 'owner' });

    const firms = await getPool().query(`SELECT firm_id FROM firm_members WHERE user_id=$1`, [user.userId]);
    expect(firms.rowCount).toBe(1);

    const cats = await getPool().query<{ kind: string; name: string }>(
      `SELECT kind, name FROM categories WHERE business_id=$1 ORDER BY kind, sort`,
      [id],
    );
    const byKind: Record<string, string[]> = {};
    for (const c of cats.rows) (byKind[c.kind] ??= []).push(c.name);
    expect(byKind['asset']).toEqual(['Cash', 'Accounts Receivable']);
    expect(byKind['liability']).toEqual(['Accounts Payable', 'Employee Reimbursements Payable']);
    expect(byKind['equity']).toEqual(["Owner's Equity"]);
    expect(byKind['income']!.length).toBeGreaterThan(0);
    expect(byKind['expense']!.length).toBeGreaterThan(0);
  });

  it('reuses the existing firm on a second business', async () => {
    const user = await makeUser();
    const a = await call(app, 'POST', '/businesses', { token: user.token, body: { name: 'One' } });
    const b = await call(app, 'POST', '/businesses', { token: user.token, body: { name: 'Two' } });
    expect(a.body.firmId).toBe(b.body.firmId);
    const firms = await getPool().query(`SELECT firm_id FROM firm_members WHERE user_id=$1`, [user.userId]);
    expect(firms.rowCount).toBe(1);
  });

  it('writes an audit row in the same transaction', async () => {
    const user = await makeUser();
    const res = await call(app, 'POST', '/businesses', { token: user.token, body: { name: 'Audited' } });
    const rows = await getPool().query(`SELECT action, entity_id, user_id FROM audit_log WHERE business_id=$1`, [
      res.body.id,
    ]);
    expect(rows.rows).toEqual([{ action: 'business.create', entity_id: res.body.id, user_id: user.userId }]);
  });

  it('rejects a nameless body and unknown fields', async () => {
    const user = await makeUser();
    expect((await call(app, 'POST', '/businesses', { token: user.token, body: {} })).status).toBe(400);
    expect(
      (await call(app, 'POST', '/businesses', { token: user.token, body: { name: 'X', sneaky: 1 } })).status,
    ).toBe(400);
    expect(
      (await call(app, 'POST', '/businesses', { token: user.token, body: { name: 'X', dataSource: 'telepathy' } }))
        .status,
    ).toBe(400);
  });

  it('requires authentication', async () => {
    expect((await call(app, 'POST', '/businesses', { body: { name: 'X' } })).status).toBe(401);
  });
});

describe('GET /businesses/:id', () => {
  it('returns the detail with version and the caller role', async () => {
    const { owner, businessId } = await ownerWithBusiness('Detail Co');
    const res = await call(app, 'GET', `/businesses/${businessId}`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(businessId);
    expect(res.body.name).toBe('Detail Co');
    expect(res.body.version).toBe('1');
    expect(res.body.role).toBe('owner');
    expect(res.body).toHaveProperty('logo');
  });

  it('reports the reader role for a read-only grant', async () => {
    const { firmId } = await ownerWithBusiness();
    const reader = await makeUser();
    const businessId = await makeBusiness(firmId, { user: reader, role: 'readonly' }, 'Read Only Co');
    const res = await call(app, 'GET', `/businesses/${businessId}`, { token: reader.token });
    expect(res.body.role).toBe('readonly');
  });

  it('404s on a malformed id rather than erroring', async () => {
    const owner = await makeUser();
    const res = await call(app, 'GET', '/businesses/not-a-uuid', { token: owner.token });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /businesses/:id', () => {
  it('updates the named fields and bumps the version', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const res = await call(app, 'PATCH', `/businesses/${businessId}`, {
      token: owner.token,
      body: { version: '1', name: 'Renamed Ltd', address: '1 High Street' },
    });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed Ltd');
    expect(res.body.address).toBe('1 High Street');
    expect(res.body.version).toBe('2');
    expect(await versionOf(businessId)).toBe('2');
  });

  it('rejects a stale version with 409 and changes nothing', async () => {
    const { owner, businessId } = await ownerWithBusiness('Untouched');
    await call(app, 'PATCH', `/businesses/${businessId}`, { token: owner.token, body: { version: 1, name: 'First' } });
    const stale = await call(app, 'PATCH', `/businesses/${businessId}`, {
      token: owner.token,
      body: { version: 1, name: 'Second' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale_write');
    const { rows } = await getPool().query(`SELECT name FROM businesses WHERE id=$1`, [businessId]);
    expect(rows[0]).toEqual({ name: 'First' });
  });

  it('requires a version and at least one field', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    expect(
      (await call(app, 'PATCH', `/businesses/${businessId}`, { token: owner.token, body: { name: 'X' } })).status,
    ).toBe(400);
    expect(
      (await call(app, 'PATCH', `/businesses/${businessId}`, { token: owner.token, body: { version: '1' } })).status,
    ).toBe(400);
    expect(
      (await call(app, 'PATCH', `/businesses/${businessId}`, { token: owner.token, body: { version: '1', nope: 1 } }))
        .status,
    ).toBe(400);
  });

  it('lets an accountant write but not a read-only user', async () => {
    const { firmId } = await ownerWithBusiness();
    const acct = await makeUser();
    const reader = await makeUser();
    const businessId = await makeBusiness(firmId, { user: acct, role: 'accountant' }, 'Shared Co');
    await getPool().query(`INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'readonly')`, [
      businessId,
      reader.userId,
    ]);
    const ok = await call(app, 'PATCH', `/businesses/${businessId}`, {
      token: acct.token,
      body: { version: '1', name: 'By Accountant' },
    });
    expect(ok.status).toBe(200);
    const denied = await call(app, 'PATCH', `/businesses/${businessId}`, {
      token: reader.token,
      body: { version: '2', name: 'By Reader' },
    });
    expect(denied.status).toBe(403);
  });

  it('audits the update', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    await call(app, 'PATCH', `/businesses/${businessId}`, { token: owner.token, body: { version: '1', color: '#111' } });
    const { rows } = await getPool().query(
      `SELECT action FROM audit_log WHERE business_id=$1 AND action='business.update'`,
      [businessId],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('DELETE /businesses/:id', () => {
  it('archives the business, owner only', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const res = await call(app, 'DELETE', `/businesses/${businessId}`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);

    const { rows } = await getPool().query(`SELECT archived_at FROM businesses WHERE id=$1`, [businessId]);
    expect(rows[0]!.archived_at).not.toBeNull();
    // Archived is invisible, not deleted.
    expect((await call(app, 'GET', `/businesses/${businessId}`, { token: owner.token })).status).toBe(404);
    const { rows: still } = await getPool().query(`SELECT count(*)::int AS n FROM businesses WHERE id=$1`, [businessId]);
    expect(still[0]!.n).toBe(1);
  });

  it('refuses an accountant', async () => {
    const { firmId } = await ownerWithBusiness();
    const acct = await makeUser();
    const businessId = await makeBusiness(firmId, { user: acct, role: 'accountant' }, 'No Delete Co');
    const res = await call(app, 'DELETE', `/businesses/${businessId}`, { token: acct.token });
    expect(res.status).toBe(403);
  });

  it('honours an optional version guard', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const stale = await call(app, 'DELETE', `/businesses/${businessId}?version=99`, { token: owner.token });
    expect(stale.status).toBe(409);
    const ok = await call(app, 'DELETE', `/businesses/${businessId}?version=1`, { token: owner.token });
    expect(ok.status).toBe(200);
  });
});

describe('GET /businesses/:id/access', () => {
  it('lists the grants for an owner', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const mate = await makeUser('mate@example.test');
    await getPool().query(`INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'accountant')`, [
      businessId,
      mate.userId,
    ]);
    const res = await call(app, 'GET', `/businesses/${businessId}/access`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.access).toHaveLength(2);
    const byEmail = Object.fromEntries(res.body.access.map((a: any) => [a.email, a.role]));
    expect(byEmail[owner.email]).toBe('owner');
    expect(byEmail['mate@example.test']).toBe('accountant');
  });

  it('refuses anyone below owner', async () => {
    const { businessId } = await ownerWithBusiness();
    const acct = await makeUser();
    await getPool().query(`INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'accountant')`, [
      businessId,
      acct.userId,
    ]);
    const res = await call(app, 'GET', `/businesses/${businessId}/access`, { token: acct.token });
    expect(res.status).toBe(403);
  });
});

describe('POST /businesses/:id/access', () => {
  it('grants access by email, case-insensitively', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const mate = await makeUser('Bookkeeper@example.test');
    const res = await call(app, 'POST', `/businesses/${businessId}/access`, {
      token: owner.token,
      body: { email: 'bookkeeper@EXAMPLE.test', role: 'accountant' },
    });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(mate.userId);
    expect(res.body.role).toBe('accountant');

    const seen = await call(app, 'GET', '/businesses', { token: mate.token });
    expect(seen.body.businesses).toHaveLength(1);

    const { rows } = await getPool().query(
      `SELECT granted_by FROM business_access WHERE business_id=$1 AND user_id=$2`,
      [businessId, mate.userId],
    );
    expect(rows[0]!.granted_by).toBe(owner.userId);
  });

  it('404s with an explanation when nobody has signed in with that email', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const res = await call(app, 'POST', `/businesses/${businessId}/access`, {
      token: owner.token,
      body: { email: 'ghost@example.test', role: 'readonly' },
    });
    expect(res.status).toBe(404);
    expect(String(res.body.message)).toMatch(/sign in/i);
  });

  it('changes an existing role', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const mate = await makeUser('mate2@example.test');
    await call(app, 'POST', `/businesses/${businessId}/access`, {
      token: owner.token,
      body: { email: mate.email, role: 'readonly' },
    });
    const res = await call(app, 'POST', `/businesses/${businessId}/access`, {
      token: owner.token,
      body: { email: mate.email, role: 'owner' },
    });
    expect(res.status).toBe(200);
    expect(res.body.previousRole).toBe('readonly');
    const { rows } = await getPool().query(`SELECT role FROM business_access WHERE business_id=$1 AND user_id=$2`, [
      businessId,
      mate.userId,
    ]);
    expect(rows[0]).toEqual({ role: 'owner' });
  });

  it('refuses to demote the last owner, but allows it once there are two', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const demote = await call(app, 'POST', `/businesses/${businessId}/access`, {
      token: owner.token,
      body: { email: owner.email, role: 'accountant' },
    });
    expect(demote.status).toBe(409);
    const { rows } = await getPool().query(`SELECT role FROM business_access WHERE business_id=$1 AND user_id=$2`, [
      businessId,
      owner.userId,
    ]);
    expect(rows[0]).toEqual({ role: 'owner' });

    const second = await makeUser('second-owner@example.test');
    await call(app, 'POST', `/businesses/${businessId}/access`, {
      token: owner.token,
      body: { email: second.email, role: 'owner' },
    });
    const ok = await call(app, 'POST', `/businesses/${businessId}/access`, {
      token: owner.token,
      body: { email: owner.email, role: 'accountant' },
    });
    expect(ok.status).toBe(200);
  });

  it('refuses a bad role and unknown fields, and refuses a non-owner', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    expect(
      (await call(app, 'POST', `/businesses/${businessId}/access`, {
        token: owner.token,
        body: { email: owner.email, role: 'superuser' },
      })).status,
    ).toBe(400);
    expect(
      (await call(app, 'POST', `/businesses/${businessId}/access`, {
        token: owner.token,
        body: { email: owner.email, role: 'owner', extra: true },
      })).status,
    ).toBe(400);

    const acct = await makeUser();
    await getPool().query(`INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'accountant')`, [
      businessId,
      acct.userId,
    ]);
    expect(
      (await call(app, 'POST', `/businesses/${businessId}/access`, {
        token: acct.token,
        body: { email: acct.email, role: 'owner' },
      })).status,
    ).toBe(403);
  });
});

describe('DELETE /businesses/:id/access/:userId', () => {
  it('revokes a grant and audits it', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const mate = await makeUser();
    await getPool().query(`INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'accountant')`, [
      businessId,
      mate.userId,
    ]);
    const res = await call(app, 'DELETE', `/businesses/${businessId}/access/${mate.userId}`, { token: owner.token });
    expect(res.status).toBe(200);
    expect(res.body.previousRole).toBe('accountant');
    expect((await call(app, 'GET', `/businesses/${businessId}`, { token: mate.token })).status).toBe(404);
    const { rows } = await getPool().query(
      `SELECT action FROM audit_log WHERE business_id=$1 AND action='business.access.revoke'`,
      [businessId],
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses to remove the last owner', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const res = await call(app, 'DELETE', `/businesses/${businessId}/access/${owner.userId}`, { token: owner.token });
    expect(res.status).toBe(409);
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM business_access WHERE business_id=$1`, [
      businessId,
    ]);
    expect(rows[0]!.n).toBe(1);
  });

  it('lets an owner step down once another owner exists', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const second = await makeUser();
    await getPool().query(`INSERT INTO business_access (business_id,user_id,role) VALUES ($1,$2,'owner')`, [
      businessId,
      second.userId,
    ]);
    const res = await call(app, 'DELETE', `/businesses/${businessId}/access/${owner.userId}`, { token: owner.token });
    expect(res.status).toBe(200);
  });

  it('404s for a user whose grant is on a different business', async () => {
    const { owner, businessId } = await ownerWithBusiness('Business A');
    const other = await ownerWithBusiness('Business B');
    // A real user with a real grant — just not on this business. Without the
    // business_id constraint in the WHERE clause this would revoke it anyway.
    const res = await call(app, 'DELETE', `/businesses/${businessId}/access/${other.owner.userId}`, {
      token: owner.token,
    });
    expect(res.status).toBe(404);
    const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM business_access WHERE business_id=$1`, [
      other.businessId,
    ]);
    expect(rows[0]!.n).toBe(1);
  });

  it('404s on a malformed user id', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const res = await call(app, 'DELETE', `/businesses/${businessId}/access/not-a-uuid`, { token: owner.token });
    expect(res.status).toBe(404);
  });
});

/**
 * The cross-tenant gate. A signed-in user with no business_access row must be
 * unable to tell a business they cannot see from one that does not exist.
 */
describe('a user with no business_access row', () => {
  it('gets 404 from every endpoint that names a business', async () => {
    const { owner, businessId } = await ownerWithBusiness();
    const stranger = await makeUser('stranger@example.test');
    // The stranger has their own firm and business, so they are a real, active
    // user — the only thing missing is a grant on this one.
    const ownFirm = await makeFirm(stranger, "Stranger's Firm");
    await makeBusiness(ownFirm, { user: stranger, role: 'owner' }, 'Stranger Co');

    const attempts: [Parameters<typeof call>[1], string, unknown?][] = [
      ['GET', `/businesses/${businessId}`],
      ['PATCH', `/businesses/${businessId}`, { version: '1', name: 'Hijacked' }],
      ['DELETE', `/businesses/${businessId}`],
      ['GET', `/businesses/${businessId}/access`],
      ['POST', `/businesses/${businessId}/access`, { email: 'stranger@example.test', role: 'owner' }],
      ['DELETE', `/businesses/${businessId}/access/${owner.userId}`],
    ];
    for (const [method, url, body] of attempts) {
      const res = await call(app, method, url, { token: stranger.token, ...(body ? { body } : {}) });
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.body.error, `${method} ${url}`).toBe('not_found');
    }

    // And nothing was touched.
    const { rows } = await getPool().query(`SELECT name, archived_at, version::text AS version FROM businesses WHERE id=$1`, [
      businessId,
    ]);
    expect(rows[0]).toEqual({ name: 'Acme Ltd', archived_at: null, version: '1' });
    const { rows: access } = await getPool().query(`SELECT count(*)::int AS n FROM business_access WHERE business_id=$1`, [
      businessId,
    ]);
    expect(access[0]!.n).toBe(1);
    // The stranger's own list still shows only their own business.
    const list = await call(app, 'GET', '/businesses', { token: stranger.token });
    expect(list.body.businesses.map((b: any) => b.name)).toEqual(['Stranger Co']);
  });
});
