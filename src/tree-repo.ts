import type { Family, Person, SurnameRule, TreeData, TreeSettings } from './models.ts';
import type { Db, Tx } from './db.ts';
import type { ChangeSet, ImportData } from './validation.ts';

// Every function here takes the tree ID first and every statement filters on it, so one family's request can
// never read or change another family's rows. Composite foreign keys (tree_id, id) back this up in the database.

export interface Versions {
  people: Record<string, number>;
  families: Record<string, number>;
}
export interface TreeSnapshot {
  data: TreeData;
  versions: Versions;
  fileName: string;
  settings: TreeSettings;
}

export const SURNAME_RULES: SurnameRule[] = ['father-given', 'father-surname', 'none'];

/** An HTTP error with a status code and a message that is safe to show the user. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STALE = 'Someone else changed this part of the tree. Reload to see the latest version, then try again.';

export async function loadTree(q: Db | Tx, treeId: string): Promise<TreeSnapshot> {
  // One after another: inside a transaction they share a single connection.
  const tree = await q.query('select * from trees where id = $1', [treeId]);
  if (!tree.rowCount) throw new HttpError(404, 'This family tree was not found.');
  const people = await q.query('select * from people where tree_id = $1 order by seq', [treeId]);
  const families = await q.query('select * from families where tree_id = $1 order by seq', [treeId]);
  const children = await q.query(
    'select family_id, person_id from family_children where tree_id = $1 order by family_id, position', [treeId]);
  const t = tree.rows[0];
  const data: TreeData = { people: {}, families: {}, order: [], submitterName: t.submitter_name };
  const versions: Versions = { people: {}, families: {} };

  for (const r of people.rows) {
    data.people[r.id] = {
      id: r.id, given: r.given, surname: r.surname, marriedName: r.married_name, sex: r.sex,
      birthDate: r.birth_date, birthPlace: r.birth_place, deceased: r.deceased,
      deathDate: r.death_date, deathPlace: r.death_place, notes: r.notes, extra: r.extra,
    };
    data.order.push(r.id);
    versions.people[r.id] = r.version;
  }
  for (const r of families.rows) {
    const f: Family = {
      id: r.id, children: [], marrDate: r.marriage_date, marrPlace: r.marriage_place, extra: r.extra,
    };
    if (r.husband_id) f.husb = r.husband_id;
    if (r.wife_id) f.wife = r.wife_id;
    if (r.is_current !== null) f.current = r.is_current;
    data.families[r.id] = f;
    versions.families[r.id] = r.version;
  }
  for (const r of children.rows) data.families[r.family_id]?.children.push(r.person_id);

  const settings: TreeSettings = {
    homePersonId: t.home_person_id && data.people[t.home_person_id] ? t.home_person_id : null,
    surnameRule: SURNAME_RULES.includes(t.surname_rule) ? t.surname_rule : 'father-surname',
  };
  return { data, versions, fileName: t.file_name, settings };
}

/** Save tree settings. A home person must be in this tree; null clears it. */
export async function saveSettings(tx: Tx, treeId: string, s: Partial<TreeSettings>): Promise<void> {
  if (s.homePersonId) {
    const r = await tx.query('select 1 from people where tree_id = $1 and id = $2', [treeId, s.homePersonId]);
    if (!r.rowCount) throw new HttpError(400, `Person ${s.homePersonId} is not in the tree.`);
  }
  if (s.homePersonId !== undefined) {
    await tx.query('update trees set home_person_id = $2 where id = $1', [treeId, s.homePersonId]);
  }
  if (s.surnameRule) await tx.query('update trees set surname_rule = $2 where id = $1', [treeId, s.surnameRule]);
}

/* ---------------- writes ---------------- */

function personParams(treeId: string, p: Person): unknown[] {
  return [treeId, p.id, p.given, p.surname, p.marriedName, p.sex, p.birthDate, p.birthPlace, p.deceased,
    p.deathDate, p.deathPlace, p.notes, JSON.stringify(p.extra)];
}

