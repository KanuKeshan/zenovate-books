import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// dist/routes/web.js → repo root, and src/routes/web.ts → repo root under tsx.
const WEB_ROOT = join(here, '..', '..', 'web');

/**
 * Serves the single-file app from the same origin as the API.
 *
 * Same-origin is not a convenience here, it is the security model: the refresh
 * cookie is Path=/api/auth and SameSite=Lax, and CORS is closed by default. A
 * front end served from anywhere else would need the cookie loosened to cross
 * site, which is precisely the loosening that makes it stealable.
 */
export default async function webRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: WEB_ROOT,
    prefix: '/',
    index: ['index.html'],
    // The HTML is the app and changes on every deploy; caching it is how someone
    // ends up running last week's build against this week's API.
    //
    // This callback runs deep inside the static send path, where an exception
    // does not become a 500 — it takes the PROCESS down. So it accepts either
    // shape of response object and swallows its own failure: a stale
    // cache-control header is a nuisance, a crash loop is an outage.
    setHeaders(res: unknown, path: string) {
      try {
        const value = path.endsWith('.html') ? 'no-store, must-revalidate' : 'public, max-age=3600';
        const r = res as { header?: (k: string, v: string) => void; setHeader?: (k: string, v: string) => void };
        if (typeof r.header === 'function') r.header('cache-control', value);
        else if (typeof r.setHeader === 'function') r.setHeader('cache-control', value);
      } catch {
        /* never fatal */
      }
    },
  });

  // The app is a single page, so a deep link or a Cognito redirect landing on an
  // unknown path should still get the app rather than a 404 — but only for
  // navigations. Anything under /api that missed a route is a genuine 404 and
  // must stay one, or a typo'd endpoint would silently return HTML.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'not_found', message: 'No such endpoint.', requestId: String(req.id) });
    }
    if (req.method !== 'GET') {
      return reply.status(404).send({ error: 'not_found', message: 'No such endpoint.', requestId: String(req.id) });
    }
    return reply.sendFile('index.html');
  });
}
