import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { HttpError, noAccess } from './errors.js';
import type { Principal } from './auth.js';

export type Role = 'owner' | 'accountant' | 'readonly';

/** Ordered weakest to strongest so comparisons are a number, not a lookup table. */
const RANK: Record<Role, number> = { readonly: 1, accountant: 2, owner: 3 };

export function atLeast(have: Role, need: Role): boolean {
  return RANK[have] >= RANK[need];
}

/**
 * THE authorization choke point.
 *
 * Every route that touches a business calls this and uses the business id it
 * RETURNS, never the one it was handed. That is the whole discipline: a route
 * cannot accidentally read the path parameter directly and skip the check,
 * because it does not have a usable id until this has run.
 *
 * Access comes from business_access alone. Firm membership grants nothing on its
 * own, so adding a bookkeeper for one client cannot silently expose the others.
 */
export async function requireBusinessAccess(
  principal: Principal,
  businessId: string,
  need: Role = 'readonly',
  client?: PoolClient,
): Promise<{ businessId: string; role: Role; version: string }> {
  if (!isUuid(businessId)) throw noAccess();
  const q = client ?? getPool();
  const { rows } = await q.query<{ role: Role; version: string }>(
    `SELECT ba.role, b.version::text AS version
       FROM business_access ba
       JOIN businesses b ON b.id = ba.business_id
      WHERE ba.business_id = $1
        AND ba.user_id = $2
        AND b.archived_at IS NULL`,
    [businessId, principal.userId],
  );
  const row = rows[0];
  // No row covers both "not yours" and "does not exist", and both answer 404.
  if (!row) throw noAccess();
  if (!atLeast(row.role, need)) {
    throw new HttpError(403, 'insufficient_role', `This action needs ${need} access; you have ${row.role}.`);
  }
  return { businessId, role: row.role, version: row.version };
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

/**
 * Bumps the business version, asserting the caller saw the current one.
 *
 * Two people editing the same client at once is the normal case for a firm of
 * two, not an edge case. Without this the second save wins silently and the
 * first person's change is gone with nothing to show it ever existed.
 */
export async function bumpVersion(client: PoolClient, businessId: string, expected?: string | null): Promise<string> {
  const { rows } = await client.query<{ version: string }>(
    `UPDATE businesses
        SET version = version + 1, updated_at = now()
      WHERE id = $1
        AND ($2::bigint IS NULL OR version = $2::bigint)
      RETURNING version::text AS version`,
    [businessId, expected ?? null],
  );
  const row = rows[0];
  if (!row) {
    const { staleWrite } = await import('./errors.js');
    throw staleWrite();
  }
  return row.version;
}
