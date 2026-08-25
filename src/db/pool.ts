import pg from 'pg';

// Money arrives from Postgres as NUMERIC. node-postgres hands NUMERIC back as a
// string by default, and that default is correct — parsing it to a JS number
// would silently round anything past 2^53 and reintroduce exactly the float
// error the NUMERIC columns exist to prevent. Every caller converts explicitly.
// The one thing worth overriding is int8 counts, which are safe as numbers.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // RDS terminates TLS with an Amazon-issued certificate. Verification is on
    // in production and the CA bundle is supplied by the task definition.
    ssl:
      process.env.PGSSL === 'require'
        ? { rejectUnauthorized: true, ca: process.env.PGSSLROOTCERT }
        : undefined,
  });
  pool.on('error', (err) => {
    // An idle client erroring out must never take the process down.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'error', msg: 'pg idle client error', err: String(err) }));
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Runs fn inside a transaction, rolling back on any throw.
 *
 * Every write path in the API goes through this. A partially applied accounting
 * change is worse than a rejected one: a half-written journal entry balances
 * nowhere and nothing on the screen says so.
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the connection is already gone; the transaction dies with it */
    }
    throw err;
  } finally {
    client.release();
  }
}
