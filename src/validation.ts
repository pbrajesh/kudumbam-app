import { z } from 'zod';
import type { GedNode } from './models.ts';

export const Id = z.string().regex(/^[A-Za-z0-9_]{1,20}$/, 'IDs are letters, digits or _ (max 20), e.g. I12 or F3');
const Text = z.string().max(500);
const Version = z.number().int().positive();

export const GedNodeSchema: z.ZodType<GedNode> = z.lazy(() => z.object({
  level: z.number().int().min(0).max(99),
  xref: z.string().max(40).optional(),
  tag: z.string().min(1).max(40),
  value: z.string().max(4000),
  children: z.array(GedNodeSchema).max(500),
}));

export const PersonSchema = z.object({
  id: Id,
  given: Text,
  surname: Text,
  marriedName: Text,
  sex: z.enum(['M', 'F', 'U']),
  birthDate: Text,
  birthPlace: Text,
  deceased: z.boolean(),
  deathDate: Text,
  deathPlace: Text,
  notes: z.string().max(20_000),
  extra: z.array(GedNodeSchema).max(500),
}).strict();

export const FamilySchema = z.object({
  id: Id,
  husb: Id.optional(),
  wife: Id.optional(),
  children: z.array(Id).max(500).refine(c => new Set(c).size === c.length, 'A child is listed twice'),
  marrDate: Text,
  marrPlace: Text,
  current: z.boolean().optional(),
  extra: z.array(GedNodeSchema).max(500),
}).strict().refine(f => !f.husb || f.husb !== f.wife, 'Husband and wife must be different people');

const Deletion = z.object({ id: Id, version: Version }).strict();

/** One edit from the app: every record it touches, applied in a single transaction. */
export const ChangeSetSchema = z.object({
  upsertPeople: z.array(PersonSchema.and(z.object({ version: Version.nullable() }))).max(10_000).default([]),
  deletePeople: z.array(Deletion).max(10_000).default([]),
  upsertFamilies: z.array(FamilySchema.and(z.object({ version: Version.nullable() }))).max(10_000).default([]),
  deleteFamilies: z.array(Deletion).max(10_000).default([]),
}).strict();
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

export const ImportSchema = z.object({
  fileName: z.string().max(200),
  submitterName: z.string().max(200),
  people: z.array(PersonSchema).min(1).max(10_000),
  families: z.array(FamilySchema).max(10_000),
}).strict();
export type ImportData = z.infer<typeof ImportSchema>;

export const PersonPatchSchema = PersonSchema.omit({ id: true }).partial().extend({ version: Version }).strict();
export const FamilyPatchSchema = z.object({
  husb: Id.nullable().optional(),
  wife: Id.nullable().optional(),
  children: z.array(Id).max(500).optional(),
  marrDate: Text.optional(),
  marrPlace: Text.optional(),
  current: z.boolean().nullable().optional(),
  extra: z.array(GedNodeSchema).max(500).optional(),
  version: Version,
}).strict();
const SurnameRuleSchema = z.enum(['father-given', 'father-surname', 'none']);
const TreeNameSchema = z.string().trim().min(1, 'Give the tree a name').max(200);

export const CreateTreeSchema = z.object({
  name: TreeNameSchema,
  surnameRule: SurnameRuleSchema.optional(),
}).strict();

/** Renaming needs an owner; the settings need an editor. */
export const TreePatchSchema = z.object({
  name: TreeNameSchema.optional(),
  homePersonId: Id.nullable().optional(),
  surnameRule: SurnameRuleSchema.optional(),
}).strict();

const RoleSchema = z.enum(['viewer', 'editor', 'owner']);
/** Emails are compared lower-case everywhere (they are claimed at sign-in by the address Supabase verified). */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email('That does not look like an email address').max(254));

export const AddMemberSchema = z.object({ email: EmailSchema, role: RoleSchema }).strict();
export const ChangeRoleSchema = z.object({ role: RoleSchema }).strict();

/** Deleting your account needs your email address typed back. */
export const DeleteAccountQuery = z.object({ confirm: z.string().trim().toLowerCase() });

/** Deleting a tree needs its exact name typed back, so it cannot happen by accident. */
export const DeleteTreeQuery = z.object({ confirm: z.string() });
/** "This is me", or an owner linking a member to a person. */
export const PersonLinkSchema = z.object({ personId: Id }).strict();
export const LinkSchema = z.object({ personId: Id, version: Version }).strict();
export const VersionQuery = z.object({ version: z.coerce.number().int().positive() });
