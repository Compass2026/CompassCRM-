// Replays every migration into PGlite and runs the Citations Phase 1 database
// suite (supabase/tests/sandbox/citations.test.sql, also run natively by
// scripts/test-portal-sandbox.sh). Fictional fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";

const FOLLOW_UP = "20261021230000_citation_enrichment_and_field_checks.sql";
const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();

async function sandbox() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.exec("create role supabase_admin superuser login");
  await db.exec(
    readFileSync("supabase/tests/sandbox/bootstrap.sql", "utf8")
      .replace("create role postgres login nosuperuser bypassrls createrole createdb;", "")
      .replaceAll("database sandbox", "database postgres"),
  );
  await db.exec("set search_path=public,extensions");
  return db;
}
async function migrate(db, files) {
  for (const file of files)
    await db.exec("begin;" + readFileSync(`supabase/migrations/${file}`, "utf8").replace(/^create extension if not exists pg_(cron|net);/gm, "") + ";commit;");
}

test("citations: import idempotency, separate dimensions, evidence, approvals and team-only access", async () => {
  const db = await sandbox();
  try {
    await migrate(db, migrations);
    await db.exec(readFileSync("supabase/tests/sandbox/citations.test.sql", "utf8"));
  } finally {
    await db.close();
  }
});

// Evidence recorded before field-level checks existed keeps its verdict, values
// and links; which fields it covered is "unrecorded", never inferred.
test("citations follow-up migration: existing checks, listings and tasks are preserved; field coverage is never inferred", async () => {
  const db = await sandbox();
  try {
    await migrate(db, migrations.filter((f) => f < FOLLOW_UP));
    await db.exec(`
      insert into clients (id, name) values ('d1000000-0000-4000-b000-00000000000a', 'Legacy Sample');
      insert into citation_locations (id, client_id, label, business_name, address_line1, address_line2, city, region, postal_code, phone, website_url) values
        ('d1000000-0000-4000-d000-0000000000a1', 'd1000000-0000-4000-b000-00000000000a', 'Legacy office (sample)', 'Sample Solar', '100 W 110th St', 'Plaza 1, 7th Floor',
         'Overland Park', 'KS', '66210', '555-010-0000', 'https://sample-solar.example.test');
      insert into citation_listings (id, client_id, location_id, directory_id, listing_url, external_id, fulfillment_status, source_provider) values
        ('d1000000-0000-4000-e000-000000000001', 'd1000000-0000-4000-b000-00000000000a', 'd1000000-0000-4000-d000-0000000000a1', (select id from citation_directories where key = 'yelp'), null, null, 'submitted', 'brightlocal'),
        ('d1000000-0000-4000-e000-000000000002', 'd1000000-0000-4000-b000-00000000000a', 'd1000000-0000-4000-d000-0000000000a1', (select id from citation_directories where key = 'manta'), 'https://www.manta.com/c/sample', 'M-1', 'provider_complete', 'brightlocal'),
        ('d1000000-0000-4000-e000-000000000003', 'd1000000-0000-4000-b000-00000000000a', 'd1000000-0000-4000-d000-0000000000a1', (select id from citation_directories where key = 'hotfrog'), 'https://www.hotfrog.com/sample', null, 'provider_complete', 'brightlocal');
      insert into citation_checks (id, listing_id, checked_on, method, result, observed_name, observed_address, observed_phone, evidence) values
        ('d1000000-0000-4000-f000-000000000001', 'd1000000-0000-4000-e000-000000000001', current_date, 'visited_url', 'accurate', 'Sample Solar', '', '', 'Legacy: name and phone matched (sample)'),
        ('d1000000-0000-4000-f000-000000000002', 'd1000000-0000-4000-e000-000000000002', current_date, 'visited_url', 'discrepancy', 'Sample Solar', '', '', 'Legacy: no public phone (sample)'),
        ('d1000000-0000-4000-f000-000000000003', 'd1000000-0000-4000-e000-000000000003', current_date, 'visited_url', 'inaccessible', '', '', '', 'Legacy: parked domain (sample)');
      insert into citation_tasks (id, client_id, location_id, listing_id, kind, reason) values
        ('d1000000-0000-4000-c000-000000000001', 'd1000000-0000-4000-b000-00000000000a', 'd1000000-0000-4000-d000-0000000000a1', 'd1000000-0000-4000-e000-000000000002', 'correct', 'Legacy correction (sample)');`);
    const snapshot = async () => ({
      checks: (await db.query("select id, seq, listing_id, identity_version, checked_on, method, result, observed_name, observed_address, observed_phone, observed_website, evidence, evidence_url, recorded_at, recorded_by from citation_checks order by id")).rows,
      listings: (await db.query("select * from citation_listings order by id")).rows,
      tasks: (await db.query("select * from citation_tasks order by id")).rows,
      overview: (await db.query("select id, verification_status, last_check_id, current_name, current_phone, open_tasks from citation_listing_overview order by id")).rows,
    });
    const before = await snapshot();
    await migrate(db, [FOLLOW_UP]);
    assert.deepEqual(await snapshot(), before, "no check, listing, task or verdict changed");
    const coverage = (await db.query("select field_coverage, name_status, address_status, phone_status, website_status from citation_checks order by id")).rows;
    assert.ok(coverage.every((c) => c.field_coverage === "unrecorded" && c.name_status === null && c.address_status === null && c.phone_status === null && c.website_status === null),
      "legacy checks are 'unrecorded' with no field statuses");
    const overview = (await db.query("select check_field_coverage, name_check from citation_listing_overview order by id")).rows;
    assert.deepEqual(overview.map((o) => [o.check_field_coverage, o.name_check]), [["unrecorded", null], ["unrecorded", null], [null, null]],
      "content verdicts show coverage unrecorded; an inaccessible check carries none");
    const keys = (await db.query("select listing_key from citation_listing_keys order by listing_id, listing_key")).rows;
    assert.deepEqual(keys.map((k) => k.listing_key), ["none", "ext:m-1", "url:manta.com/c/sample", "url:hotfrog.com/sample"], "every listing's current key (and id) is in the key history");
  } finally {
    await db.close();
  }
});
