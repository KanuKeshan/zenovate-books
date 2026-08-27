import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createHmac, timingSafeEqual, scryptSync } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { HttpError } from './errors.js';

export interface Principal {
  userId: string;
  sub: string;
  email: string;
  name: string;
}

/**
 * Cognito's public keys. jose caches and re-fetches these on rotation, so this
 * is created once per process rather than per request — a JWKS fetch on every
 * call would put Cognito in the hot path of every single API request.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks) return jwks;
  const region = requiredEnv('AWS_REGION');
  const poolId = requiredEnv('COGNITO_USER_POOL_ID');
  jwks = createRemoteJWKSet(
    new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`),
    { cacheMaxAge: 10 * 60 * 1000, cooldownDuration: 30 * 1000 },
  );
  return jwks;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * The development escape hatch.
 *
 * Tests and local work need a token without standing up Cognito. That is a
 * backdoor, and a backdoor that can be switched on in production is not a
 * development convenience, it is the vulnerability. Two independent conditions
 * must hold — NODE_ENV must not be production AND a secret must be explicitly
 * configured — and the production check is asserted again at startup so a
 * misconfigured deployment fails to boot rather than quietly accepting these.
 */
export function devAuthEnabled(): boolean {
  return !isProduction() && !!process.env.DEV_AUTH_SECRET;
}

export function mintDevToken(claims: { sub: string; email: string; name?: string }): string {
  if (!devAuthEnabled()) throw new Error('dev auth is not enabled');
  const body = Buffer.from(JSON.stringify({ ...claims, iat: Date.now() })).toString('base64url');
  const sig = createHmac('sha256', process.env.DEV_AUTH_SECRET!).update(body).digest('base64url');
  return `dev.${body}.${sig}`;
}

function verifyDevToken(token: string): JWTPayload | null {
  if (!devAuthEnabled() || !token.startsWith('dev.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', process.env.DEV_AUTH_SECRET!).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a length mismatch, and the
  // throw itself would leak length through timing if it were the only guard.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JWTPayload;
  } catch {
    return null;
  }
}

/**
 * A small named-user login for the case in between "just me on my laptop"
 * (DEV_AUTH_SECRET, any email, no password) and "real Cognito deployment"
 * (AWS account, hosted pool, Terraform that does not exist yet). It is meant
 * for a handful of known people — an owner and their accountant — reached
 * with a real password, not an email typed into a form.
 *
 * Unlike devAuthEnabled(), this is allowed to be on in production: the
 * password is actually checked. What is NOT allowed is DEV_AUTH_SECRET being
 * set alongside it — assertProductionAuthSane() still refuses to boot if a
 * production deployment leaves the no-password door open.
 */
export interface LocalAuthUser {
  email: string;
  name: string;
  /** `<salt-hex>:<hash-hex>`, from node:crypto scrypt. Never a plaintext password. */
  scryptHash: string;
}

