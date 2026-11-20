-- Rollback of 20261103170000_gbp_location_phones.sql. Drops the table (and
-- any location phones recorded in it) and its guard. post-drafter v10 reads
-- the table but treats a missing one as "no phone recorded", so a location's
-- posts return to phone-free with Learn More; redeploying post-drafter and
-- content-approvals v9 is not required, but is the full rollback.
drop table if exists gbp_location_phones;
drop function if exists gbp_location_phones_guard();
