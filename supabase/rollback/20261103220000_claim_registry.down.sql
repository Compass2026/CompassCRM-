-- Rollback of 20261103220000_claim_registry.sql. No gate, approval or drafter
-- function reads these objects (the migration's verify block proved it), so
-- nothing else changes.
--
-- Claim history stays: the 'claim' rows in creative_governance_events are
-- append-only evidence and are kept; the subject_type check therefore keeps
-- 'claim' (removing it would fail on the kept rows). Re-applying the
-- migration recreates the same check.
--
-- The registry columns are empty until a later PR writes them. If they have
-- been written, their values are in the kept history, and this rollback
-- drops them.
drop function if exists claim_registry(uuid, date);
drop function if exists claim_phone_digits(text);
drop function if exists claim_url_host(text);
drop function if exists claim_source_url(text);
drop trigger if exists claims_history on claims;
drop function if exists claims_history();
drop function if exists claim_history_fields();
drop trigger if exists claims_registry_guard on claims;
drop function if exists claims_registry_guard();
drop index if exists claims_superseded_by_idx;
alter table claims
  drop constraint if exists claims_superseded_by_fkey,
  drop constraint if exists claims_not_self_superseded,
  drop constraint if exists claims_verified_by_needs_verification,
  drop constraint if exists claims_verification_pair,
  drop column if exists superseded_by,
  drop column if exists review_by,
  drop column if exists verified_by,
  drop column if exists verified_at,
  drop column if exists verification_method,
  drop column if exists kind;
drop table if exists claim_review_intervals;