let localUsersCache: LocalAuthUser[] | null = null;
export function localAuthUsers(): LocalAuthUser[] {
  if (localUsersCache) return localUsersCache;
  const raw = process.env.LOCAL_AUTH_USERS;
  if (!raw) return (localUsersCache = []);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('LOCAL_AUTH_USERS is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('LOCAL_AUTH_USERS must be a JSON array');
  localUsersCache = parsed.map((u, i) => {
    const rec = u as Record<string, unknown>;
    if (typeof rec.email !== 'string' || typeof rec.scryptHash !== 'string') {
      throw new Error(`LOCAL_AUTH_USERS[${i}] must have "email" and "scryptHash"`);
    }
    return { email: rec.email.toLowerCase(), name: typeof rec.name === 'string' ? rec.name : rec.email, scryptHash: rec.scryptHash };
  });
  return localUsersCache;
}

export function localAuthEnabled(): boolean {
  return !!process.env.LOCAL_AUTH_SECRET && localAuthUsers().length > 0;
}

/** A fixed dummy hash, compared against on every failed lookup so that an
 *  unknown email costs the same wall-clock time as a wrong password — the
 *  same reasoning as Cognito's own generic "sign-in failed" error. */
const DUMMY_SCRYPT = scryptSync('not-a-real-password', 'no-such-salt', 64);

export function verifyLocalPassword(email: string, password: string): LocalAuthUser | null {
  const user = localAuthUsers().find((u) => u.email === email.toLowerCase());
  const [saltHex, hashHex] = (user?.scryptHash ?? '').split(':');
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : Buffer.from('no-such-salt');
  const expected = hashHex ? Buffer.from(hashHex, 'hex') : DUMMY_SCRYPT;
  const actual = scryptSync(password, salt, 64);
  const match = actual.length === expected.length && timingSafeEqual(actual, expected);
  return user && match ? user : null;
}

export function mintLocalToken(claims: { sub: string; email: string; name?: string }): string {
  if (!localAuthEnabled()) throw new Error('local auth is not enabled');
  const body = Buffer.from(JSON.stringify({ ...claims, iat: Date.now() })).toString('base64url');
  const sig = createHmac('sha256', process.env.LOCAL_AUTH_SECRET!).update(body).digest('base64url');
  return `local.${body}.${sig}`;
}

function verifyLocalToken(token: string): JWTPayload | null {
  if (!localAuthEnabled() || !token.startsWith('local.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', process.env.LOCAL_AUTH_SECRET!).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JWTPayload;
    // Re-check membership on every verification, not just at login: removing
    // someone from LOCAL_AUTH_USERS and restarting the server should revoke
    // any token they are still holding, not just stop them logging in again.
    const email = String(payload['email'] ?? '').toLowerCase();
    if (!localAuthUsers().some((u) => u.email === email)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function verifyCognitoToken(token: string): Promise<JWTPayload> {
  const region = requiredEnv('AWS_REGION');
  const poolId = requiredEnv('COGNITO_USER_POOL_ID');
  const clientId = requiredEnv('COGNITO_CLIENT_ID');
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}`,
    // Cognito puts the app client in `aud` on ID tokens and `client_id` on
    // access tokens. We require ID tokens, so `aud` is the right claim and
    // pinning it stops a token minted for a different app in the same pool.
    audience: clientId,
    clockTolerance: 30,
  });
  if (payload['token_use'] !== 'id') {
    throw new HttpError(401, 'invalid_token', 'An ID token is required.');
  }
  return payload;
}

/**
 * Turns a bearer token into a Principal, creating the local user row on first
 * sight. Cognito owns identity; this table exists only to hang authorization
 * and audit trails off a stable internal id.
 */
export async function principalFromToken(token: string): Promise<Principal> {
  let payload: JWTPayload | null = verifyDevToken(token) ?? verifyLocalToken(token);
  if (!payload) {
    try {
      payload = await verifyCognitoToken(token);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(401, 'invalid_token', 'That sign-in could not be verified.');
    }
  }
  const sub = String(payload.sub ?? '');
  const email = String(payload['email'] ?? '').trim();
  const name = String(payload['name'] ?? payload['given_name'] ?? '').trim();
  if (!sub || !email) throw new HttpError(401, 'invalid_token', 'That sign-in is missing required claims.');

  const { rows } = await getPool().query<{ id: string; email: string; name: string; status: string }>(
    `INSERT INTO users (cognito_sub, email, name)
     VALUES ($1,$2,$3)
     ON CONFLICT (cognito_sub) DO UPDATE
       SET email = EXCLUDED.email,
           name = CASE WHEN users.name = '' THEN EXCLUDED.name ELSE users.name END,
           last_seen_at = now()
     RETURNING id, email, name, status`,
    [sub, email, name],
  );
  const row = rows[0]!;
  if (row.status !== 'active') {
    throw new HttpError(403, 'account_suspended', 'This account has been suspended.');
  }
  return { userId: row.id, sub, email: row.email, name: row.name };
}

export function bearerFrom(header: string | undefined): string {
  if (!header) throw new HttpError(401, 'not_authenticated', 'Sign in to continue.');
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m || !m[1]) throw new HttpError(401, 'not_authenticated', 'Sign in to continue.');
  return m[1].trim();
}

/**
 * Called once at boot. A deployment that would accept development tokens in
 * production must never reach the point of listening on a port.
 */
export function assertProductionAuthSane(): void {
  if (!isProduction()) return;
  if (process.env.DEV_AUTH_SECRET) {
    throw new Error('DEV_AUTH_SECRET is set in production. Refusing to start.');
  }
  // Local auth (named users, real passwords) is an acceptable production
  // authentication method on its own — it does not require Cognito too.
  if (localAuthEnabled()) return;
  for (const k of ['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'AWS_REGION']) {
    if (!process.env[k]) throw new Error(`${k} must be set in production. Refusing to start.`);
  }
}
