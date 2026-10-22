import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import type { Db } from './db.ts';

export interface AuthUser { id: string; email: string }
export type Role = 'viewer' | 'editor' | 'owner';
const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
/** The signed-in user and their role in the tree named in the URL. */
export interface Member extends AuthUser { treeId: string; role: Role }

/** Checks an access token and returns who it belongs to, or throws. */
export type VerifyToken = (token: string) => Promise<AuthUser>;

/**
 * Verify Supabase access tokens against the project's public signing keys (asymmetric JWT signing keys).
 * No Supabase secret is needed. `keys` can be swapped for a local key set in tests.
 */
export function supabaseVerifier(supabaseUrl: string, keys?: JWTVerifyGetKey): VerifyToken {
  const issuer = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1`;
  const jwks = keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async token => {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
    if (!payload.sub || typeof payload.email !== 'string' || !payload.email) throw new Error('Token has no user or email');
    return { id: payload.sub, email: payload.email.toLowerCase() };
  };
}

/** 401 without a valid token. Sets res.locals.user. Anyone who signs in may use the site (open sign-up). */
export function authenticate(verify: VerifyToken) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    try {
      if (!token) throw new Error('No token');
      res.locals.user = await verify(token);
    } catch {
      res.status(401).json({ error: 'Please sign in again.' });
      return;
    }
    next();
  };
}

/**
 * People are invited by email. The first time they sign in, every pending invitation for that address is linked to
 * their Supabase user ID, which is used from then on (so a later email change does not lock them out).
 */
export async function claimInvitations(db: Db, user: AuthUser): Promise<void> {
  await db.query(
    `update tree_members m set user_id = $1
     where m.email = $2 and m.user_id is null
       and not exists (select 1 from tree_members o where o.tree_id = m.tree_id and o.user_id = $1)`,
    [user.id, user.email]);
}

const TreeIdParam = z.uuid();
const NOT_FOUND = 'This family tree was not found, or you are not a member of it.';

/** The user's role in a tree, or null. Claims a pending invitation first if there is no linked membership yet. */
async function roleIn(db: Db, user: AuthUser, treeId: string): Promise<Role | null> {
  const find = () => db.query('select role from tree_members where tree_id = $1 and user_id = $2', [treeId, user.id]);
  let r = await find();
  if (!r.rowCount) {
    await claimInvitations(db, user);
    r = await find();
  }
  return r.rowCount ? r.rows[0].role : null;
}

/**
 * For routes under /api/trees/:treeId. A tree the user is not in answers 404, exactly like a tree that does not exist,
 * so tree IDs reveal nothing. Sets res.locals.member.
 */
export function requireTreeMember(db: Db) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user as AuthUser;
    const id = TreeIdParam.safeParse(req.params.treeId);
    const role = id.success ? await roleIn(db, user, id.data) : null;
    if (!id.success || !role) {
      res.status(404).json({ error: NOT_FOUND });
      return;
    }
    const member: Member = { ...user, treeId: id.data, role };
    res.locals.member = member;
    next();
  };
}

/** 403 unless the member's role is at least `min` (viewer < editor < owner). */
export function requireRole(min: Role) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (RANK[(res.locals.member as Member).role] < RANK[min]) {
      res.status(403).json({
        error: min === 'owner'
          ? "Only the tree's owners can do that."
          : 'You can view this tree but not change it. Ask an editor for edit access.',
      });
      return;
    }
    next();
  };
}
