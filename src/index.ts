import { createApp } from './app.ts';
import { supabaseVerifier } from './auth.ts';
import { createPool, migrate } from './db.ts';

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name}. Copy server/.env.example to server/.env and fill it in.`);
    process.exit(1);
  }
  return v;
}

/** TRUST_PROXY: unset (direct), a number of proxy hops such as 1 (most hosts), or true/false. */
function trustProxy(v: string | undefined): boolean | number | undefined {
  if (!v?.trim()) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v);
  return v.trim() === 'true';
}

const db = createPool(required('DATABASE_URL'), Number(process.env.PG_POOL_MAX) || 10);
await migrate(db);

const app = createApp({
  db,
  verify: supabaseVerifier(required('SUPABASE_URL')),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  maxTreesPerUser: Number(process.env.MAX_TREES_PER_USER) || 5,
  maxMembersPerTree: Number(process.env.MAX_MEMBERS_PER_TREE) || 200,
  maxPeoplePerTree: Number(process.env.MAX_PEOPLE_PER_TREE) || 20_000,
  trustProxy: trustProxy(process.env.TRUST_PROXY),
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Family tree API listening on http://localhost:${port}`));