async function insertPerson(tx: Tx, treeId: string, p: Person, by: string): Promise<number> {
  const r = await tx.query(
    `insert into people (tree_id, id, given, surname, married_name, sex, birth_date, birth_place, deceased,
                         death_date, death_place, notes, extra, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
     on conflict (tree_id, id) do nothing returning version`,
    [...personParams(treeId, p), by]);
  if (!r.rowCount) throw new HttpError(409, STALE);
  return r.rows[0].version;
}

async function updatePerson(tx: Tx, treeId: string, p: Person, version: number, by: string): Promise<number> {
  const r = await tx.query(
    `update people set given = $3, surname = $4, married_name = $5, sex = $6, birth_date = $7, birth_place = $8,
            deceased = $9, death_date = $10, death_place = $11, notes = $12, extra = $13::jsonb,
            version = version + 1, updated_by = $14, updated_at = now()
     where tree_id = $1 and id = $2 and version = $15 returning version`,
    [...personParams(treeId, p), by, version]);
  if (!r.rowCount) throw new HttpError(409, STALE);
  return r.rows[0].version;
}

function familyParams(treeId: string, f: Family): unknown[] {
  return [treeId, f.id, f.husb ?? null, f.wife ?? null, f.marrDate, f.marrPlace, f.current ?? null,
    JSON.stringify(f.extra)];
}

async function writeChildren(tx: Tx, treeId: string, f: Family): Promise<void> {
  await tx.query('delete from family_children where tree_id = $1 and family_id = $2', [treeId, f.id]);
  if (!f.children.length) return;
  await tx.query(
    `insert into family_children (tree_id, family_id, person_id, position)
     select $1, $2, c.person_id, c.position - 1 from unnest($3::text[]) with ordinality as c(person_id, position)`,
    [treeId, f.id, f.children]);
}

async function insertFamily(tx: Tx, treeId: string, f: Family, by: string): Promise<number> {
  const r = await tx.query(
    `insert into families (tree_id, id, husband_id, wife_id, marriage_date, marriage_place, is_current, extra, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     on conflict (tree_id, id) do nothing returning version`,
    [...familyParams(treeId, f), by]);
  if (!r.rowCount) throw new HttpError(409, STALE);
  await writeChildren(tx, treeId, f);
  return r.rows[0].version;
}

async function updateFamily(tx: Tx, treeId: string, f: Family, version: number, by: string): Promise<number> {
  const r = await tx.query(
    `update families set husband_id = $3, wife_id = $4, marriage_date = $5, marriage_place = $6, is_current = $7,
            extra = $8::jsonb, version = version + 1, updated_by = $9, updated_at = now()
     where tree_id = $1 and id = $2 and version = $10 returning version`,
    [...familyParams(treeId, f), by, version]);
  if (!r.rowCount) throw new HttpError(409, STALE);
  await writeChildren(tx, treeId, f);
  return r.rows[0].version;
}

/**
 * Apply one edit. People are written first so new families can point at them, deletions last.
 * Every record carries the version the client last saw; a mismatch means someone else changed it (409).
 */
export async function applyChanges(tx: Tx, treeId: string, c: ChangeSet, by: string): Promise<Versions> {
  const out: Versions = { people: {}, families: {} };
  for (const { version, ...p } of c.upsertPeople) {
    out.people[p.id] = version === null
      ? await insertPerson(tx, treeId, p, by)
      : await updatePerson(tx, treeId, p, version, by);
  }
  for (const { version, ...f } of c.upsertFamilies) {
    out.families[f.id] = version === null
      ? await insertFamily(tx, treeId, f, by)
      : await updateFamily(tx, treeId, f, version, by);
  }
  for (const { id, version } of c.deleteFamilies) {
    const r = await tx.query('delete from families where tree_id = $1 and id = $2 and version = $3', [treeId, id, version]);
    if (!r.rowCount) throw new HttpError(409, STALE);
  }
  for (const { id, version } of c.deletePeople) {
    // Families still pointing at this person lose the link below; bump them so other editors see the change.
    const touched = await tx.query(
      `update families set version = version + 1, updated_by = $3, updated_at = now()
       where tree_id = $1 and (husband_id = $2 or wife_id = $2
          or id in (select family_id from family_children where tree_id = $1 and person_id = $2))
       returning id, version`, [treeId, id, by]);
    for (const r of touched.rows) out.families[r.id] = r.version;
    const r = await tx.query('delete from people where tree_id = $1 and id = $2 and version = $3', [treeId, id, version]);
    if (!r.rowCount) throw new HttpError(409, STALE);
  }
  return out;
}

