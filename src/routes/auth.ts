import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../app.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import {
  devAuthEnabled, isProduction, localAuthEnabled, verifyLocalPassword, mintLocalToken, localAuthUsers,
  mintLocalRefreshToken, verifyLocalRefreshToken, loginThrottled, recordLoginFailure, clearLoginFailures,
} from '../lib/auth.js';

/**
 * Token handling, and the reasoning behind the shape of it.
 *
 * The browser never sends a password anywhere except Cognito's own hosted login
 * page, over the Authorization Code flow with PKCE. Our server therefore never
 * sees a password even in memory, which is a stronger claim than "we hash it
 * properly" and costs one redirect.
 *
 * The refresh token comes back to the browser only as an httpOnly cookie, so a
 * cross-site scripting bug in the front end cannot read it. The ID token is
 * returned in the response body and the front end holds it in a variable, never
 * in localStorage — same reasoning, and it expires in an hour regardless.
 */

const REFRESH_COOKIE = 'cb_rt';

function cognitoDomain(): string {
  const d = process.env.COGNITO_DOMAIN;
  if (!d) throw new Error('COGNITO_DOMAIN is not set');
  return d.replace(/\/+$/, '');
}

function setRefreshCookie(reply: FastifyReply, token: string, maxAgeSeconds: number): void {
  reply.header(
    'set-cookie',
    [
      `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/api/auth',
      'HttpOnly',
      'SameSite=Lax',
      isProduction() ? 'Secure' : '',
      `Max-Age=${maxAgeSeconds}`,
    ]
      .filter(Boolean)
      .join('; '),
  );
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.header(
    'set-cookie',
    `${REFRESH_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0${isProduction() ? '; Secure' : ''}`,
  );
}

function readRefreshCookie(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === REFRESH_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function cognitoToken(body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${cognitoDomain()}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Cognito's error text is safe to log but not to echo — it distinguishes
    // "unknown user" from "wrong password", which is a free account oracle.
    throw new HttpError(401, 'sign_in_failed', 'That sign-in could not be completed.', json);
  }
  return json;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What the front end needs to start a login. Public by necessity: these are
   * the values that go in a redirect URL and are visible to anyone who clicks
   * sign in. There is no secret here — the client secret is deliberately not
   * configured, because a single-page app cannot keep one.
   */
  app.get('/auth/config', async () => ({
    mode: devAuthEnabled() ? 'dev' : localAuthEnabled() ? 'local' : 'cognito',
    domain: process.env.COGNITO_DOMAIN ?? null,
    clientId: process.env.COGNITO_CLIENT_ID ?? null,
    region: process.env.AWS_REGION ?? null,
    scopes: ['openid', 'email', 'profile'],
  }));

  const callbackSchema = z
    .object({
      code: z.string().min(10).max(2048),
      codeVerifier: z.string().min(43).max(128),
      redirectUri: z.string().url().max(2048),
    })
    .strict();

  app.post('/auth/callback', async (req, reply) => {
    const parsed = callbackSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('That sign-in response was malformed.');
    const { code, codeVerifier, redirectUri } = parsed.data;

    // The redirect URI is echoed back to Cognito, which requires it to match one
    // registered on the app client. Validating it here as well means a stolen
    // code cannot be redeemed against an attacker-controlled callback even if
    // the pool were misconfigured.
    const allowed = (process.env.ALLOWED_REDIRECT_URIS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(redirectUri)) {
      throw badRequest('That redirect address is not registered.');
    }

    const tokens = await cognitoToken({
      grant_type: 'authorization_code',
      client_id: process.env.COGNITO_CLIENT_ID ?? '',
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    });

    const idToken = String(tokens['id_token'] ?? '');
    const refresh = String(tokens['refresh_token'] ?? '');
    const expiresIn = Number(tokens['expires_in'] ?? 3600);
    if (!idToken) throw new HttpError(401, 'sign_in_failed', 'That sign-in could not be completed.');
    if (refresh) setRefreshCookie(reply, refresh, 30 * 24 * 3600);

    return { idToken, expiresIn };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const refresh = readRefreshCookie(req);
    if (!refresh) throw new HttpError(401, 'not_authenticated', 'Your session has ended. Sign in again.');
    // Development sessions refresh through the SAME cookie and the same
    // endpoint. Giving dev mode a shortcut would leave the real refresh path
    // untested, which is how "it worked locally" becomes a production incident.
    if (devAuthEnabled() && refresh.startsWith('devrt.')) {
      const email = Buffer.from(refresh.slice('devrt.'.length), 'base64url').toString('utf8');
      if (!email.includes('@')) {
        clearRefreshCookie(reply);
        throw new HttpError(401, 'not_authenticated', 'Your session has ended. Sign in again.');
      }
      const { mintDevToken } = await import('../lib/auth.js');
      return { idToken: mintDevToken({ sub: `dev-${email}`, email, name: email }), expiresIn: 3600 };
    }
    // Local sessions refresh through the same cookie too. Re-checking
    // membership here (not just at login) means removing someone from
    // LOCAL_AUTH_USERS and restarting the server ends their session within
    // the hour, not only stops them logging in again.
    if (localAuthEnabled() && refresh.startsWith('localrt.')) {
      const email = verifyLocalRefreshToken(refresh);
      const user = email ? localAuthUsers().find((u) => u.email === email.toLowerCase()) : undefined;
      if (!user) {
        clearRefreshCookie(reply);
        throw new HttpError(401, 'not_authenticated', 'Your session has ended. Sign in again.');
      }
      return { idToken: mintLocalToken({ sub: `local-${user.email}`, email: user.email, name: user.name }), expiresIn: 3600 };
    }
    // Anything reaching here is a devrt./localrt. cookie whose mode is not
    // currently enabled (e.g. left over from before DEV_AUTH_SECRET was
    // turned off), or a genuinely malformed cookie — not a signal to attempt
    // Cognito. Only attempt it when actually configured; otherwise a stale
    // cookie from a different auth mode throws inside cognitoDomain()
    // (COGNITO_DOMAIN unset) and 500s instead of cleanly asking to sign in
    // again, which is what every other unrecognised-cookie case here does.
    if (!process.env.COGNITO_DOMAIN) {
      clearRefreshCookie(reply);
      throw new HttpError(401, 'not_authenticated', 'Your session has ended. Sign in again.');
    }
    const tokens = await cognitoToken({
      grant_type: 'refresh_token',
      client_id: process.env.COGNITO_CLIENT_ID ?? '',
      refresh_token: refresh,
    });
    const idToken = String(tokens['id_token'] ?? '');
    if (!idToken) {
      clearRefreshCookie(reply);
      throw new HttpError(401, 'not_authenticated', 'Your session has ended. Sign in again.');
    }
    return { idToken, expiresIn: Number(tokens['expires_in'] ?? 3600) };
  });

  app.post('/auth/logout', async (req, reply) => {
    // Best effort: the audit row is worth having, but a logout must succeed even
    // for a token that has already expired.
    try {
      const p = await authenticate(req);
      await audit({ userId: p.userId, action: 'logout', entity: 'session', ip: req.ip, requestId: String(req.id) });
    } catch {
      /* nothing to audit */
    }
    clearRefreshCookie(reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const p = await authenticate(req);
    return { userId: p.userId, email: p.email, name: p.name };
  });

  /**
   * Local development only. Hands back a token for an arbitrary email so the app
   * can be run end to end without Cognito. devAuthEnabled() is false whenever
   * NODE_ENV is production, and the server refuses to boot if the secret is set
   * there — two independent locks on the same door.
   */
  app.post('/auth/dev-login', async (req, reply) => {
    if (!devAuthEnabled()) {
      return reply.status(404).send({ error: 'not_found', message: 'No such endpoint.' });
    }
    const body = z.object({ email: z.string().email(), name: z.string().max(120).optional() }).strict().parse(req.body);
    const { mintDevToken } = await import('../lib/auth.js');
    const token = mintDevToken({ sub: `dev-${body.email}`, email: body.email, name: body.name ?? body.email });
    setRefreshCookie(reply, 'devrt.' + Buffer.from(body.email, 'utf8').toString('base64url'), 7 * 24 * 3600);
    return { idToken: token, expiresIn: 3600, mode: 'dev' };
  });

  /**
   * Real sign-in for a small, named set of people (owner + accountant) when
   * there is no Cognito deployment. A real password, checked server-side with
   * a salted hash — never logged, never stored in plain text, never sent
   * anywhere but here. Rate-limited far tighter than the rest of the API:
   * this is the one endpoint on the whole server where someone gets to guess.
   */
  app.post(
    '/auth/local-login',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      if (!localAuthEnabled()) {
        return reply.status(404).send({ error: 'not_found', message: 'No such endpoint.' });
      }
      const body = z.object({ email: z.string().email(), password: z.string().min(1).max(200) }).strict().parse(req.body);
      if (loginThrottled(body.email)) {
        throw new HttpError(429, 'rate_limited', 'Too many failed sign-in attempts for this account. Try again in 15 minutes.');
      }
      const user = verifyLocalPassword(body.email, body.password);
      if (!user) {
        recordLoginFailure(body.email);
        throw new HttpError(401, 'sign_in_failed', 'That email or password is incorrect.');
      }
      clearLoginFailures(body.email);
      const token = mintLocalToken({ sub: `local-${user.email}`, email: user.email, name: user.name });
      setRefreshCookie(reply, mintLocalRefreshToken(user.email, 30 * 24 * 3600), 30 * 24 * 3600);
      return { idToken: token, expiresIn: 3600, mode: 'local' };
    },
  );
}
