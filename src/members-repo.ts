import type { Role } from './auth.ts';
import type { Db, Tx } from './db.ts';
import { HttpError } from './tree-repo.ts';

// Who belongs to a tree. People are added by email (pending until they first sign in, see claimInvitations in
// auth.ts). Every tree keeps at least one owner; changes take a lock on the tree row so two owners cannot demote
// each other at the same moment and leave the tree with none.

export interface MemberRow {
  email: string;
  role: Role;
  /** False until they sign in with this email for the first time. */
  joined: boolean;
  /** This is the signed-in user. */
  you: boolean;
  addedAt: string;
}

const LAST_OWNER = 'Every tree needs at least one owner. Make someone else an owner first.';

export async function listMembers(q: Db | Tx, treeId: string, userId: string): Promise<MemberRow[]> {
  const r = await q.query(
    `select email, role, user_id is not null as joined, user_id = $2 as you, created_at
     from tree_members where tree_id = $1
     order by case role when 'owner' then 0 when 'editor' then 1 else 2 end, email`, [treeId, userId]);
  return r.rows.map(m => ({
    email: m.email, role: m.role, joined: m.joined, you: m.you === true, addedAt: m.created_at.toISOString(),
  }));
}

/** Serialise member changes per tree for the rest of the transaction. */
async function lockTree(tx: Tx, treeId: string): Promise<void> {
  const r = await tx.query('select 1 from trees where id = $1 for update', [treeId]);
  if (!r.rowCount) throw new HttpError(404, 'This family tree was not found.');
}

async function roleOf(tx: Tx, treeId: string, email: string): Promise<Role | null> {
  const r = await tx.query('select role from tree_members where tree_id = $1 and email = $2', [treeId, email]);
  return r.rowCount ? r.rows[0].role : null;
}

async function otherOwners(tx: Tx, treeId: string, email: string): Promise<number> {
  const r = await tx.query(
    `select count(*)::int as n from tree_members where tree_id = $1 and role = 'owner' and email <> $2`, [treeId, email]);
  return r.rows[0].n;
}

export async function addMember(
  tx: Tx, treeId: string, m: { email: string; role: Role }, invitedBy: string, maxMembers: number,
): Promise<void> {
  await lockTree(tx, treeId);
  if (await roleOf(tx, treeId, m.email)) {
    throw new HttpError(409, `${m.email} is already a member of this tree. Change their role instead.`);
  }
  const count = (await tx.query('select count(*)::int as n from tree_members where tree_id = $1', [treeId])).rows[0].n;
  if (count >= maxMembers) throw new HttpError(403, `A tree can have up to ${maxMembers} members.`);
  await tx.query(
    'insert into tree_members (tree_id, email, role, invited_by) values ($1, $2, $3, $4)',
    [treeId, m.email, m.role, invitedBy]);
}

export async function changeRole(tx: Tx, treeId: string, email: string, role: Role): Promise<void> {
  await lockTree(tx, treeId);
  const current = await roleOf(tx, treeId, email);
  if (!current) throw new HttpError(404, `${email} is not a member of this tree.`);
  if (current === 'owner' && role !== 'owner' && !(await otherOwners(tx, treeId, email))) {
    throw new HttpError(409, LAST_OWNER);
  }
  await tx.query('update tree_members set role = $3 where tree_id = $1 and email = $2', [treeId, email, role]);
}

/** Remove someone (owners), or yourself (leaving). The last owner cannot go. */
export async function removeMember(tx: Tx, treeId: string, email: string): Promise<void> {
  await lockTree(tx, treeId);
  const current = await roleOf(tx, treeId, email);
  if (!current) throw new HttpError(404, `${email} is not a member of this tree.`);
  if (current === 'owner' && !(await otherOwners(tx, treeId, email))) {
    throw new HttpError(409, `${LAST_OWNER} To close the tree instead, delete it in Settings.`);
  }
  await tx.query('delete from tree_members where tree_id = $1 and email = $2', [treeId, email]);
}

/** The signed-in user's own membership row (found by user ID, so it works after an email change). */
export async function emailOfMember(q: Db | Tx, treeId: string, userId: string): Promise<string> {
  const r = await q.query('select email from tree_members where tree_id = $1 and user_id = $2', [treeId, userId]);
  if (!r.rowCount) throw new HttpError(404, 'You are not a member of this tree.');
  return r.rows[0].email;
}
