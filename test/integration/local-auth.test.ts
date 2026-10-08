import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes, scryptSync } from 'node:crypto';
import { buildApp } from '../../src/app.js';
import authRoutes from '../../src/routes/auth.js';
import { loginThrottled, recordLoginFailure, clearLoginFailures } from '../../src/lib/auth.js';
import { setupDb, teardown } from '../helpers.js';

const EMAIL = 'tester@example.test';
const PASSWORD = 'correct-horse-battery-staple';

// Must be set before anything reads them: localAuthUsers() caches on first use.
const salt = randomBytes(16);
process.env.LOCAL_AUTH_SECRET = randomBytes(32).toString('hex');
process.env.LOCAL_AUTH_USERS = JSON.stringify([
  { email: EMAIL, name: 'Tester', scryptHash: `${salt.toString('hex')}:${scryptSync(PASSWORD, salt, 64).toString('hex')}` },
]);

let app: FastifyInstance;

beforeAll(async () => {
  await setupDb();
  app = await buildApp({ logger: false });
  await app.register(authRoutes, { prefix: '/api' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await teardown();
});

function login(password: string, email = EMAIL) {
  return app.inject({ method: 'POST', url: '/api/auth/local-login', payload: { email, password } });
}
function refreshWith(cookieValue: string) {
  return app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { cookie: `cb_rt=${encodeURIComponent(cookieValue)}` } });
}
function cookieValueFrom(res: Awaited<ReturnType<typeof login>>): string {
  const raw = String(res.headers['set-cookie']);
  return decodeURIComponent(/cb_rt=([^;]*)/.exec(raw)![1]!);
}

describe('local auth refresh cookie', () => {
  it('a real sign-in produces a cookie that refreshes', async () => {
    const res = await login(PASSWORD);
    expect(res.statusCode).toBe(200);
    const refreshed = await refreshWith(cookieValueFrom(res));
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().idToken).toMatch(/^local\./);
  });

  it('a cookie forged from just an email address is rejected', async () => {
    const forged = 'localrt.' + Buffer.from(EMAIL, 'utf8').toString('base64url');
    expect((await refreshWith(forged)).statusCode).toBe(401);
  });

  it('a real cookie with a tampered email is rejected', async () => {
    const real = cookieValueFrom(await login(PASSWORD));
    const [, rest] = [real.slice(0, 8), real.slice(8)];
    const [body, sig] = rest.split('.') as [string, string];
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    claims.email = 'someone-else@example.test';
    const tampered = `localrt.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    expect((await refreshWith(tampered)).statusCode).toBe(401);
  });
});

describe('local auth failed-login throttle', () => {
  it('locks an account after repeated failures regardless of caller address, and unlocks on success', () => {
    const email = 'Throttle-Target@example.test';
    expect(loginThrottled(email)).toBe(false);
    for (let i = 0; i < 8; i++) recordLoginFailure(email);
    expect(loginThrottled(email.toLowerCase())).toBe(true);
    clearLoginFailures(email);
    expect(loginThrottled(email)).toBe(false);
  });
});