/** Call inside the transaction after adding people: refuses (and so rolls back) if the tree is now too big. */
export async function enforcePeopleLimit(tx: Tx, treeId: string, max: number): Promise<void> {
  const n = (await tx.query('select count(*)::int as n from people where tree_id = $1', [treeId])).rows[0].n;
  if (n > max) throw new HttpError(403, `A tree can have up to ${max} people.`);
}

/** Replace the whole tree with an imported file. Other trees are untouched. */
export async function importTree(tx: Tx, treeId: string, d: ImportData, by: string): Promise<void> {
  const ids = new Set(d.people.map(p => p.id));
  if (ids.size !== d.people.length) throw new HttpError(400, 'The file lists the same person ID twice.');
  const famIds = new Set(d.families.map(f => f.id));
  if (famIds.size !== d.families.length) throw new HttpError(400, 'The file lists the same family ID twice.');
  for (const f of d.families) {
    for (const pid of [f.husb, f.wife, ...f.children]) {
      if (pid && !ids.has(pid)) throw new HttpError(400, `Family ${f.id} refers to ${pid}, who is not in the file.`);
    }
  }

  await tx.query('delete from family_children where tree_id = $1', [treeId]);
  await tx.query('delete from families where tree_id = $1', [treeId]);
  await tx.query('delete from people where tree_id = $1', [treeId]);
  for (const p of d.people) await insertPerson(tx, treeId, p, by);
  for (const f of d.families) await insertFamily(tx, treeId, f, by);
  // IDs in a new file mean different people, so the old home person no longer applies.
  await tx.query(
    'update trees set file_name = $2, submitter_name = $3, home_person_id = null where id = $1',
    [treeId, d.fileName, d.submitterName]);
}

export interface TreeSummary {
  id: string;
  name: string;
  role: 'viewer' | 'editor' | 'owner';
  peopleCount: number;
}

/** The trees a user belongs to, oldest membership first. */
export async function treesOf(q: Db | Tx, userId: string): Promise<TreeSummary[]> {
  const r = await q.query(
    `select t.id, t.name, m.role, (select count(*) from people p where p.tree_id = t.id)::int as people_count
     from tree_members m join trees t on t.id = m.tree_id
     where m.user_id = $1 order by m.created_at, t.created_at`, [userId]);
  return r.rows.map(row => ({ id: row.id, name: row.name, role: row.role, peopleCount: row.people_count }));
}

/** How many trees this user has started (for the per-user limit). */
export async function treesCreatedBy(q: Db | Tx, userId: string): Promise<number> {
  return (await q.query('select count(*)::int as n from trees where created_by = $1', [userId])).rows[0].n;
}

export async function treeName(q: Db | Tx, treeId: string): Promise<string> {
  const r = await q.query('select name from trees where id = $1', [treeId]);
  if (!r.rowCount) throw new HttpError(404, 'This family tree was not found.');
  return r.rows[0].name;
}

export async function renameTree(tx: Tx, treeId: string, name: string): Promise<void> {
  await tx.query('update trees set name = $2 where id = $1', [treeId, name]);
}

/** Delete a tree and everything in it (people, families, links, members) — foreign keys cascade. */
export async function deleteTree(tx: Tx, treeId: string): Promise<void> {
  await tx.query('delete from trees where id = $1', [treeId]);
}

/** Create an empty tree with its first owner. Returns the new tree's ID. */
export async function createTree(
  tx: Tx, name: string, owner: { email: string; userId?: string | null }, surnameRule: SurnameRule = 'father-surname',
): Promise<string> {
  const t = await tx.query('insert into trees (name, created_by, surname_rule) values ($1, $2, $3) returning id',
    [name, owner.userId ?? null, surnameRule]);
  const id: string = t.rows[0].id;
  await tx.query(
    `insert into tree_members (tree_id, email, user_id, role, invited_by) values ($1, $2, $3, 'owner', $3)`,
    [id, owner.email.toLowerCase(), owner.userId ?? null]);
  return id;
}
