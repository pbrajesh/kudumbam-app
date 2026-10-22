// Test-only: runs the real API on :3000 against an in-memory PostgreSQL, trusting a locally generated
// signing key instead of Supabase's. Prints browser sessions for a test editor and viewer, so the Angular app
// can be exercised end to end without a Supabase project. Never use this for real data.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/app.ts';
import { supabaseVerifier } from '../src/auth.ts';
import { createPool, migrate, withTx } from '../src/db.ts';
import { createTree } from '../src/tree-repo.ts';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'https://e2etest.supabase.co';
const dbPort = 55432;

const pglite = await PGlite.create();
const socket = new PGLiteSocketServer({ db: pglite, port: dbPort, host: '127.0.0.1' });
await socket.start();
const db = createPool(`postgres://postgres:postgres@127.0.0.1:${dbPort}/postgres`, 1);
await migrate(db);
const treeId = await withTx(db, tx => createTree(tx, 'Test family', { email: 'editor@example.com' }));
await db.query(`insert into tree_members (tree_id, email, role) values ($1, 'viewer@example.com', 'viewer')`, [treeId]);

const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'ES256' };
const app = createApp({ db, verify: supabaseVerifier(SUPABASE_URL, createLocalJWKSet({ keys: [jwk] })) });
app.listen(3000, () => console.log('E2E API on http://localhost:3000'));

async function session(id: string, email: string) {
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const access_token = await new SignJWT({ email, role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'e2e' })
    .setSubject(id).setIssuer(`${SUPABASE_URL}/auth/v1`).setAudience('authenticated')
    .setIssuedAt().setExpirationTime(exp).sign(privateKey);
  return {
    access_token, refresh_token: 'e2e-not-used', token_type: 'bearer', expires_in: 12 * 3600, expires_at: exp,
    user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}

const storageKey = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
console.log(JSON.stringify({
  storageKey,
  editor: await session('11111111-1111-4111-8111-111111111111', 'editor@example.com'),
  viewer: await session('22222222-2222-4222-8222-222222222222', 'viewer@example.com'),
  stranger: await session('33333333-3333-4333-8333-333333333333', 'stranger@example.com'),
}));
