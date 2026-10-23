-- 003: which person in the tree each member is (the "This is me" link).
-- person_id is the approved link; claimed_person_id is a member's pending "This is me" claim, waiting for an owner.
-- Both live on the membership, so one email can be a different person in each tree, and leaving a tree drops them.
-- Deleting the person (or importing a new file, which replaces everyone) clears just that column.

alter table tree_members add column person_id text;
alter table tree_members add column claimed_person_id text;
alter table tree_members add foreign key (tree_id, person_id) references people (tree_id, id)
  on delete set null (person_id);
alter table tree_members add foreign key (tree_id, claimed_person_id) references people (tree_id, id)
  on delete set null (claimed_person_id);
-- One member per person in a tree. Several members may claim the same person; the owner picks one.
create unique index tree_members_tree_person_key on tree_members (tree_id, person_id) where person_id is not null;
