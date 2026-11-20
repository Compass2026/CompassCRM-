-- Rollback of 20261116170000_claim_verification_hardening.sql: drops the excerpt
-- rule. Recorded decisions are untouched either way.
alter table claim_reviews drop constraint if exists claim_reviews_excerpt_quotes;
