-- PR2a.1: claim verification hardening, H1 (docs/proposals/pr2b-claim-lifecycle.md §8).
--
-- A7, the first real verification (Nov 16 2026), recorded the decision form's
-- placeholder ("Quote the words that support the claim") as the excerpt, and
-- the database accepted it because it only asked for 1 to 2000 characters.
-- From now on a decision that rests on evidence must quote it:
--   - at least 12 characters (the shortest real quote in the suites is 22);
--   - not the form's placeholder, in any case or spacing;
--   - not the same text as the note.
--
-- It is a NOT VALID check constraint on claim_reviews: it binds every new
-- decision and leaves the recorded history exactly as it is (A7's first
-- verification, e8ccf7b2, keeps its placeholder excerpt; Tom's re-review
-- 75cff2e8 superseded it). No function is replaced, so nothing that reads
-- claims changes, and no gate, approval or status moves.
alter table claim_reviews drop constraint if exists claim_reviews_excerpt_quotes;
alter table claim_reviews add constraint claim_reviews_excerpt_quotes check (
  excerpt is null
  or (length(btrim(excerpt)) >= 12
      and lower(regexp_replace(btrim(excerpt), '\s+', ' ', 'g')) <> 'quote the words that support the claim'
      and (note is null or btrim(excerpt) <> btrim(note)))
) not valid;

do $verify$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'claim_reviews_excerpt_quotes' and conrelid = 'public.claim_reviews'::regclass) then
    raise exception '20261116170000: claim_reviews_excerpt_quotes is missing';
  end if;
end $verify$;
