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
  /** The person in the tree they are linked to (approved), or null. */
  personId: string | null;
  /** The person they said "This is me" about, waiting for an owner to approve, or null. */
  claimedPersonId: string | null;
}

const LAST_OWNER = 'Every tree needs at least one owner. Make someone else an owner first.';

export async function listMembers(q: Db | Tx, treeId: string, userId: string): Promise<MemberRow[]> {
  const r = await q.query(
    `select email, role, user_id is not null as joined, user_id = $2 as you, created_at, person_id, claimed_person_id
     from tree_members where tree_id = $1
     order by case role when 'owner' then 0 when 'editor' then 1 else 2 end, email`, [treeId, userId]);
  return r.rows.map(m => ({
    email: m.email, role: m.role, joined: m.joined, you: m.you === true, addedAt: m.created_at.toISOString(),
    personId: m.person_id, claimedPersonId: m.claimed_person_id,
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

/* ---- which person in the tree each member is ---- */

// A member says "This is me" about a person (a claim); an owner approves it, which sets the link. Owners can also link
// any member directly, including themselves. Each person can be linked to one member per tree.

export interface MyLink {
  personId: string | null;
  claimedPersonId: string | null;
}

/** The signed-in user's link and pending claim in a tree. */
export async function linkOf(q: Db | Tx, treeId: string, userId: string): Promise<MyLink> {
  const r = await q.query(
    'select person_id, claimed_person_id from tree_members where tree_id = $1 and user_id = $2', [treeId, userId]);
  return r.rowCount
    ? { personId: r.rows[0].person_id, claimedPersonId: r.rows[0].claimed_person_id }
    : { personId: null, claimedPersonId: null };
}

/** How many "This is me" claims are waiting for an owner. */
export async function pendingClaims(q: Db | Tx, treeId: string): Promise<number> {
  const r = await q.query(
    'select count(*)::int as n from tree_members where tree_id = $1 and claimed_person_id is not null', [treeId]);
  return r.rows[0].n;
}

async function requirePerson(tx: Tx, treeId: string, personId: string): Promise<void> {
  const r = await tx.query('select 1 from people where tree_id = $1 and id = $2', [treeId, personId]);
  if (!r.rowCount) throw new HttpError(404, `Person ${personId} was not found. They may have been deleted.`);
}

/** 409 if someone other than `email` is already linked to this person. */
async function requireUnlinked(tx: Tx, treeId: string, personId: string, email: string): Promise<void> {
  const r = await tx.query(
    'select email from tree_members where tree_id = $1 and person_id = $2 and email <> $3', [treeId, personId, email]);
  if (r.rowCount) {
    throw new HttpError(409, `This person is already linked to ${r.rows[0].email}. An owner can unlink them first.`);
  }
}

async function requireMember(tx: Tx, treeId: string, email: string): Promise<void> {
  if (!(await roleOf(tx, treeId, email))) throw new HttpError(404, `${email} is not a member of this tree.`);
}

/** "This is me". Owners are linked straight away; everyone else waits for an owner to approve. */
export async function claimPerson(tx: Tx, treeId: string, email: string, personId: string): Promise<void> {
  await lockTree(tx, treeId);
  await requirePerson(tx, treeId, personId);
  await requireUnlinked(tx, treeId, personId, email);
  if (await roleOf(tx, treeId, email) === 'owner') {
    await linkPerson(tx, treeId, email, personId);
    return;
  }
  // Claiming the person you are already linked to just drops any other pending claim.
  await tx.query(
    `update tree_members set claimed_person_id = case when person_id = $3 then null else $3 end
     where tree_id = $1 and email = $2`, [treeId, email, personId]);
}

/** Owners: link a member to a person (approving their claim, or directly). Clears any pending claim. */
export async function linkPerson(tx: Tx, treeId: string, email: string, personId: string): Promise<void> {
  await lockTree(tx, treeId);
  await requireMember(tx, treeId, email);
  await requirePerson(tx, treeId, personId);
  await requireUnlinked(tx, treeId, personId, email);
  await tx.query(
    'update tree_members set person_id = $3, claimed_person_id = null where tree_id = $1 and email = $2',
    [treeId, email, personId]);
}

/** Remove a member's link (owners, or the member themselves). */
export async function unlinkPerson(tx: Tx, treeId: string, email: string): Promise<void> {
  await requireMember(tx, treeId, email);
  await tx.query('update tree_members set person_id = null where tree_id = $1 and email = $2', [treeId, email]);
}

/** Drop a pending claim (an owner turning it down, or the member taking it back). */
export async function dropClaim(tx: Tx, treeId: string, email: string): Promise<void> {
  await requireMember(tx, treeId, email);
  await tx.query('update tree_members set claimed_person_id = null where tree_id = $1 and email = $2', [treeId, email]);
}
