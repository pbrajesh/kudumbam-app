import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { Family, Person } from './models.ts';
import {
  authenticate, claimInvitations, requireRole, requireTreeMember, type AuthUser, type Member, type VerifyToken,
} from './auth.ts';
import { deleteAccountData } from './account-repo.ts';
import { withTx, type Db, type Tx } from './db.ts';
import { DEFAULT_RATE_LIMITS, rateLimiters, type RateLimits } from './limits.ts';
import { addMember, changeRole, emailOfMember, listMembers, removeMember } from './members-repo.ts';
import {
  applyChanges, createTree, deleteTree, enforcePeopleLimit, HttpError, importTree, loadTree, renameTree, saveSettings,
  treeName, treesCreatedBy, treesOf, type TreeSnapshot,
} from './tree-repo.ts';
import {
  AddMemberSchema, ChangeRoleSchema, DeleteAccountQuery, ChangeSetSchema, CreateTreeSchema, DeleteTreeQuery, EmailSchema, FamilyPatchSchema,
  FamilySchema, Id, ImportSchema, LinkSchema, PersonPatchSchema, PersonSchema, TreePatchSchema, VersionQuery,
  type ChangeSet,
} from './validation.ts';

export interface AppOptions {
  db: Db;
  verify: VerifyToken;
  /** Browser origins allowed to call the API. Empty: same-origin only (e.g. behind the Angular dev proxy). */
  corsOrigins?: string[];
  /** How many trees one account may start (open sign-up). */
  maxTreesPerUser?: number;
  /** How many members (joined or invited) one tree may have. */
  maxMembersPerTree?: number;
  /** How many people one tree may hold. */
  maxPeoplePerTree?: number;
  rateLimits?: Partial<RateLimits>;
  /** Express "trust proxy" setting, so rate limits see the visitor's IP behind a hosting proxy (e.g. 1). */
  trustProxy?: boolean | number | string;
}

const noChanges = (): ChangeSet => ({ upsertPeople: [], deletePeople: [], upsertFamilies: [], deleteFamilies: [] });

