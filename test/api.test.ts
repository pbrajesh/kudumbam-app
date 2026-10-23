// End-to-end API tests: real PostgreSQL (in-memory PGlite over the Postgres protocol), real `pg` driver,
// and real token checks using a locally generated signing key in place of Supabase's.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import type { TreeData } from '../src/models.ts';

// A made-up family (8 people, 3 families), already parsed from fixtures/sample.ged by the web app's GEDCOM reader.
// It carries the GEDCOM details the API must keep: _MARNM, a multi-line NOTE, DEAT Y, MARR, _CURRENT N, and tags
// the editor does not handle (OCCU, _UID) in `extra`.
const SAMPLE: TreeData = JSON.parse(readFileSync(new URL('./fixtures/sample.json', import.meta.url), 'utf8'));
const sampleTree = (): TreeData => structuredClone(SAMPLE);
import { createApp, type AppOptions } from '../src/app.ts';
import { supabaseVerifier, type VerifyToken } from '../src/auth.ts';
import { createPool, migrate, withTx, type Db } from '../src/db.ts';
import { applyChanges, createTree, loadTree, treeName } from '../src/tree-repo.ts';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const EDITOR = { sub: '11111111-1111-4111-8111-111111111111', email: 'editor@example.com' };
const VIEWER = { sub: '22222222-2222-4222-8222-222222222222', email: 'Viewer@Example.com' };
const STRANGER = { sub: '33333333-3333-4333-8333-333333333333', email: 'stranger@example.com' };
const OWNER = { sub: '44444444-4444-4444-8444-444444444444', email: 'owner@example.com' };
const OTHER = { sub: '55555555-5555-4555-8555-555555555555', email: 'other@example.com' };
const NEWBIE = { sub: '66666666-6666-4666-8666-666666666666', email: 'newbie@example.com' };
const COUSIN = { sub: '77777777-7777-4777-8777-777777777777', email: 'cousin@example.com' };

let stopDb: () => Promise<void>;
let db: Db;
let treeA: string;
let treeB: string;
/** Paths of the two test trees: A (owner, editor, viewer) and B (another family). */
const A = () => `/trees/${treeA}`;
const B = () => `/trees/${treeB}`;
let base: string;
let close: () => void;
let privateKey: CryptoKey;

