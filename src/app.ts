import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { HttpError } from './lib/errors.js';
import { bearerFrom, principalFromToken, type Principal } from './lib/auth.js';
import { emit } from './lib/metrics.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    startedAt?: number;
  }
}

export interface BuildOptions {
  logger?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
    // Trust the ALB's X-Forwarded-For so rate limiting and audit records see the
    // caller's address rather than the load balancer's, which would make every
    // request in the fleet look like one very busy client.
    trustProxy: true,
    genReqId: (req) => (req.headers['x-amzn-trace-id'] as string) ?? randomUUID(),
    // A statement paste or a workspace import is legitimately large; anything
    // beyond this is not a spreadsheet, it is someone probing for a memory limit.
    bodyLimit: 12 * 1024 * 1024,
    // Fastify's own per-request lines are replaced by the single structured
    // metric line emitted in onResponse — two log lines per request is double
    // the CloudWatch bill for none of the information. (Deprecated in favour of
    // logController in Fastify 6; migrate then, not now.)
    disableRequestLogging: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The front end is one file with inline script and style by design.
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
        // helmet's default script-src-attr is 'none' and does NOT inherit
        // scriptSrc's 'unsafe-inline', so it must be opened separately or every
        // onclick="..." attribute in the front end (there are many) is silently
        // blocked by the browser with no server-side symptom at all.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'https://*.amazonaws.com'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
  });

  await app.register(cors, {
    origin: (origin, cb) => {
      const allowed = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      // Decline to GRANT, never reject. CORS exists to stop a browser handing
      // another site's page our response; it is not an access control on the
      // request itself. Throwing here 403s the app's own same-origin POSTs,
      // because a same-origin POST still carries an Origin header — which is
      // exactly how this was found, with sign-in failing against its own server.
      cb(null, false);
    },
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: '1 minute',
    // Keyed on the authenticated user where there is one, so a whole office
    // behind a single NAT address is not throttled as if it were one person.
    keyGenerator: (req: FastifyRequest) => req.principal?.userId ?? req.ip,
    addHeadersOnExceeding: { 'x-ratelimit-remaining': true },
  });

  app.addHook('onRequest', async (req) => {
    req.startedAt = performance.now();
  });

  // One structured line per request, carrying the metric and the trace id.
  app.addHook('onResponse', async (req, reply) => {
    emit(
      {
        route: (req.routeOptions?.url as string) ?? req.url.split('?')[0] ?? 'unknown',
        method: req.method,
        status: reply.statusCode,
        durationMs: performance.now() - (req.startedAt ?? performance.now()),
        userId: req.principal?.userId ?? null,
        requestId: String(req.id),
      },
      // Metrics go to stdout because that is what CloudWatch reads. In tests it
      // is 178 lines of noise burying the one line that says what failed.
      (line) => { if (process.env.NODE_ENV !== 'test') process.stdout.write(line + '\n'); },
    );
  });

  app.setErrorHandler((rawErr: unknown, req, reply) => {
    const err = rawErr as Error & { code?: string; statusCode?: number };
    const isHttp = err instanceof HttpError;
    const status = isHttp ? err.status : err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err, requestId: req.id }, 'request failed');
    } else {
      req.log.warn({ code: isHttp ? err.code : undefined, requestId: req.id, msg: err.message }, 'request rejected');
    }
    reply.status(status).send({
      error: isHttp ? err.code : status === 429 ? 'rate_limited' : status >= 500 ? 'internal_error' : 'bad_request',
      // A 500's real message can name a table or a column. The client gets a
      // sentence; the detail stays in the log with the request id to join on.
      message:
        status >= 500
          ? 'Something went wrong on our side. The request id below will find it in the logs.'
          : err.message,
      requestId: String(req.id),
    });
  });

  // NOTE: the not-found handler is deliberately NOT set here. Fastify permits
  // exactly one per encapsulation context, and the single-page app needs the
  // decision to be "unknown GET outside /api serves the shell" — which only the
  // static route module knows. It registers last and owns it.

  return app;
}

/**
 * Authentication decorator applied per-route rather than globally.
 *
 * Global auth with an exemption list fails open: a new public route is one
 * forgotten list entry away, and nothing tells you. Requiring each route to opt
 * in fails closed, and a test asserts the whole route table is covered.
 */
export async function authenticate(req: FastifyRequest): Promise<Principal> {
  if (req.principal) return req.principal;
  const token = bearerFrom(req.headers.authorization);
  const principal = await principalFromToken(token);
  req.principal = principal;
  return principal;
}
