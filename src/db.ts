import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max = 10): Db {
  return new pg.Pool({ connectionString, max });
}

/** Run fn in a transaction; commits on success, rolls back on any error. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('begin');
    const result = await fn(tx);
    await tx.query('commit');
    return result;
  } catch (e) {
    await tx.query('rollback').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

const MIGRATIONS = new URL('../migrations/', import.meta.url);

/**
 * Apply the numbered files in server/migrations (001_*.sql, 002_*.sql, …) that have not run yet, in order,
 * each in its own transaction, recording them in schema_migrations. `upTo` stops early (for tests).
 */
export async function migrate(db: Db, upTo = Infinity): Promise<number[]> {
  await db.query(`create table if not exists schema_migrations (
    version integer primary key, name text not null, applied_at timestamptz not null default now())`);
  const files = (await readdir(MIGRATIONS))
    .map(name => ({ name, version: Number(/^(\d+)_.*\.sql$/.exec(name)?.[1]) }))
    .filter(f => Number.isInteger(f.version) && f.version <= upTo)
    .sort((a, b) => a.version - b.version);
  const applied: number[] = [];
  for (const f of files) {
    await withTx(db, async tx => {
      // Serialise migrations if two servers start at once.
      await tx.query('select pg_advisory_xact_lock(727274)');
      const done = await tx.query('select 1 from schema_migrations where version = $1', [f.version]);
      if (done.rowCount) return;
      await tx.query(await readFile(new URL(f.name, MIGRATIONS), 'utf8'));
      await tx.query('insert into schema_migrations (version, name) values ($1, $2)', [f.version, f.name]);
      applied.push(f.version);
    });
  }
  return applied;
}
