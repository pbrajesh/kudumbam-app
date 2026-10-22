// Copy every table to a JSON file in data/ (not committed):  npm run backup
// For a hosted database, also use the provider's own backups; this is a quick safety copy.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db.ts';

if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL (see server/.env.example).'); process.exit(1); }
const db = createPool(process.env.DATABASE_URL, 1);

try {
  const tables = await db.query(
    `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`);
  const dump: Record<string, unknown[]> = {};
  for (const { table_name } of tables.rows) {
    dump[table_name] = (await db.query(`select * from "${table_name}"`)).rows;
  }
  const dir = fileURLToPath(new URL('../../data/', import.meta.url));
  await mkdir(dir, { recursive: true });
  const file = `${dir}backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(file, JSON.stringify(dump, null, 1));
  console.log(`Saved ${Object.entries(dump).map(([t, rows]) => `${t}: ${rows.length}`).join(', ')}\n→ ${file}`);
} finally {
  await db.end();
}
