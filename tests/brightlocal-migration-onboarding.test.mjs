import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { distanceMiles } from "../supabase/functions/_shared/map-grid.ts";

// Fixtures shaped like the six existing production clients (same ids, the old
// wrong centers, keyword spellings as stored), so the guards are exercised.
const existing = [
  ["db9009c2-a04b-4e93-843f-e20c49263b5b", "Ginger Huff Interiors", "Edwardsville, IL", 38.763434, -90.278501, "4be2b877-d3f4-4b56-916d-6cdbbf4319ce", ["interior designer edwardsville il", "home interior design edwardsville", "home decorating services edwardsville", "interior decorator edwardsville il", "interior styling edwardsville"]],
  ["70211d71-d9f4-46ab-abe2-ef39c41591fb", "Logic Solar", "Overland Park, KS", 38.931076, -94.67073, "97913405-2cee-4924-acd0-6b4545b5b899", ["solar installer overland park ks", "solar panels overland park ks", "solar installation overland park ks", "solar energy company overland park ks", "solar company in kansas city", "solar panels wichita ks", "solar installation wichita ks", "solar company wichita ks", "solar energy wichita ks", "solar installers wichita ks"]],
  ["70211d71-d9f4-46ab-abe2-ef39c41591fb", "Logic Solar", "Wichita, KS", 38.299209, -96.286801, "fa4a2276-1007-4a40-9581-bf113ca026bf", []],
  ["1e12fc47-731a-4d84-a4f1-4aed777db451", "Pensacola Equipment Rentals", "Pensacola, FL", 30.497347, -87.214623, "058b8b08-0b7a-4b86-b3ac-dc5b2b01c76d", ["equipment rental pensacola", "tool rental pensacola", "construction equipment rental pensacola", "mini excavator rental pensacola", "bobcat rental pensacola"]],
  ["d94cfde2-0751-4002-a149-c83b4c6c956d", "Show Me Design", "St. Louis, MO", 38.763434, -90.278501, "a669670a-8e8b-40a8-8dbe-cccb22d211bc", ["design build st louis", "home remodeling st louis", "remodeling contractors st louis", "construction company st louis", "home renovation st louis"]],
  ["9a8e05f5-3d28-4839-9735-79bcdd0e277d", "Show Me Electrical", "St. Louis, MO", 38.564664, -90.311971, "04980c4e-d4ba-46f6-80c4-d4d28744787d", ["electrician st louis mo", "licensed electrician st louis", "emergency electrician st louis", "residential electrician st louis", "commercial electrical services st louis"]],
];
const q = (v) => `'${String(v).replaceAll("'", "''")}'`;

