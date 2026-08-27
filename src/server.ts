import { buildApp } from './app.js';
import { assertProductionAuthSane } from './lib/auth.js';
import { migrate } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { registerRoutes } from './routes/index.js';

// Picks up .env in the working directory if one exists. A variable already
// present in the environment always wins — this only fills gaps, so a test
// runner or scripts/e2e.sh that export their own DATABASE_URL etc. are
// unaffected either way.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — fine, env vars may be set some other way (CI, prod) */
}

async function main(): Promise<void> {
  // Refuse to start rather than start wrong. A production process that would
  // accept development tokens must never reach the point of listening.
  assertProductionAuthSane();

  if (process.env.RUN_MIGRATIONS_ON_BOOT === 'true') {
    const ran = await migrate((m) => process.stdout.write(JSON.stringify({ level: 'info', msg: m }) + '\n'));
    process.stdout.write(JSON.stringify({ level: 'info', msg: `migrations applied: ${ran.length}` }) + '\n');
  }

  const app = await buildApp();
  await registerRoutes(app);

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: '0.0.0.0' });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    // Close the listener first so the load balancer stops sending work, then
    // drain the pool. Killing the pool first would fail requests already in
    // flight, which on a deploy means someone's save vanishing mid-click.
    try {
      await app.close();
    } finally {
      await closePool();
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ level: 'fatal', msg: String(err?.message ?? err) }) + '\n');
  process.exit(1);
});