async function token(u: { sub: string; email: string }, issuer = ISSUER) {
  return new SignJWT({ email: u.email, role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(u.sub).setIssuer(issuer).setAudience('authenticated')
    .setIssuedAt().setExpirationTime('1h')
    .sign(privateKey);
}

async function call(method: string, path: string,
  opts: { user?: { sub: string; email: string }; body?: unknown; bearer?: string; base?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const bearer = opts.bearer ?? (opts.user ? await token(opts.user) : undefined);
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch((opts.base ?? base) + path,
    { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  return { status: res.status, body: await res.json() as any, headers: res.headers };
}

let verify: VerifyToken;
const extraServers: (() => void)[] = [];
/** Another API instance on the same database, with its own options (e.g. tiny rate limits). Returns its /api URL. */
async function startApi(opts: Partial<AppOptions>): Promise<string> {
  const server = createApp({ db, verify, ...opts }).listen(0);
  await new Promise(r => server.once('listening', r));
  extraServers.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

function importBody(d: TreeData) {
  return {
    fileName: 'example-family.ged', submitterName: d.submitterName,
    people: d.order.map(id => d.people[id]), families: Object.values(d.families),
  };
}

/** A fresh in-memory PostgreSQL reached over the normal protocol, on a port the OS says is free. */
async function startPostgres(): Promise<{ db: Db; stop: () => Promise<void> }> {
  // Ask the OS for a free port (a random pick can land in a range Windows reserves).
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  const pglite = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
  await socket.start();
  const pool = createPool(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, 1);
  return { db: pool, stop: async () => { await pool.end(); await socket.stop(); await pglite.close(); } };
}

before(async () => {
  ({ db, stop: stopDb } = await startPostgres());
  assert.deepEqual(await migrate(db), [1, 2, 3]);
  assert.deepEqual(await migrate(db), [], 'second run must be a no-op');
  assert.equal((await db.query('select count(*)::int as n from trees')).rows[0].n, 0, 'an empty database gets no tree');
  treeA = await withTx(db, tx => createTree(tx, 'Test family', { email: OWNER.email }));
  await db.query(`insert into tree_members (tree_id, email, role) values ($1, 'editor@example.com', 'editor'),
                  ($1, 'viewer@example.com', 'viewer')`, [treeA]);

  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'ES256' };
  verify = supabaseVerifier(SUPABASE_URL, createLocalJWKSet({ keys: [jwk] }));
  const app = createApp({ db, verify,
    maxTreesPerUser: 3, maxMembersPerTree: 8, maxPeoplePerTree: 30, rateLimits: { requestsPer5Min: 100_000 } });
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  close = () => server.close();
});

after(async () => {
  close();
  for (const stop of extraServers) stop();
  await stopDb();
});

describe('sign-in and roles', () => {
  test('health needs no sign-in', async () => {
    assert.equal((await call('GET', '/health')).status, 200);
  });

  test('401 without a token, with a forged issuer, or with garbage', async () => {
    assert.equal((await call('GET', A() + '/tree')).status, 401);
    assert.equal((await call('GET', A() + '/tree', { bearer: await token(EDITOR, 'https://evil.example.com/auth/v1') })).status, 401);
    assert.equal((await call('GET', A() + '/tree', { bearer: 'not-a-jwt' })).status, 401);
  });

  test('a signed-in user who is not a member gets 404 for the tree, and an empty tree list', async () => {
    const r = await call('GET', A() + '/tree', { user: STRANGER });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /not found, or you are not a member/);
    assert.deepEqual((await call('GET', '/me', { user: STRANGER })).body.trees, []);
  });

  test('first sign-in links the Supabase user to the member row (email is case-insensitive)', async () => {
    const r = await call('GET', '/me', { user: VIEWER });
    assert.deepEqual(r.body, {
      id: VIEWER.sub, email: 'viewer@example.com',
      trees: [{ id: treeA, name: 'Test family', role: 'viewer', peopleCount: 0 }],
    });
    const row = await db.query('select user_id from tree_members where email = $1', ['viewer@example.com']);
    assert.equal(row.rows[0].user_id, VIEWER.sub);
  });

  test('viewers can read but not write', async () => {
    assert.equal((await call('GET', A() + '/tree', { user: VIEWER })).status, 200);
    const w = await call('POST', A() + '/changes', { user: VIEWER, body: {} });
    assert.equal(w.status, 403);
    assert.equal((await call('POST', A() + '/import', { user: VIEWER, body: importBody(sampleTree()) })).status, 403);
  });
});

describe('tree data', () => {
  const sample = sampleTree();

  test('import stores the whole file and GET /tree gives it back unchanged', async () => {
    const r = await call('POST', A() + '/import', { user: EDITOR, body: importBody(sample) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = await call('GET', A() + '/tree', { user: VIEWER });
    assert.equal(t.body.role, 'viewer');
    assert.equal(t.body.fileName, 'example-family.ged');
    assert.deepEqual(t.body.data.order, sample.order);
    assert.deepEqual(t.body.data.people, sample.people);
    assert.deepEqual(t.body.data.families, sample.families);
    assert.equal(t.body.data.submitterName, sample.submitterName);
    assert.equal(Object.keys(t.body.data.people).length, 8);
    assert.equal(t.body.data.people.I1.extra[0].tag, 'OCCU', 'unhandled tags are kept');
    assert.equal(t.body.data.people.I2.notes, 'Loved gardening.\nKept bees for thirty years.');
    assert.equal(t.body.data.families.F2.current, false);
    assert.deepEqual(t.body.settings, { homePersonId: null, surnameRule: 'father-surname' });
    assert.equal(t.body.versions.people.I3, 1);
  });

  test('a change set is all-or-nothing: one stale record rejects the whole edit', async () => {
    const t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    const parent = t.data.people.I3;
    const newKid = { ...parent, id: 'I900', given: 'Test', surname: 'Child', notes: '', extra: [] };
    const fam = { id: 'F900', husb: 'I3', children: ['I900'], marrDate: '', marrPlace: '', extra: [] };
    const stale = await call('POST', A() + '/changes', {
      user: EDITOR,
      body: {
        upsertPeople: [{ ...newKid, version: null }, { ...parent, given: 'Changed', version: 99 }],
        upsertFamilies: [{ ...fam, version: null }],
      },
    });
    assert.equal(stale.status, 409);
    const after = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.equal(after.data.people.I900, undefined, 'new person must not be saved');
    assert.equal(after.data.families.F900, undefined);
    assert.equal(after.data.people.I3.given, parent.given);

    const ok = await call('POST', A() + '/changes', {
      user: EDITOR,
      body: { upsertPeople: [{ ...newKid, version: null }], upsertFamilies: [{ ...fam, version: null }] },
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body.versions, { people: { I900: 1 }, families: { F900: 1 } });
    const saved = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.deepEqual(saved.data.families.F900.children, ['I900']);
    assert.equal(saved.data.order.at(-1), 'I900');
  });

  test('creating a record that already exists is a conflict', async () => {
    const t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    const r = await call('POST', A() + '/changes', { user: EDITOR, body: { upsertPeople: [{ ...t.data.people.I3, version: null }] } });
    assert.equal(r.status, 409);
  });

  test('two editors saving the same person: the second gets 409', async () => {
    const t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    const p = t.data.people.I900, v = t.versions.people.I900;
    const first = await call('PATCH', A() + '/people/I900', { user: EDITOR, body: { birthDate: '1 JAN 2000', version: v } });
    assert.equal(first.status, 200);
    assert.equal(first.body.versions.people.I900, v + 1);
    const second = await call('POST', A() + '/changes', { user: EDITOR, body: { upsertPeople: [{ ...p, given: 'Other', version: v }] } });
    assert.equal(second.status, 409);
    const now = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.equal(now.data.people.I900.birthDate, '1 JAN 2000');
    assert.equal(now.data.people.I900.given, 'Test');
  });

  test('family children and spouse endpoints', async () => {
    let t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    const add = await call('POST', A() + '/people', {
      user: EDITOR,
      body: { ...t.data.people.I900, id: 'I901', given: 'Second', sex: 'F', extra: [] },
    });
    assert.equal(add.status, 201);
    const kid = await call('POST', A() + '/families/F900/children', { user: EDITOR, body: { personId: 'I901', version: t.versions.families.F900 } });
    assert.equal(kid.status, 200, JSON.stringify(kid.body));
    t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.deepEqual(t.data.families.F900.children, ['I900', 'I901']);

    const wife = Object.values(t.data.people as TreeData['people']).find(p => p.sex === 'F' && p.id !== 'I901')!;
    const sp = await call('POST', A() + '/families/F900/spouses', { user: EDITOR, body: { personId: wife.id, version: t.versions.families.F900 } });
    assert.equal(sp.status, 200, JSON.stringify(sp.body));
    t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.equal(t.data.families.F900.wife, wife.id);

    const rm = await call('DELETE', A() + `/families/F900/children/I901?version=${t.versions.families.F900}`, { user: EDITOR });
    assert.equal(rm.status, 200);
    t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.deepEqual(t.data.families.F900.children, ['I900']);

    const patch = await call('PATCH', A() + '/families/F900', { user: EDITOR, body: { wife: null, current: false, version: t.versions.families.F900 } });
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.equal(t.data.families.F900.wife, undefined);
    assert.equal(t.data.families.F900.current, false);
  });

  test('deleting a person removes them from their families and bumps those families', async () => {
    const t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    const famVersion = t.versions.families.F900;
    const del = await call('DELETE', A() + `/people/I900?version=${t.versions.people.I900}`, { user: EDITOR });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    const now = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.equal(now.data.people.I900, undefined);
    assert.deepEqual(now.data.families.F900.children, []);
    assert.ok(now.versions.families.F900 > famVersion);
  });

  test('invalid input is rejected with a readable 400', async () => {
    const bad = await call('POST', A() + '/changes', {
      user: EDITOR,
      body: { upsertPeople: [{ id: "x'; drop table people;--", version: null }] },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /^Invalid /);
    const unknownField = await call('POST', A() + '/changes', { user: EDITOR, body: { dropEverything: true } });
    assert.equal(unknownField.status, 400);
    const badFamily = await call('POST', A() + '/import', {
      user: EDITOR,
      body: { fileName: 'x.ged', submitterName: '', people: [sample.people.I3], families: [{ id: 'F1', husb: 'I3', children: ['I404'], marrDate: '', marrPlace: '', extra: [] }] },
    });
    assert.equal(badFamily.status, 400);
    assert.match(badFamily.body.error, /I404/);
    assert.equal(Object.keys((await call('GET', A() + '/tree', { user: EDITOR })).body.data.people).length, 9, 'failed import must not wipe the tree');
  });
});

describe('tree settings', () => {
  test('viewers cannot change settings; editors can', async () => {
    assert.equal((await call('PATCH', A(), { user: VIEWER, body: { surnameRule: 'none' } })).status, 403);
    const r = await call('PATCH', A(), { user: EDITOR, body: { homePersonId: 'I3', surnameRule: 'father-given' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.settings, { homePersonId: 'I3', surnameRule: 'father-given' });
    const t = (await call('GET', A() + '/tree', { user: VIEWER })).body;
    assert.deepEqual(t.settings, { homePersonId: 'I3', surnameRule: 'father-given' });
  });

  test('home person must exist; null clears it; unknown rules are rejected', async () => {
    const missing = await call('PATCH', A(), { user: EDITOR, body: { homePersonId: 'I404' } });
    assert.equal(missing.status, 400);
    assert.equal((await call('PATCH', A(), { user: EDITOR, body: { surnameRule: 'mother-given' } })).status, 400);
    const cleared = await call('PATCH', A(), { user: EDITOR, body: { homePersonId: null } });
    assert.deepEqual(cleared.body.settings, { homePersonId: null, surnameRule: 'father-given' });
  });

  test('a deleted home person is reported as no home person', async () => {
    let t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    await call('PATCH', A(), { user: EDITOR, body: { homePersonId: 'I901' } });
    const del = await call('DELETE', A() + `/people/I901?version=${t.versions.people.I901}`, { user: EDITOR });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.equal(t.settings.homePersonId, null);
  });

  test('import clears the home person but keeps the naming rule', async () => {
    await call('PATCH', A(), { user: EDITOR, body: { homePersonId: 'I3' } });
    await call('POST', A() + '/import', { user: EDITOR, body: importBody(sampleTree()) });
    const t = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.deepEqual(t.settings, { homePersonId: null, surnameRule: 'father-given' });
  });
});


describe('owners', () => {
  test('an owner can do everything an editor can', async () => {
    const r = await call('POST', A() + '/changes', { user: OWNER, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call('GET', A(), { user: OWNER })).body.role, 'owner');
  });
});

describe('isolation between trees', () => {
  before(async () => {
    treeB = await withTx(db, tx => createTree(tx, 'Other family', { email: OTHER.email, userId: OTHER.sub }));
    const r = await call('POST', B() + '/import', { user: OTHER, body: importBody(sampleTree()) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test('two trees can use the same person IDs without touching each other', async () => {
    const b = (await call('GET', B() + '/tree', { user: OTHER })).body;
    assert.equal(b.role, 'owner');
    const patched = await call('PATCH', B() + '/people/I1', { user: OTHER, body: { given: 'Changed in B', version: b.versions.people.I1 } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const a = (await call('GET', A() + '/tree', { user: EDITOR })).body;
    assert.equal(a.data.people.I1.given, 'Arthur');
    assert.equal(Object.keys(a.data.people).length, 8);
    assert.equal((await loadTree(db, treeB)).data.people.I1.given, 'Changed in B');
  });

  test('a family in one tree cannot point at a person who only exists in another', async () => {
    const added = await call('POST', B() + '/people', {
      user: OTHER,
      body: { id: 'I999', given: 'Only in B', surname: '', marriedName: '', sex: 'U', birthDate: '', birthPlace: '',
              deceased: false, deathDate: '', deathPlace: '', notes: '', extra: [] },
    });
    assert.equal(added.status, 201);
    const r = await call('POST', A() + '/changes', {
      user: EDITOR,
      body: { upsertFamilies: [{ id: 'F999', husb: 'I999', children: [], marrDate: '', marrPlace: '', extra: [], version: null }] },
    });
    assert.equal(r.status, 409, 'the database refuses the cross-tree link');
    assert.equal((await loadTree(db, treeA)).data.families.F999, undefined);
    // The repository refuses it too, even when called directly.
    await assert.rejects(withTx(db, tx => applyChanges(tx, treeA, {
      upsertPeople: [], deletePeople: [], deleteFamilies: [],
      upsertFamilies: [{ id: 'F998', husb: 'I999', children: [], marrDate: '', marrPlace: '', extra: [], version: null }],
    }, 'test')), (e: { code?: string }) => e.code === '23503');
  });

  test('a person invited to two trees joins both on first sign-in', async () => {
    const treeC = await withTx(db, tx => createTree(tx, 'Third family', { email: OWNER.email }));
    await db.query(`insert into tree_members (tree_id, email, role) values ($1, $2, 'viewer')`, [treeA, NEWBIE.email]);
    await db.query(`insert into tree_members (tree_id, email, role) values ($1, $2, 'editor')`, [treeC, NEWBIE.email]);
    const me = (await call('GET', '/me', { user: NEWBIE })).body;
    assert.deepEqual(me.trees.map((t: { name: string; role: string }) => `${t.name}:${t.role}`),
      ['Test family:viewer', 'Third family:editor']);
    const linked = await db.query('select count(*)::int as n from tree_members where user_id = $1', [NEWBIE.sub]);
    assert.equal(linked.rows[0].n, 2);
  });

  test('every tree route answers 404 to a member of another tree, and changes nothing', async () => {
    const before = await loadTree(db, treeB);
    const membersOfB = async () =>
      (await db.query('select email, role, user_id from tree_members where tree_id = $1 order by email', [treeB])).rows;
    const membersBefore = await membersOfB();
    const person = { id: 'I1', given: 'X', surname: '', marriedName: '', sex: 'U', birthDate: '', birthPlace: '',
      deceased: false, deathDate: '', deathPlace: '', notes: '', extra: [] };
    const fam = { id: 'F1', children: [], marrDate: '', marrPlace: '', extra: [] };
    const routes: [string, string, unknown?][] = [
      ['GET', ''], ['PATCH', '', { name: 'Hijacked', surnameRule: 'none' }], ['DELETE', '?confirm=Other%20family'],
      ['GET', '/tree'], ['POST', '/changes', { upsertPeople: [{ ...person, version: 1 }] }],
      ['POST', '/import', importBody(sampleTree())],
      ['POST', '/people', { ...person, id: 'I77' }], ['PATCH', '/people/I1', { given: 'X', version: 1 }],
      ['DELETE', '/people/I1?version=1'],
      ['POST', '/families', { ...fam, id: 'F77' }], ['PATCH', '/families/F1', { marrDate: '1900', version: 1 }],
      ['DELETE', '/families/F1?version=1'],
      ['POST', '/families/F1/children', { personId: 'I1', version: 1 }], ['DELETE', '/families/F1/children/I3?version=1'],
      ['POST', '/families/F1/spouses', { personId: 'I1', version: 1 }], ['DELETE', '/families/F1/spouses/I1?version=1'],
      ['GET', '/members'], ['POST', '/members', { email: 'intruder@example.com', role: 'owner' }],
      ['PATCH', '/members/other%40example.com', { role: 'viewer' }], ['DELETE', '/members/other%40example.com'],
      ['DELETE', '/members/me'],
      ['PUT', '/members/me/claim', { personId: 'I1' }], ['DELETE', '/members/me/claim'], ['DELETE', '/members/me/person'],
      ['PUT', '/members/other%40example.com/person', { personId: 'I1' }],
      ['DELETE', '/members/other%40example.com/person'], ['DELETE', '/members/other%40example.com/claim'],
    ];
    for (const user of [EDITOR, OWNER, VIEWER]) {
      for (const [method, path, body] of routes) {
        const r = await call(method, B() + path, { user, body });
        assert.equal(r.status, 404, `${user.email} ${method} ${path} → ${r.status}`);
      }
    }
    assert.deepEqual(await loadTree(db, treeB), before);
    assert.deepEqual(await membersOfB(), membersBefore);
    assert.equal(await treeName(db, treeB), 'Other family');
  });

  test('made-up or malformed tree IDs are 404 too', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', "1' or '1'='1"]) {
      const r = await call('GET', `/trees/${encodeURIComponent(id)}/tree`, { user: EDITOR });
      assert.equal(r.status, 404, id);
    }
  });

  test('deleting a tree removes all its data and nothing else', async () => {
    await db.query('delete from trees where id = $1', [treeB]);
    for (const table of ['people', 'families', 'family_children', 'tree_members']) {
      const r = await db.query(`select count(*)::int as n from ${table} where tree_id = $1`, [treeB]);
      assert.equal(r.rows[0].n, 0, table);
    }
    assert.equal(Object.keys((await loadTree(db, treeA)).data.people).length, 8);
    assert.equal((await call('GET', B() + '/tree', { user: OTHER })).status, 404);
  });
});

describe('migration from the single-tree database', () => {
  test('existing data becomes one tree, members keep access, the first editor becomes owner', async () => {
    const pg = await startPostgres();
    try {
      assert.deepEqual(await migrate(pg.db, 1), [1]);
      await pg.db.query(`
        insert into people (id, given, sex) values ('I1', 'Old', 'M'), ('I2', 'Wife', 'F'), ('I3', 'Kid', 'U');
        insert into families (id, husband_id, wife_id) values ('F1', 'I1', 'I2');
        insert into family_children (family_id, person_id, position) values ('F1', 'I3', 0);
        insert into members (email, supabase_user_id, role) values
          ('first@example.com', '77777777-7777-4777-8777-777777777777', 'editor'),
          ('second@example.com', null, 'editor'), ('looker@example.com', null, 'viewer');
        insert into tree_meta (key, value) values ('fileName', 'Old-Family.ged'), ('submitterName', 'Sub'),
          ('surnameRule', 'father-given'), ('homePersonId', 'I2');`);

      assert.deepEqual(await migrate(pg.db), [2, 3]);

      const trees = (await pg.db.query('select * from trees')).rows;
      assert.equal(trees.length, 1);
      const [t] = trees;
      assert.deepEqual([t.name, t.file_name, t.submitter_name, t.surname_rule, t.home_person_id],
        ['Old-Family', 'Old-Family.ged', 'Sub', 'father-given', 'I2']);
      const members = (await pg.db.query('select email, user_id, role from tree_members order by email')).rows;
      assert.deepEqual(members, [
        { email: 'first@example.com', user_id: '77777777-7777-4777-8777-777777777777', role: 'owner' },
        { email: 'looker@example.com', user_id: null, role: 'viewer' },
        { email: 'second@example.com', user_id: null, role: 'editor' },
      ]);
      const snap = await loadTree(pg.db, t.id);
      assert.deepEqual(snap.data.order, ['I1', 'I2', 'I3']);
      assert.deepEqual(snap.data.families.F1, { id: 'F1', husb: 'I1', wife: 'I2', children: ['I3'], marrDate: '', marrPlace: '', extra: [] });
      assert.deepEqual(snap.settings, { homePersonId: 'I2', surnameRule: 'father-given' });
      const gone = await pg.db.query(`select to_regclass('tree_meta') as a, to_regclass('members') as b`);
      assert.deepEqual(gone.rows[0], { a: null, b: null });

      // Removing a person clears only that column of the family (tree_id stays), and child links cascade.
      await pg.db.query(`delete from people where id = 'I1'`);
      await pg.db.query(`delete from people where id = 'I3'`);
      const f = (await pg.db.query(`select tree_id, husband_id, wife_id from families where id = 'F1'`)).rows[0];
      assert.deepEqual(f, { tree_id: t.id, husband_id: null, wife_id: 'I2' });
      assert.equal((await pg.db.query('select count(*)::int as n from family_children')).rows[0].n, 0);
    } finally {
      await pg.stop();
    }
  });
});

describe('starting, renaming and deleting trees', () => {
  let mine: string;

  test('anyone signed in can start a tree and becomes its owner', async () => {
    const r = await call('POST', '/trees', { user: STRANGER, body: { name: '  The Newcomers  ', surnameRule: 'father-given' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual({ ...r.body, id: undefined }, { id: undefined, name: 'The Newcomers', role: 'owner', peopleCount: 0 });
    mine = r.body.id;
    const info = (await call('GET', `/trees/${mine}`, { user: STRANGER })).body;
    assert.deepEqual(info.settings, { homePersonId: null, surnameRule: 'father-given' });
    const me = (await call('GET', '/me', { user: STRANGER })).body;
    assert.deepEqual(me.trees.map((t: { id: string }) => t.id), [mine]);
    // Nobody else can see it.
    assert.equal((await call('GET', `/trees/${mine}`, { user: EDITOR })).status, 404);
  });

  test('a tree needs a name, and each account can start a limited number', async () => {
    assert.equal((await call('POST', '/trees', { user: STRANGER, body: { name: '   ' } })).status, 400);
    assert.equal((await call('POST', '/trees', { user: STRANGER, body: { name: 'Two' } })).status, 201);
    assert.equal((await call('POST', '/trees', { user: STRANGER, body: { name: 'Three' } })).status, 201);
    const fourth = await call('POST', '/trees', { user: STRANGER, body: { name: 'Four' } });
    assert.equal(fourth.status, 403);
    assert.match(fourth.body.error, /up to 3 trees/);
  });

  test('editors change settings, only owners rename', async () => {
    const asEditor = await call('PATCH', A(), { user: EDITOR, body: { name: 'Renamed by editor' } });
    assert.equal(asEditor.status, 403);
    assert.match(asEditor.body.error, /owners/);
    assert.equal(await treeName(db, treeA), 'Test family');
    const asOwner = await call('PATCH', A(), { user: OWNER, body: { name: 'The Test family' } });
    assert.equal(asOwner.status, 200, JSON.stringify(asOwner.body));
    assert.equal(asOwner.body.name, 'The Test family');
  });

  test('only an owner can delete, and only by typing the exact name', async () => {
    await call('POST', `/trees/${mine}/people`, {
      user: STRANGER,
      body: { id: 'I1', given: 'Someone', surname: '', marriedName: '', sex: 'U', birthDate: '', birthPlace: '',
              deceased: false, deathDate: '', deathPlace: '', notes: '', extra: [] },
    });
    assert.equal((await call('DELETE', A() + '?confirm=The%20Test%20family', { user: EDITOR })).status, 403);
    assert.equal((await call('DELETE', A() + '?confirm=The%20Test%20family', { user: VIEWER })).status, 403);
    const wrong = await call('DELETE', `/trees/${mine}?confirm=the%20newcomers`, { user: STRANGER });
    assert.equal(wrong.status, 400);
    assert.equal((await call('DELETE', `/trees/${mine}`, { user: STRANGER })).status, 400, 'confirm is required');
    const ok = await call('DELETE', `/trees/${mine}?confirm=The%20Newcomers`, { user: STRANGER });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await call('GET', `/trees/${mine}`, { user: STRANGER })).status, 404);
    assert.equal((await db.query('select count(*)::int as n from people where tree_id = $1', [mine])).rows[0].n, 0);
    const left = (await call('GET', '/me', { user: STRANGER })).body.trees.map((t: { name: string }) => t.name);
    assert.deepEqual(left, ['Two', 'Three']);
    // Deleting frees a slot under the per-account limit.
    assert.equal((await call('POST', '/trees', { user: STRANGER, body: { name: 'Four' } })).status, 201);
  });
});

describe('members', () => {
  const at = (email: string) => `${A()}/members/${encodeURIComponent(email)}`;
  const emails = (list: { email: string }[]) => list.map(m => m.email);

  test('every member can see who is in the tree; outsiders get 404', async () => {
    const r = await call('GET', A() + '/members', { user: VIEWER });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(emails(r.body), ['owner@example.com', 'editor@example.com', 'newbie@example.com', 'viewer@example.com']);
    const me = r.body.find((m: { email: string }) => m.email === 'viewer@example.com');
    assert.deepEqual({ ...me, addedAt: undefined }, {
      email: 'viewer@example.com', role: 'viewer', joined: true, you: true, addedAt: undefined,
      personId: null, claimedPersonId: null,
    });
    assert.equal(r.body.filter((m: { you: boolean }) => m.you).length, 1);
    assert.equal((await call('GET', A() + '/members', { user: STRANGER })).status, 404);
  });

  test('only owners add people, by email and role', async () => {
    const body = { email: '  Cousin@Example.COM ', role: 'viewer' };
    assert.equal((await call('POST', A() + '/members', { user: EDITOR, body })).status, 403);
    assert.equal((await call('POST', A() + '/members', { user: VIEWER, body })).status, 403);
    const r = await call('POST', A() + '/members', { user: OWNER, body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const cousin = r.body.find((m: { email: string }) => m.email === 'cousin@example.com');
    assert.equal(cousin.role, 'viewer');
    assert.equal(cousin.joined, false, 'pending until they sign in');
    const again = await call('POST', A() + '/members', { user: OWNER, body: { email: 'cousin@example.com', role: 'editor' } });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already a member/);
    for (const bad of [{ email: 'not an email', role: 'viewer' }, { email: 'x@example.com', role: 'admin' },
      { email: 'x@example.com' }, { email: 'x@example.com', role: 'viewer', extra: 1 }]) {
      assert.equal((await call('POST', A() + '/members', { user: OWNER, body: bad })).status, 400, JSON.stringify(bad));
    }
  });

  test('an invited person sees the tree after signing in with that email', async () => {
    const me = (await call('GET', '/me', { user: COUSIN })).body;
    assert.ok(me.trees.some((t: { id: string; role: string }) => t.id === treeA && t.role === 'viewer'));
    assert.equal((await call('GET', A() + '/tree', { user: COUSIN })).status, 200);
    const list = (await call('GET', A() + '/members', { user: OWNER })).body;
    assert.equal(list.find((m: { email: string }) => m.email === 'cousin@example.com').joined, true);
  });

  test('owners change roles, and the new role applies straight away', async () => {
    assert.equal((await call('POST', A() + '/changes', { user: COUSIN, body: {} })).status, 403);
    assert.equal((await call('PATCH', at('cousin@example.com'), { user: EDITOR, body: { role: 'editor' } })).status, 403);
    const r = await call('PATCH', at('Cousin@Example.com'), { user: OWNER, body: { role: 'editor' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call('POST', A() + '/changes', { user: COUSIN, body: {} })).status, 200);
    assert.equal((await call('PATCH', at('nobody@example.com'), { user: OWNER, body: { role: 'viewer' } })).status, 404);
  });

  test('the last owner cannot be demoted, removed or leave', async () => {
    const demote = await call('PATCH', at(OWNER.email), { user: OWNER, body: { role: 'editor' } });
    assert.equal(demote.status, 409);
    assert.match(demote.body.error, /at least one owner/);
    assert.equal((await call('DELETE', at(OWNER.email), { user: OWNER })).status, 409);
    assert.equal((await call('DELETE', A() + '/members/me', { user: OWNER })).status, 409);
    // With a second owner, the first one can step down; then hand it back.
    assert.equal((await call('PATCH', at(EDITOR.email), { user: OWNER, body: { role: 'owner' } })).status, 200);
    assert.equal((await call('PATCH', at(OWNER.email), { user: OWNER, body: { role: 'editor' } })).status, 200);
    assert.equal((await call('PATCH', at(EDITOR.email), { user: OWNER, body: { role: 'editor' } })).status, 403,
      'no longer an owner, so cannot manage members');
    assert.equal((await call('PATCH', at(OWNER.email), { user: EDITOR, body: { role: 'owner' } })).status, 200);
    assert.equal((await call('PATCH', at(EDITOR.email), { user: EDITOR, body: { role: 'editor' } })).status, 200);
    const roles = (await call('GET', A() + '/members', { user: OWNER })).body
      .filter((m: { role: string }) => m.role === 'owner').map((m: { email: string }) => m.email);
    assert.deepEqual(roles, [OWNER.email]);
  });

  test('removing someone takes away their access at once', async () => {
    const r = await call('DELETE', at('cousin@example.com'), { user: OWNER });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!emails(r.body).includes('cousin@example.com'));
    assert.equal((await call('GET', A() + '/tree', { user: COUSIN })).status, 404);
    assert.ok(!(await call('GET', '/me', { user: COUSIN })).body.trees.some((t: { id: string }) => t.id === treeA));
    assert.equal((await call('DELETE', at('cousin@example.com'), { user: OWNER })).status, 404);
  });

  test('any member can leave a tree', async () => {
    const r = await call('DELETE', A() + '/members/me', { user: NEWBIE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call('GET', A(), { user: NEWBIE })).status, 404);
    assert.ok(!emails((await call('GET', A() + '/members', { user: OWNER })).body).includes(NEWBIE.email));
  });

  test('a tree has a member limit', async () => {
    const small = await withTx(db, tx => createTree(tx, 'Small family', { email: OWNER.email, userId: OWNER.sub }));
    for (let i = 1; i <= 7; i++) {
      await db.query(`insert into tree_members (tree_id, email, role) values ($1, $2, 'viewer')`, [small, `m${i}@example.com`]);
    }
    const r = await call('POST', `/trees/${small}/members`, { user: OWNER, body: { email: 'ninth@example.com', role: 'viewer' } });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /up to 8 members/);
  });
});

describe('who you are in the tree', () => {
  // A fresh tree with the sample family: OWNER owns it, EDITOR edits, VIEWER and COUSIN view.
  let treeL: string;
  const L = () => `/trees/${treeL}`;
  const at = (email: string, what: string) => `${L()}/members/${encodeURIComponent(email)}/${what}`;
  const row = async (email: string) => (await db.query(
    'select person_id, claimed_person_id from tree_members where tree_id = $1 and email = $2', [treeL, email])).rows[0];

  before(async () => {
    treeL = await withTx(db, tx => createTree(tx, 'Linked family', { email: OWNER.email, userId: OWNER.sub }));
    await db.query(`insert into tree_members (tree_id, email, user_id, role) values ($1, $2, $3, 'editor'),
                    ($1, $4, $5, 'viewer'), ($1, $6, $7, 'viewer')`,
      [treeL, EDITOR.email, EDITOR.sub, 'viewer@example.com', VIEWER.sub, COUSIN.email, COUSIN.sub]);
    assert.equal((await call('POST', L() + '/import', { user: OWNER, body: importBody(sampleTree()) })).status, 200);
  });

  test('nobody is linked at first; the tree says so', async () => {
    const t = (await call('GET', L() + '/tree', { user: VIEWER })).body;
    assert.deepEqual(t.you, { personId: null, claimedPersonId: null });
    assert.equal(t.pendingClaims, 0);
    assert.deepEqual((await call('GET', L(), { user: VIEWER })).body.you, { personId: null, claimedPersonId: null });
  });

  test('a member\'s "This is me" waits for an owner; owners see how many are waiting', async () => {
    const r = await call('PUT', L() + '/members/me/claim', { user: VIEWER, body: { personId: 'I3' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.you, { personId: null, claimedPersonId: 'I3' });
    assert.equal(r.body.pendingClaims, 0, 'only owners are told about waiting claims');
    assert.equal((await call('GET', L() + '/tree', { user: OWNER })).body.pendingClaims, 1);
    const list = (await call('GET', L() + '/members', { user: OWNER })).body;
    assert.equal(list.find((m: { email: string }) => m.email === 'viewer@example.com').claimedPersonId, 'I3');
  });

  test('only owners approve, link or turn down claims', async () => {
    for (const user of [EDITOR, VIEWER]) {
      assert.equal((await call('PUT', at('viewer@example.com', 'person'), { user, body: { personId: 'I3' } })).status, 403);
      assert.equal((await call('DELETE', at('viewer@example.com', 'claim'), { user })).status, 403);
      assert.equal((await call('DELETE', at('viewer@example.com', 'person'), { user })).status, 403);
    }
    const r = await call('PUT', at('Viewer@Example.com', 'person'), { user: OWNER, body: { personId: 'I3' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await row('viewer@example.com'), { person_id: 'I3', claimed_person_id: null });
    const t = (await call('GET', L() + '/tree', { user: VIEWER })).body;
    assert.deepEqual(t.you, { personId: 'I3', claimedPersonId: null });
    assert.equal((await call('GET', L() + '/tree', { user: OWNER })).body.pendingClaims, 0);
  });

  test('a person can be linked to only one member', async () => {
    const claim = await call('PUT', L() + '/members/me/claim', { user: COUSIN, body: { personId: 'I3' } });
    assert.equal(claim.status, 409);
    assert.match(claim.body.error, /already linked to viewer@example.com/);
    const link = await call('PUT', at(COUSIN.email, 'person'), { user: OWNER, body: { personId: 'I3' } });
    assert.equal(link.status, 409);
    assert.deepEqual(await row(COUSIN.email), { person_id: null, claimed_person_id: null });
  });

  test('owners can turn a claim down, and members can take theirs back', async () => {
    assert.equal((await call('PUT', L() + '/members/me/claim', { user: COUSIN, body: { personId: 'I4' } })).status, 200);
    const r = await call('DELETE', at(COUSIN.email, 'claim'), { user: OWNER });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await row(COUSIN.email), { person_id: null, claimed_person_id: null });
    assert.equal((await call('PUT', L() + '/members/me/claim', { user: COUSIN, body: { personId: 'I4' } })).status, 200);
    const back = await call('DELETE', L() + '/members/me/claim', { user: COUSIN });
    assert.deepEqual(back.body.you, { personId: null, claimedPersonId: null });
  });

  test('owners are linked straight away, and can unlink anyone; members can unlink themselves', async () => {
    const r = await call('PUT', L() + '/members/me/claim', { user: OWNER, body: { personId: 'I1' } });
    assert.deepEqual(r.body.you, { personId: 'I1', claimedPersonId: null });
    assert.equal((await call('DELETE', L() + '/members/me/person', { user: OWNER })).status, 200);
    assert.deepEqual(await row(OWNER.email), { person_id: null, claimed_person_id: null });

    assert.equal((await call('PUT', at(EDITOR.email, 'person'), { user: OWNER, body: { personId: 'I2' } })).status, 200);
    assert.equal((await call('DELETE', at(EDITOR.email, 'person'), { user: OWNER })).status, 200);
    assert.deepEqual(await row(EDITOR.email), { person_id: null, claimed_person_id: null });

    const self = await call('DELETE', L() + '/members/me/person', { user: VIEWER });
    assert.deepEqual(self.body.you, { personId: null, claimedPersonId: null });
    assert.equal((await call('PUT', at(VIEWER.email, 'person'), { user: OWNER, body: { personId: 'I3' } })).status, 200);
  });

  test('unknown people, members and bad IDs are refused', async () => {
    assert.equal((await call('PUT', L() + '/members/me/claim', { user: COUSIN, body: { personId: 'I99' } })).status, 404);
    assert.equal((await call('PUT', L() + '/members/me/claim', { user: COUSIN, body: { personId: 'I 1' } })).status, 400);
    assert.equal((await call('PUT', L() + '/members/me/claim', { user: COUSIN, body: { personId: 'I4', x: 1 } })).status, 400);
    assert.equal((await call('PUT', at('nobody@example.com', 'person'), { user: OWNER, body: { personId: 'I4' } })).status, 404);
    assert.equal((await call('PUT', L() + '/members/me/claim', { user: STRANGER, body: { personId: 'I4' } })).status, 404);
  });

  test('deleting the person, or importing a new file, clears links and claims', async () => {
    assert.equal((await call('PUT', L() + '/members/me/claim', { user: COUSIN, body: { personId: 'I8' } })).status, 200);
    const t = (await call('GET', L() + '/tree', { user: OWNER })).body;
    assert.equal((await call('DELETE', `${L()}/people/I8?version=${t.versions.people.I8}`, { user: EDITOR })).status, 200);
    assert.deepEqual(await row(COUSIN.email), { person_id: null, claimed_person_id: null });
    assert.deepEqual(await row('viewer@example.com'), { person_id: 'I3', claimed_person_id: null }, 'others keep theirs');

    const r = await call('POST', L() + '/import', { user: OWNER, body: importBody(sampleTree()) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.you, { personId: null, claimedPersonId: null });
    assert.deepEqual(await row('viewer@example.com'), { person_id: null, claimed_person_id: null });
  });

  test('links never cross trees', async () => {
    assert.equal((await call('PUT', B() + '/members/me/claim', { user: VIEWER, body: { personId: 'I1' } })).status, 404);
    await assert.rejects(withTx(db, tx => tx.query(
      'update tree_members set person_id = $3 where tree_id = $1 and email = $2',
      [treeL, 'viewer@example.com', 'I_ONLY_IN_B'])));
  });

  // Later tests count the trees these accounts belong to.
  after(async () => { await db.query('delete from trees where id = $1', [treeL]); });
});

describe('limits', () => {
  const newPerson = (id: string) => ({
    id, given: 'P', surname: '', marriedName: '', sex: 'U', birthDate: '', birthPlace: '', deceased: false,
    deathDate: '', deathPlace: '', notes: '', extra: [], version: null,
  });

  test('a tree has a size limit for edits and imports, and a refused edit saves nothing', async () => {
    const t = await withTx(db, tx => createTree(tx, 'Big family', { email: OTHER.email, userId: OTHER.sub }));
    const tooMany = Array.from({ length: 31 }, (_, i) => newPerson(`I${i + 1}`));
    const r = await call('POST', `/trees/${t}/changes`, { user: OTHER, body: { upsertPeople: tooMany } });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /up to 30 people/);
    assert.equal((await loadTree(db, t)).data.order.length, 0);
    const imp = await call('POST', `/trees/${t}/import`, {
      user: OTHER,
      body: { fileName: 'big.ged', submitterName: '', people: tooMany.map(({ version: _v, ...p }) => p), families: [] },
    });
    assert.equal(imp.status, 403);
    const ok = await call('POST', `/trees/${t}/changes`, { user: OTHER, body: { upsertPeople: tooMany.slice(0, 30) } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const one = await call('POST', `/trees/${t}/people`, { user: OTHER, body: (({ version: _v, ...p }) => p)(newPerson('I99')) });
    assert.equal(one.status, 403);
  });

  test('starting trees too quickly is rate limited (429 with a readable message)', async () => {
    const api = await startApi({ rateLimits: { treesPerHour: 2 } });
    for (const name of ['R1', 'R2']) {
      assert.equal((await call('POST', '/trees', { base: api, user: NEWBIE, body: { name } })).status, 201);
    }
    const r = await call('POST', '/trees', { base: api, user: NEWBIE, body: { name: 'R3' } });
    assert.equal(r.status, 429);
    assert.match(r.body.error, /lot of trees/);
    assert.ok(r.headers.get('ratelimit-policy') || r.headers.get('ratelimit'), 'standard rate-limit headers are sent');
    // Other people are not affected.
    assert.equal((await call('POST', '/trees', { base: api, user: COUSIN, body: { name: 'C1' } })).status, 201);
  });

  test('saving very quickly is rate limited per person; reading is not', async () => {
    const api = await startApi({ rateLimits: { writesPerMinute: 3 } });
    const me = (await call('GET', '/me', { base: api, user: COUSIN })).body;
    const t = me.trees.find((x: { name: string }) => x.name === 'C1').id;
    for (let i = 0; i < 3; i++) {
      assert.equal((await call('POST', `/trees/${t}/changes`, { base: api, user: COUSIN, body: {} })).status, 200);
    }
    const r = await call('POST', `/trees/${t}/changes`, { base: api, user: COUSIN, body: {} });
    assert.equal(r.status, 429);
    assert.match(r.body.error, /very quickly/);
    for (let i = 0; i < 5; i++) assert.equal((await call('GET', `/trees/${t}/tree`, { base: api, user: COUSIN })).status, 200);
  });

  test('adding members too quickly is rate limited', async () => {
    const api = await startApi({ rateLimits: { invitesPerHour: 1 } });
    const me = (await call('GET', '/me', { base: api, user: COUSIN })).body;
    const t = me.trees.find((x: { name: string }) => x.name === 'C1').id;
    const add = (email: string) => call('POST', `/trees/${t}/members`, { base: api, user: COUSIN, body: { email, role: 'viewer' } });
    assert.equal((await add('one@example.com')).status, 201);
    const r = await add('two@example.com');
    assert.equal(r.status, 429);
    assert.match(r.body.error, /added a lot of people/);
  });

  test('too many requests from one address are refused before anything else', async () => {
    const api = await startApi({ rateLimits: { requestsPer5Min: 3 } });
    for (let i = 0; i < 3; i++) assert.equal((await call('GET', '/health', { base: api })).status, 200);
    assert.equal((await call('GET', '/health', { base: api })).status, 429);
    assert.equal((await call('GET', '/me', { base: api, user: COUSIN })).status, 429);
  });
});

describe('deleting your account', () => {
  test('you must type your email address', async () => {
    assert.equal((await call('DELETE', '/me', { user: EDITOR })).status, 400);
    assert.equal((await call('DELETE', '/me?confirm=someone@example.com', { user: EDITOR })).status, 400);
  });

  test('refused while you are the only owner of a tree other people use; nothing changes', async () => {
    const before = await db.query('select count(*)::int as n from tree_members where email = $1', [OWNER.email]);
    const r = await call('DELETE', `/me?confirm=${encodeURIComponent(OWNER.email)}`, { user: OWNER });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /only owner of .*The Test family/);
    const after = await db.query('select count(*)::int as n from tree_members where email = $1', [OWNER.email]);
    assert.equal(after.rows[0].n, before.rows[0].n);
  });

  test('removes your memberships, invitations and name on edits; other people\'s trees stay', async () => {
    // A pending invitation to the same address in another tree is removed too.
    const other = await withTx(db, tx => createTree(tx, 'Invited-only family', { email: OTHER.email, userId: OTHER.sub }));
    await db.query(`insert into tree_members (tree_id, email, role) values ($1, $2, 'viewer')`, [other, EDITOR.email]);
    const edited = await db.query('select count(*)::int as n from people where updated_by = $1', [EDITOR.email]);
    assert.ok(edited.rows[0].n > 0, 'the editor has edited people');

    const r = await call('DELETE', `/me?confirm=${encodeURIComponent(' Editor@Example.com ')}`, { user: EDITOR });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { deletedTrees: 0, leftTrees: 2 });

    for (const [sql, args] of [
      ['select count(*)::int as n from tree_members where email = $1', [EDITOR.email]],
      ['select count(*)::int as n from people where updated_by = $1', [EDITOR.email]],
      ['select count(*)::int as n from families where updated_by = $1', [EDITOR.email]],
    ] as const) {
      assert.equal((await db.query(sql, [...args])).rows[0].n, 0, sql);
    }
    assert.equal(Object.keys((await loadTree(db, treeA)).data.people).length > 0, true, 'the tree itself stays');
    assert.equal((await call('GET', A() + '/tree', { user: EDITOR })).status, 404);
    assert.deepEqual((await call('GET', '/me', { user: EDITOR })).body.trees, []);
  });

  test('trees only you belong to are deleted with everything in them', async () => {
    const mine = (await call('GET', '/me', { user: STRANGER })).body.trees.map((t: { id: string }) => t.id);
    assert.ok(mine.length >= 1);
    const r = await call('DELETE', `/me?confirm=${encodeURIComponent(STRANGER.email)}`, { user: STRANGER });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deletedTrees, mine.length);
    const left = await db.query('select count(*)::int as n from trees where id = any($1::uuid[])', [mine]);
    assert.equal(left.rows[0].n, 0);
    // Signing in again starts afresh.
    assert.deepEqual((await call('GET', '/me', { user: STRANGER })).body.trees, []);
  });
});
