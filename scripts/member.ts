// Manage trees and who can use them (until the app has a Members screen):
//   npm run member -- trees
//   npm run member -- create-tree "The Example family" owner@example.com
//   npm run member -- add someone@example.com [viewer|editor|owner] [--tree <tree id or name>]
//   npm run member -- remove someone@example.com [--tree <tree id or name>]
//   npm run member -- list [--tree <tree id or name>]
// --tree can be left out when there is only one tree.
import { createPool, migrate, withTx, type Db } from '../src/db.ts';
import { createTree } from '../src/tree-repo.ts';

const args = process.argv.slice(2);
const treeFlag = args.indexOf('--tree');
const treeArg = treeFlag >= 0 ? args.splice(treeFlag, 2)[1] : undefined;
const [cmd, a1, a2] = args;
const ROLES = ['viewer', 'editor', 'owner'];
const usage = `Usage:
  npm run member -- trees
  npm run member -- create-tree "<tree name>" <owner email>
  npm run member -- add <email> [viewer|editor|owner] [--tree <id or name>]
  npm run member -- remove <email> [--tree <id or name>]
  npm run member -- list [--tree <id or name>]`;

class UsageError extends Error {}

if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL (see server/.env.example).'); process.exit(1); }
const db = createPool(process.env.DATABASE_URL, 1);
await migrate(db);

/** The tree named by --tree (ID or exact name), or the only tree there is. */
async function pickTree(db: Db): Promise<{ id: string; name: string }> {
  const all = (await db.query('select id, name from trees order by created_at')).rows;
  if (treeArg) {
    const t = all.find(x => x.id === treeArg || x.name.toLowerCase() === treeArg.toLowerCase());
    if (!t) throw new UsageError(`No tree "${treeArg}". See: npm run member -- trees`);
    return t;
  }
  if (all.length === 1) return all[0];
  if (!all.length) throw new UsageError('There are no trees yet. Create one: npm run member -- create-tree "<name>" <owner email>');
  throw new UsageError(`There are ${all.length} trees; say which with --tree. See: npm run member -- trees`);
}

async function ownersLeftWithout(db: Db, treeId: string, email: string): Promise<number> {
  const r = await db.query(
    `select count(*)::int as n from tree_members where tree_id = $1 and role = 'owner' and email <> $2`, [treeId, email]);
  return r.rows[0].n;
}

try {
  const email = (cmd === 'create-tree' ? a2 : a1)?.trim().toLowerCase();
  if (cmd === 'trees') {
    const r = await db.query(
      `select t.id, t.name, (select count(*) from people p where p.tree_id = t.id)::int as people,
              (select count(*) from tree_members m where m.tree_id = t.id)::int as members
       from trees t order by t.created_at`);
    if (!r.rowCount) console.log('No trees yet. Create one: npm run member -- create-tree "<name>" <owner email>');
    for (const t of r.rows) console.log(`${t.id}  ${t.name}  (${t.people} people, ${t.members} members)`);
  } else if (cmd === 'create-tree' && a1?.trim() && email?.includes('@')) {
    const id = await withTx(db, tx => createTree(tx, a1.trim(), { email }));
    console.log(`Created "${a1.trim()}" (${id}) with ${email} as owner.`);
  } else if (cmd === 'add' && email?.includes('@') && ROLES.includes(a2 ?? 'viewer')) {
    const role = a2 ?? 'viewer';
    const t = await pickTree(db);
    if (role !== 'owner' && !(await ownersLeftWithout(db, t.id, email))) {
      throw new UsageError(`${email} is the only owner of "${t.name}". Make someone else an owner first.`);
    }
    await db.query(
      `insert into tree_members (tree_id, email, role) values ($1, $2, $3)
       on conflict (tree_id, email) do update set role = excluded.role`, [t.id, email, role]);
    console.log(`${email} can now ${role === 'viewer' ? 'view' : role === 'editor' ? 'view and edit' : 'view, edit and manage'} "${t.name}" (${role}).`);
  } else if (cmd === 'remove' && email) {
    const t = await pickTree(db);
    if (!(await ownersLeftWithout(db, t.id, email))) {
      const isOwner = await db.query(`select 1 from tree_members where tree_id = $1 and email = $2 and role = 'owner'`, [t.id, email]);
      if (isOwner.rowCount) throw new UsageError(`${email} is the only owner of "${t.name}". Make someone else an owner first.`);
    }
    const r = await db.query('delete from tree_members where tree_id = $1 and email = $2', [t.id, email]);
    console.log(r.rowCount ? `Removed ${email} from "${t.name}".` : `${email} was not a member of "${t.name}".`);
  } else if (cmd === 'list') {
    const t = await pickTree(db);
    const r = await db.query(
      'select email, role, user_id is not null as signed_in from tree_members where tree_id = $1 order by role desc, email',
      [t.id]);
    console.log(`"${t.name}" (${t.id})`);
    for (const m of r.rows) console.log(`  ${m.role.padEnd(7)} ${m.email}${m.signed_in ? '' : '  (not signed in yet)'}`);
  } else {
    throw new UsageError(usage);
  }
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
