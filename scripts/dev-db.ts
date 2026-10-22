// Local PostgreSQL for development, no install needed: PGlite (Postgres compiled to WebAssembly)
// served over the normal Postgres protocol. Data is kept in server/.pgdata.
import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.DEV_DB_PORT) || 54329;
const dataDir = fileURLToPath(new URL('../.pgdata', import.meta.url));

const db = await PGlite.create(dataDir);
// Several connections so the API and `npm run member` can be used at the same time, and a killed process
// does not keep the only slot. PGlite is one session underneath, so keep the API's pool at 1 (PG_POOL_MAX=1).
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 10 });
await server.start();
console.log(`Dev PostgreSQL (PGlite) on postgres://postgres:postgres@localhost:${port}/postgres — data in ${dataDir}`);

const stop = async () => { await server.stop(); await db.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
