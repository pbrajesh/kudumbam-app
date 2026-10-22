import type { AuthUser } from './auth.ts';
import type { Tx } from './db.ts';
import { HttpError } from './tree-repo.ts';

/**
 * "Delete my account": remove everything this site stores about a user.
 * - Leaves every tree (and drops invitations sent to their email that they never used).
 * - Trees where they are the only member are deleted with everything in them.
 * - Trees where they are the only owner but others are members are NOT touched: the request is refused until they
 *   make someone else an owner or delete the tree, so nobody else loses a tree they rely on.
 * - Their email is removed from "last changed by" on people and families; their user ID from "created by" and
 *   "invited by".
 * The sign-in account itself lives at Supabase; removing it needs the site operator (see the privacy page).
 */
export async function deleteAccountData(tx: Tx, user: AuthUser): Promise<{ deletedTrees: number; leftTrees: number }> {
  const rows = (await tx.query(
    `select m.tree_id, m.email, m.role, t.name from tree_members m join trees t on t.id = m.tree_id
     where m.user_id = $1 or (m.user_id is null and m.email = $2)
     order by t.name for update of t`, [user.id, user.email])).rows;

  const blocked: string[] = [];
  const toDelete: string[] = [];
  for (const r of rows) {
    if (r.role !== 'owner') continue;
    const others = (await tx.query(
      `select count(*) filter (where role = 'owner')::int as owners, count(*)::int as members
       from tree_members where tree_id = $1 and email <> $2`, [r.tree_id, r.email])).rows[0];
    if (others.owners > 0) continue;
    if (others.members > 0) blocked.push(r.name);
    else toDelete.push(r.tree_id);
  }
  if (blocked.length) {
    const list = blocked.map(n => `“${n}”`).join(', ');
    throw new HttpError(409, `You are the only owner of ${list}, which other people use. ` +
      `Make someone else an owner there, or delete ${blocked.length === 1 ? 'that tree' : 'those trees'}, first.`);
  }

  if (toDelete.length) await tx.query('delete from trees where id = any($1::uuid[])', [toDelete]);
  const left = await tx.query('delete from tree_members where user_id = $1 or email = $2', [user.id, user.email]);
  await tx.query('update people set updated_by = null where updated_by = $1', [user.email]);
  await tx.query('update families set updated_by = null where updated_by = $1', [user.email]);
  await tx.query('update trees set created_by = null where created_by = $1', [user.id]);
  await tx.query('update tree_members set invited_by = null where invited_by = $1', [user.id]);
  return { deletedTrees: toDelete.length, leftTrees: left.rowCount ?? 0 };
}
