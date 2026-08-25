import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

/**
 * A deliberately small migration runner.
 *
 * Two properties matter more than features. Migrations run inside a transaction
 * so a failure leaves no half-applied schema. And each file's checksum is
 * recorded, so editing a migration that has already run is caught loudly here
 * rather than discovered later as two environments whose schemas quietly differ.
 */
export async function migrate(log: (m: string) => void = () => {}): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  const ran: string[] = [];

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const seen = applied.get(file);
    if (seen) {
      if (seen !== checksum) {
        throw new Error(
          `Migration ${file} has changed since it was applied. Migrations are immutable once run — ` +
            `add a new file instead, or this environment's schema and the next one's will differ in ways nothing detects.`,
        );
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1,$2)', [file, checksum]);
      await client.query('COMMIT');
      ran.push(file);
      log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}

// Only run when invoked directly, so tests can import migrate() freely.
if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  migrate((m) => console.log(m))
    .then(async (ran) => {
      console.log(ran.length ? `${ran.length} migration(s) applied` : 'schema already up to date');
      await closePool();
    })
    .catch(async (err) => {
      console.error(String(err.message ?? err));
      await closePool();
      process.exit(1);
    });
}