test("BrightLocal migration onboarding SQL prepares nine disabled profiles, idempotently, without side effects", async () => {
  const sql = execFileSync(process.execPath, ["--no-warnings", "scripts/brightlocal-migration-onboarding.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  try {
    await db.exec("create role supabase_admin superuser login");
    await db.exec(readFileSync("supabase/tests/sandbox/bootstrap.sql", "utf8").replace("create role postgres login nosuperuser bypassrls createrole createdb;", "").replaceAll("database sandbox", "database postgres"));
    await db.exec("set search_path=public,extensions");
    for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort())
      await db.exec("begin;" + readFileSync(`supabase/migrations/${f}`, "utf8").replace(/^create extension if not exists pg_(cron|net);/gm, "") + ";commit;");
    const seen = new Set();
    for (const [cid, name, loc, lat, lng, gc, kws] of existing) {
      if (!seen.has(cid)) {
        seen.add(cid);
        await db.exec(`insert into clients(id,name,phone) values (${q(cid)},${q(name)},${q(name === "Show Me Design" ? "314-724-6895" : "000-000-0000")})`);
      }
      await db.exec(`insert into locations(id,client_id,name,lat,lng,is_physical_location) values (gen_random_uuid(),${q(cid)},${q(loc)},${lat},${lng},true);
        insert into grid_configs(id,location_id,center_lat,center_lng) select ${q(gc)}, id, ${lat}, ${lng} from locations where client_id=${q(cid)} and name=${q(loc)};`);
      for (const k of kws) await db.exec(`insert into keywords(client_id,keyword) values (${q(cid)},${q(k)})`);
    }
    // An unrelated BrightLocal grid snapshot on an old config must survive untouched.
    await db.exec(`insert into grid_snapshots(grid_config_id,keyword_id,recorded_at,points) select 'a669670a-8e8b-40a8-8dbe-cccb22d211bc', id, now(), '[]' from keywords where client_id='d94cfde2-0751-4002-a149-c83b4c6c956d' limit 1`);
    const before = (await db.query("select count(*)::int n from client_pipelines")).rows[0].n;

    await db.exec(sql);
    await db.exec(sql); // idempotent re-run

    const profiles = (await db.query("select p.*, c.name client from map_grid_profiles p join clients c on c.id=p.client_id order by label")).rows;
    assert.equal(profiles.length, 9);
    for (const p of profiles) {
      assert.equal(p.enabled, false, p.label);
      assert.equal(p.weekly_enabled, false, p.label);
      assert.equal(p.search_this_area, false);
      assert.equal(p.zoom, 13);
      assert.equal(p.points.length, 153);
      assert.equal(p.geometry.version, "local-multiscale-v1");
    }
    const byLabel = Object.fromEntries(profiles.map((p) => [p.label, p]));
    const wichita = byLabel["Logic Solar — Wichita, KS"];
    assert.equal(wichita.geometry.center_kind, "market");
    assert.equal(wichita.geometry.center_label, "Wichita, KS market center");
    assert.ok(distanceMiles(wichita.geometry.center, { lat: 37.6922361, lng: -97.3375448 }) < 0.001);
    assert.equal(byLabel["Show Me Design — St. Louis, MO"].geometry.center_kind, undefined);
    // Keyword counts and the stored CRM spelling are kept.
    assert.equal(byLabel["Silverback Plumbing & Contracting LLC — Wentzville, MO"].keywords.length, 4);
    assert.equal(byLabel["Premier Building Solutions — Pensacola, FL"].keywords.length, 3);
    assert.equal(byLabel["Ginger Huff Interiors — Edwardsville, IL"].keywords[0].keyword, "interior designer edwardsville il");
    // Old configs and their history are untouched; corrected centers get new configs.
    const old = (await db.query("select center_lat, center_lng from grid_configs where id='a669670a-8e8b-40a8-8dbe-cccb22d211bc'")).rows[0];
    assert.deepEqual([old.center_lat, old.center_lng], [38.763434, -90.278501]);
    assert.equal((await db.query("select count(*)::int n from grid_snapshots where grid_config_id='a669670a-8e8b-40a8-8dbe-cccb22d211bc'")).rows[0].n, 1);
    assert.notEqual(byLabel["Show Me Design — St. Louis, MO"].grid_config_id, "a669670a-8e8b-40a8-8dbe-cccb22d211bc");
    assert.equal(byLabel["Show Me Electrical — St. Louis, MO"].grid_config_id, "04980c4e-d4ba-46f6-80c4-d4d28744787d");
    // Show Me Design's confirmed phone, CRM only.
    assert.equal((await db.query("select phone from clients where id='d94cfde2-0751-4002-a149-c83b4c6c956d'")).rows[0].phone, "314-571-9756");
    // The three new businesses are map-tracking only, paused, with no onboarding side effects.
    const fresh = (await db.query("select id, status, service_scope from clients where service_scope='map_tracking'")).rows;
    assert.equal(fresh.length, 3);
    for (const c of fresh) {
      assert.equal(c.status, "paused");
      for (const t of ["client_pipelines", "tasks", "client_brands", "worker_fires"])
        assert.equal((await db.query(`select count(*)::int n from ${t} where client_id=$1`, [c.id])).rows[0].n, 0, t);
    }
    assert.equal((await db.query("select count(*)::int n from client_pipelines")).rows[0].n, before);
    assert.equal((await db.query("select count(*)::int n from keywords where source='brightlocal_map_grid' and is_tracked")).rows[0].n, 0);
    // No scan could start: every prepared profile is disabled.
    await assert.rejects(db.query(`select map_grid_start('${byLabel["MADHAIRLAB — Queen Creek, AZ"].id}','t')`), /disabled/);
  } finally {
    await db.close();
  }
});

test("onboarding SQL refuses to run before the scope and market-center migrations", async () => {
  const sql = execFileSync(process.execPath, ["--no-warnings", "scripts/brightlocal-migration-onboarding.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.match(sql, /apply 20261015170000_client_service_scope first/);
  assert.match(sql, /apply 20261015171000_map_grid_market_center first/);
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.doesNotMatch(sql, /enabled\s*=\s*true|weekly_enabled\s*=\s*true/);
});
