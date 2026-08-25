import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
  let payload: JWTPayload | null = verifyDevToken(token);
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
  for (const k of ['COGNITO_USER_POOL_ID', 'COGNITO_CLIENT_ID', 'AWS_REGION']) {
    if (!process.env[k]) throw new Error(`${k} must be set in production. Refusing to start.`);
  }
}
