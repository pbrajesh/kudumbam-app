// The data shapes the API stores and sends. The web app has the same types in its own src/app/models.ts:
// change both together.

/** A raw GEDCOM line with its sub-lines. Used to keep tags the app does not edit. */
export interface GedNode {
  level: number;
  xref?: string;
  tag: string;
  value: string;
  children: GedNode[];
}

export type Sex = 'M' | 'F' | 'U';

export interface Person {
  id: string;            // GEDCOM xref without @, e.g. "I3"
  given: string;
  surname: string;
  marriedName: string;
  sex: Sex;
  birthDate: string;
  birthPlace: string;
  deceased: boolean;
  deathDate: string;
  deathPlace: string;
  notes: string;
  /** Sub-records the app does not edit, written back unchanged on export. */
  extra: GedNode[];
}

export interface Family {
  id: string;            // e.g. "F1"
  husb?: string;
  wife?: string;
  children: string[];
  marrDate: string;
  marrPlace: string;
  /** Family Echo's _CURRENT flag (current vs. former partnership). */
  current?: boolean;
  extra: GedNode[];
}

export interface TreeData {
  people: Record<string, Person>;
  families: Record<string, Family>;
  /** Display order of people as read from the file. */
  order: string[];
  submitterName: string;
}

/** How a new child's surname is filled in: the father's given name, the father's surname, or left blank. */
export type SurnameRule = 'father-given' | 'father-surname' | 'none';

/** Per-tree settings. */
export interface TreeSettings {
  /** Who the tree opens on. Null: the first person. */
  homePersonId: string | null;
  surnameRule: SurnameRule;
}
