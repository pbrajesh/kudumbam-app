-- 002: many trees in one database (docs/multi-tree-plan.md, phase 1).
-- Every person, family and child link belongs to a tree. Person and family IDs (I12, F3) stay unique per tree only,
-- so GEDCOM files keep their own IDs. Existing single-tree data becomes the first tree; existing members keep access.
-- Needs PostgreSQL 15+ (ON DELETE SET NULL with a column list).

create table trees (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(name) between 1 and 200),
  surname_rule   text not null default 'father-surname'
                 check (surname_rule in ('father-surname', 'father-given', 'none')),
  home_person_id text,                                     -- checked by the API: must be a person in this tree
  file_name      text not null default '',
  submitter_name text not null default '',
  created_by     uuid,                                     -- Supabase user id; null for the tree migrated below
  created_at     timestamptz not null default now()
);

create table tree_members (
  tree_id    uuid not null references trees(id) on delete cascade,
  email      text not null check (email = lower(email)),
  user_id    uuid,                                         -- Supabase user id, filled on first sign-in
  role       text not null check (role in ('viewer', 'editor', 'owner')),
  invited_by uuid,
  created_at timestamptz not null default now(),
  primary key (tree_id, email)
);
create unique index tree_members_tree_user_key on tree_members (tree_id, user_id) where user_id is not null;
create index tree_members_user_idx on tree_members (user_id);
create index tree_members_pending_email_idx on tree_members (email) where user_id is null;

-- The existing tree, if there is anything to keep. Named after its file ("My-Family.ged" → "My-Family").
insert into trees (name, surname_rule, home_person_id, file_name, submitter_name)
select coalesce(nullif(regexp_replace(m.file_name, '\.(ged|txt)$', '', 'i'), ''), 'Family tree'),
       coalesce(m.surname_rule, 'father-surname'), m.home_person_id, coalesce(m.file_name, ''), coalesce(m.submitter, '')
from (select (select value from tree_meta where key = 'fileName')      as file_name,
             (select value from tree_meta where key = 'surnameRule')   as surname_rule,
             (select value from tree_meta where key = 'homePersonId')  as home_person_id,
             (select value from tree_meta where key = 'submitterName') as submitter) m
where exists (select 1 from people) or exists (select 1 from members) or exists (select 1 from tree_meta);

-- Members carry over; the earliest editor becomes the owner.
insert into tree_members (tree_id, email, user_id, role, created_at)
select (select id from trees), m.email, m.supabase_user_id,
       case when m.id = (select min(id) from members where role = 'editor') then 'owner' else m.role end,
       m.created_at
from members m
where exists (select 1 from trees);

-- Old single-column keys and links go; tree-scoped ones replace them.
alter table family_children drop constraint family_children_family_id_fkey;
alter table family_children drop constraint family_children_person_id_fkey;
alter table family_children drop constraint family_children_pkey;
alter table families drop constraint families_husband_id_fkey;
alter table families drop constraint families_wife_id_fkey;
alter table families drop constraint families_pkey;
alter table people drop constraint people_pkey;
drop index if exists family_children_person_idx;

alter table people          add column tree_id uuid;
alter table families        add column tree_id uuid;
alter table family_children add column tree_id uuid;
update people          set tree_id = (select id from trees);
update families        set tree_id = (select id from trees);
update family_children set tree_id = (select id from trees);
alter table people          alter column tree_id set not null;
alter table families        alter column tree_id set not null;
alter table family_children alter column tree_id set not null;

alter table people   add primary key (tree_id, id);
alter table families add primary key (tree_id, id);
alter table family_children add primary key (tree_id, family_id, person_id);

alter table people   add foreign key (tree_id) references trees(id) on delete cascade;
alter table families add foreign key (tree_id) references trees(id) on delete cascade;
-- A family can only point at people in its own tree. Removing a person clears just the husband/wife column.
alter table families add foreign key (tree_id, husband_id) references people (tree_id, id) on delete set null (husband_id);
alter table families add foreign key (tree_id, wife_id)    references people (tree_id, id) on delete set null (wife_id);
alter table family_children add foreign key (tree_id, family_id) references families (tree_id, id) on delete cascade;
alter table family_children add foreign key (tree_id, person_id) references people (tree_id, id) on delete cascade;
create index family_children_person_idx on family_children (tree_id, person_id);

drop table tree_meta;
drop table members;