export function createApp({
  db, verify, corsOrigins = [], maxTreesPerUser = 5, maxMembersPerTree = 200, maxPeoplePerTree = 20_000,
  rateLimits = {}, trustProxy,
}: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
    next();
  });
  if (corsOrigins.length) app.use('/api', cors({ origin: corsOrigins, maxAge: 600 }));
  const limits = rateLimiters({ ...DEFAULT_RATE_LIMITS, ...rateLimits });
  app.use('/api', limits.perIp);
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });

  const api = express.Router();
  api.use(authenticate(verify));
  api.use(limits.writes);
  const user = (res: Response) => res.locals.user as AuthUser;

  /* ---- the signed-in user and their trees ---- */

  /** Who you are and which trees you are in. Links any pending invitations to your account first. */
  api.get('/me', async (_req, res) => {
    await claimInvitations(db, user(res));
    res.json({ ...user(res), trees: await treesOf(db, user(res).id) });
  });

  /**
   * Delete everything stored about you (see account-repo.ts): leave every tree, delete trees only you are in.
   * Refused while you are the only owner of a tree other people use. ?confirm= must be your email address.
   */
  api.delete('/me', async (req, res) => {
    const { confirm } = DeleteAccountQuery.parse(req.query);
    const u = user(res);
    if (confirm !== u.email) throw new HttpError(400, 'To delete your account, type your email address exactly.');
    res.json(await withTx(db, tx => deleteAccountData(tx, u)));
  });

  /** Open sign-up: anyone signed in may start a tree (up to the per-account limit) and becomes its owner. */
  api.post('/trees', limits.trees, async (req, res) => {
    const { name, surnameRule } = CreateTreeSchema.parse(req.body);
    const u = user(res);
    const id = await withTx(db, async tx => {
      if (await treesCreatedBy(tx, u.id) >= maxTreesPerUser) {
        throw new HttpError(403, `You can start up to ${maxTreesPerUser} trees. Delete one you no longer need first.`);
      }
      return createTree(tx, name, { email: u.email, userId: u.id }, surnameRule);
    });
    res.status(201).json({ id, name, role: 'owner', peopleCount: 0 });
  });

  /* ---- one tree: /api/trees/:treeId/… ---- */

  const tree = express.Router({ mergeParams: true });
  tree.use(requireTreeMember(db));
  const member = (res: Response) => res.locals.member as Member;
  const editor = requireRole('editor');
  const owner = requireRole('owner');

  /** Load the current tree inside a transaction, build an edit from it, and apply it with version checks. */
  async function change(res: Response, build: (t: TreeSnapshot) => ChangeSet, status = 200) {
    const { treeId, email } = member(res);
    const versions = await withTx(db, tx => applyWithinLimits(tx, treeId, build, email));
    res.status(status).json({ versions });
  }
  /** Apply an edit; if it added people, check the tree is still within its size limit (else it is rolled back). */
  async function applyWithinLimits(tx: Tx, treeId: string, c: ChangeSet | ((t: TreeSnapshot) => ChangeSet), email: string) {
    const edit = typeof c === 'function' ? c(await loadTree(tx, treeId)) : c;
    const versions = await applyChanges(tx, treeId, edit, email);
    if (edit.upsertPeople.some(p => p.version === null)) await enforcePeopleLimit(tx, treeId, maxPeoplePerTree);
    return versions;
  }
  function family(t: TreeSnapshot, id: string): Family & { version: number } {
    const f = t.data.families[id];
    if (!f) throw new HttpError(404, `Family ${id} was not found. It may have been deleted.`);
    return { ...structuredClone(f), version: t.versions.families[id] };
  }
  function person(t: TreeSnapshot, id: string): Person & { version: number } {
    const p = t.data.people[id];
    if (!p) throw new HttpError(404, `Person ${id} was not found. They may have been deleted.`);
    return { ...structuredClone(p), version: t.versions.people[id] };
  }
  async function info(res: Response) {
    const { treeId, role } = member(res);
    const t = await loadTree(db, treeId);
    return {
      id: treeId, name: await treeName(db, treeId), role, fileName: t.fileName, settings: t.settings,
      peopleCount: t.data.order.length,
    };
  }

  tree.get('/', async (_req, res) => { res.json(await info(res)); });

  /** Settings (editors) and the tree's name (owners). */
  tree.patch('/', editor, async (req, res, next) => {
    const { name, ...settings } = TreePatchSchema.parse(req.body);
    if (name !== undefined && member(res).role !== 'owner') return owner(req, res, next);
    await withTx(db, async tx => {
      if (name !== undefined) await renameTree(tx, member(res).treeId, name);
      await saveSettings(tx, member(res).treeId, settings);
    });
    res.json(await info(res));
  });

  /** Owners only, with the tree's exact name as ?confirm=… so it cannot happen by accident. */
  tree.delete('/', owner, async (req, res) => {
    const { confirm } = DeleteTreeQuery.parse(req.query);
    const { treeId } = member(res);
    await withTx(db, async tx => {
      if (confirm.trim() !== await treeName(tx, treeId)) {
        throw new HttpError(400, 'To delete this tree, type its name exactly as it appears.');
      }
      await deleteTree(tx, treeId);
    });
    res.json({ deleted: treeId });
  });

  tree.get('/tree', async (_req, res) => {
    res.json({ ...(await loadTree(db, member(res).treeId)), role: member(res).role });
  });

  /** The app's main write path: one user action, all records it touches, in one transaction. */
  tree.post('/changes', editor, async (req, res) => {
    const c = ChangeSetSchema.parse(req.body);
    const { treeId, email } = member(res);
    res.json({ versions: await withTx(db, tx => applyWithinLimits(tx, treeId, c, email)) });
  });

  tree.post('/import', editor, async (req, res) => {
    const d = ImportSchema.parse(req.body);
    if (d.people.length > maxPeoplePerTree) throw new HttpError(403, `A tree can have up to ${maxPeoplePerTree} people.`);
    const { treeId, email, role } = member(res);
    await withTx(db, tx => importTree(tx, treeId, d, email));
    res.json({ ...(await loadTree(db, treeId)), role });
  });

  /* ---- people ---- */

  tree.post('/people', editor, async (req, res) => {
    const p = PersonSchema.parse(req.body);
    await change(res, () => ({ ...noChanges(), upsertPeople: [{ ...p, version: null }] }), 201);
  });

  tree.patch('/people/:id', editor, async (req, res) => {
    const id = Id.parse(req.params.id);
    const { version, ...patch } = PersonPatchSchema.parse(req.body);
    await change(res, t => ({ ...noChanges(), upsertPeople: [{ ...person(t, id), ...patch, id, version }] }));
  });

  /** Deleting a person also removes them from every family they were linked to. */
  tree.delete('/people/:id', editor, async (req, res) => {
    const id = Id.parse(req.params.id);
    const { version } = VersionQuery.parse(req.query);
    await change(res, t => {
      const linked = Object.values(t.data.families)
        .filter(f => f.husb === id || f.wife === id || f.children.includes(id))
        .map(f => {
          const next = family(t, f.id);
          if (next.husb === id) delete next.husb;
          if (next.wife === id) delete next.wife;
          next.children = next.children.filter(c => c !== id);
          return next;
        });
      return { ...noChanges(), upsertFamilies: linked, deletePeople: [{ id, version }] };
    });
  });

  /* ---- families ---- */

  tree.post('/families', editor, async (req, res) => {
    const f = FamilySchema.parse(req.body);
    await change(res, () => ({ ...noChanges(), upsertFamilies: [{ ...f, version: null }] }), 201);
  });

  tree.patch('/families/:id', editor, async (req, res) => {
    const id = Id.parse(req.params.id);
    const { version, ...patch } = FamilyPatchSchema.parse(req.body);
    await change(res, t => {
      const { version: _current, ...f } = family(t, id);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete (f as Record<string, unknown>)[k];
        else if (v !== undefined) (f as Record<string, unknown>)[k] = v;
      }
      return { ...noChanges(), upsertFamilies: [{ ...FamilySchema.parse(f), version }] };
    });
  });

  tree.delete('/families/:id', editor, async (req, res) => {
    const id = Id.parse(req.params.id);
    const { version } = VersionQuery.parse(req.query);
    await change(res, () => ({ ...noChanges(), deleteFamilies: [{ id, version }] }));
  });

  tree.post('/families/:id/children', editor, async (req, res) => {
    const id = Id.parse(req.params.id);
    const { personId, version } = LinkSchema.parse(req.body);
    await change(res, t => {
      const f = { ...family(t, id), version };
      person(t, personId);
      if (!f.children.includes(personId)) f.children.push(personId);
      return { ...noChanges(), upsertFamilies: [f] };
    });
  });

  tree.delete('/families/:id/children/:personId', editor, async (req, res) => {
    const id = Id.parse(req.params.id);
    const personId = Id.parse(req.params.personId);
    const { version } = VersionQuery.parse(req.query);
    await change(res, t => {
      const f = { ...family(t, id), version };
      f.children = f.children.filter(c => c !== personId);
      return { ...noChanges(), upsertFamilies: [f] };
    });
  });

  /** Add a spouse: men go in HUSB, women in WIFE, unknown sex in whichever slot is free. */
  tree.post('/families/:id/spouses', editor, async (req, res) => {
    const id = Id.parse(req.params.id);
    const { personId, version } = LinkSchema.parse(req.body);
    await change(res, t => {
      const f = { ...family(t, id), version };
      const p = person(t, personId);
      if (f.husb === personId || f.wife === personId) return { ...noChanges(), upsertFamilies: [f] };
      const slot = p.sex === 'M' ? 'husb' : p.sex === 'F' ? 'wife' : (f.husb ? 'wife' : 'husb');
      if (f[slot]) throw new HttpError(409, `Family ${id} already has a ${slot === 'husb' ? 'husband' : 'wife'}.`);
      f[slot] = personId;
      return { ...noChanges(), upsertFamilies: [f] };
    });
  });

  tree.delete('/families/:id/spouses/:personId', editor, async (req, res) => {
    const id = Id.parse(req.params.id);
    const personId = Id.parse(req.params.personId);
    const { version } = VersionQuery.parse(req.query);
    await change(res, t => {
      const f = { ...family(t, id), version };
      if (f.husb === personId) delete f.husb;
      if (f.wife === personId) delete f.wife;
      return { ...noChanges(), upsertFamilies: [f] };
    });
  });

  /* ---- members ---- */

  const members = (res: Response) => listMembers(db, member(res).treeId, member(res).id);

  /** Every member can see who else is in the tree (emails are shown to members only). */
  tree.get('/members', async (_req, res) => { res.json(await members(res)); });

  /** Owners add people by email; they join when they first sign in with that address. */
  tree.post('/members', owner, limits.invites, async (req, res) => {
    const m = AddMemberSchema.parse(req.body);
    await withTx(db, tx => addMember(tx, member(res).treeId, m, member(res).id, maxMembersPerTree));
    res.status(201).json(await members(res));
  });

  /** Any member may leave, except the last owner. Declared before /members/:email so "me" is not read as an email. */
  tree.delete('/members/me', async (_req, res) => {
    const { treeId, id } = member(res);
    await withTx(db, async tx => removeMember(tx, treeId, await emailOfMember(tx, treeId, id)));
    res.json({ left: treeId });
  });

  tree.patch('/members/:email', owner, async (req, res) => {
    const email = EmailSchema.parse(req.params.email);
    const { role } = ChangeRoleSchema.parse(req.body);
    await withTx(db, tx => changeRole(tx, member(res).treeId, email, role));
    res.json(await members(res));
  });

  tree.delete('/members/:email', owner, async (req, res) => {
    const email = EmailSchema.parse(req.params.email);
    await withTx(db, tx => removeMember(tx, member(res).treeId, email));
    res.json(await members(res));
  });

  api.use('/trees/:treeId', tree);
  app.use('/api', api);
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });
  app.use(errorHandler);
  return app;
}

function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const i = err.issues[0];
    res.status(400).json({ error: `Invalid ${i.path.join('.') || 'request'}: ${i.message}` });
  } else if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
  } else if (isPgError(err) && (err.code === '23505' || err.code === '23503')) {
    // Unique or foreign-key violation: two people edited the same records at once.
    res.status(409).json({ error: 'Someone else changed this part of the tree. Reload to see the latest version, then try again.' });
  } else if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'The request body is not valid JSON.' });
  } else if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'That is too much data for one request.' });
  } else {
    // Log the route and the error only: never request bodies (names, notes) or member emails from the URL.
    const route = req.originalUrl.split('?')[0].replace(/\/members\/(?!me$)[^/]+/, '/members/:email');
    console.error(`500 ${req.method} ${route}`, err instanceof Error ? err.stack : String(err));
    res.status(500).json({ error: 'Something went wrong on the server.' });
  }
}

function isPgError(e: unknown): e is { code: string } {
  return typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string';
}
