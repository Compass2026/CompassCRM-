import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const client = "10000000-0000-4000-8000-000000000001";
const admin = "10000000-0000-4000-8000-000000000002";
const hash = "a".repeat(64);
const lease = "10000000-0000-4000-8000-000000000003";
test("durable link SQL: least privilege, thirty days, exact scope, revocation, leases and completed Checkout", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role; create role billing_sync login;
      create table clients(id uuid primary key,name text,status text);
      create table team_members(id uuid primary key,role text);
      create table plans(client_id uuid primary key,package_id uuid,collection text,agreed_amount_cents bigint,agreed_currency text,
        agreed_billing_interval text,agreed_billing_interval_count int,billing_package_price_id uuid);
      create table stripe_customers(client_id uuid,livemode boolean,stripe_customer_id text,unlinked_at timestamptz,deleted_at timestamptz);
      create table checkout_sessions(stripe_checkout_session_id text primary key,status text,expires_at timestamptz);
      create table billing_audit_events(action text constraint billing_audit_events_action_check check (action in ('create_checkout')));
      create function billing_livemode() returns boolean language sql as $$ select coalesce(nullif(current_setting('test.live',true),''),'false')::boolean $$;
      create function is_team() returns boolean language sql as $$ select coalesce(current_setting('test.team',true),'')='yes' $$;
      create function billing_audit(p jsonb) returns uuid language plpgsql as $$ begin insert into billing_audit_events values(p->>'action'); return gen_random_uuid(); end $$;
      grant usage on schema public to anon,authenticated,billing_sync,service_role;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
      insert into clients values('${client}','Fictional Customer','active');
      insert into team_members values('${admin}','admin');
      insert into plans values('${client}','10000000-0000-4000-8000-000000000004','stripe',50000,'usd','month',1,'10000000-0000-4000-8000-000000000005');
      insert into stripe_customers values('${client}',false,'cus_fictional',null,null);
    `);
    await db.exec(readFileSync(new URL("../supabase/migrations/20261010224500_durable_payment_links.sql", import.meta.url), "utf8"));
    const run = async (sql, values = []) => (await db.query(sql, values)).rows[0]?.r;
    const owner = () => db.exec("set session authorization postgres; reset role");
    const runtime = () => db.exec("set session authorization billing_sync");
    const plan = await run("select billing_payment_plan($1) as r", [client]);
    const write = p => run("select billing_payment_link_write($1::jsonb) as r", [JSON.stringify(p)]);
    const read = () => run("select billing_payment_link_read($1) as r", [hash]);
    const issue = async h => { await runtime(); return write({ op: "issue", token_hash: h, client_id: client, actor_id: admin, customer_id: "cus_fictional", agreement: plan }); };
    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.exec(`set session authorization ${role}`);
      await assert.rejects(read(), e => e.code === "42501");
      await assert.rejects(write({ op: "claim", token_hash: hash, lease_id: lease }), e => e.code === "42501");
      await assert.rejects(db.query("select token_hash from billing_payment_links"), e => e.code === "42501");
      await owner();
    }
    const issued = await issue(hash);
    assert.equal(Math.round((Date.parse(issued.expires_at) - Date.now()) / 86400000), 30);
    let l = await read(); assert.equal(l.agreement.agreed_amount_cents, 50000);
    await assert.rejects(db.query("update billing_payment_links set expires_at=now()+interval '100 days'"), e => e.code === "42501");
    const claim = await write({ op: "claim", token_hash: hash, lease_id: lease });
    assert.equal((await write({ op: "claim", token_hash: hash, lease_id: admin })).busy, true);
    await assert.rejects(write({ op: "revoke", client_id: client, actor_id: admin }), e => e.code === "55P03");
    await write({ op: "release", id: l.id, lease_id: admin });
    assert.equal((await write({ op: "claim", token_hash: hash, lease_id: admin })).busy, true);
    await write({ op: "release", id: l.id, lease_id: lease });
    assert.equal((await write({ op: "claim", token_hash: hash, lease_id: lease })).request_id, claim.request_id);
    await write({ op: "release", id: l.id, lease_id: lease, session_id: "cs_test_fictional" });
    await owner(); await db.exec("insert into checkout_sessions values('cs_test_fictional','expired',now()-interval '1 hour')"); await runtime();
    const refresh = await write({ op: "claim", token_hash: hash, lease_id: lease });
    assert.notEqual(refresh.request_id, claim.request_id);
    await write({ op: "release", id: l.id, lease_id: lease });
    assert.equal((await write({ op: "claim", token_hash: hash, lease_id: lease })).request_id, refresh.request_id);
    await write({ op: "release", id: l.id, lease_id: lease, session_id: "cs_test_fictional" });
    await owner(); await db.exec("update checkout_sessions set status='complete'"); await runtime();
    assert.equal((await read()).state, "complete"); assert.equal(await write({ op: "claim", token_hash: hash, lease_id: lease }), null);
    await owner(); await db.exec("update checkout_sessions set status='expired'");
    for (const [change, restore] of [
      ["update plans set agreed_amount_cents=65000", "update plans set agreed_amount_cents=50000"],
      ["update clients set status='offboarded'", "update clients set status='active'"],
      ["update stripe_customers set unlinked_at=now()", "update stripe_customers set unlinked_at=null"],
      ["update team_members set role='member'", "update team_members set role='admin'"],
      ["update billing_payment_links set expires_at=now()-interval '1 day'", "update billing_payment_links set expires_at=now()+interval '30 days'"],
    ]) {
      await db.exec(change); await runtime(); assert.equal(await read(), null); assert.equal(await write({ op: "claim", token_hash: hash, lease_id: lease }), null);
      await owner(); await db.exec(restore);
    }
    await runtime(); await db.exec("set test.live='true'"); assert.equal(await read(), null); await db.exec("set test.live='false'");
    await owner();
    const replacement = await issue("b".repeat(64)); assert.notEqual(replacement.id, issued.id); assert.equal(await read(), null);
    await write({ op: "revoke", client_id: client, actor_id: admin });
    assert.equal(await run("select billing_payment_link_read($1) as r", ["b".repeat(64)]), null);
    await owner(); await db.exec("set session authorization authenticated; set test.team='yes'");
    assert.equal((await db.query("select id,expires_at from billing_payment_links")).rows.length, 2);
    await db.exec("set test.team='no'"); assert.equal((await db.query("select id from billing_payment_links")).rows.length, 0);
  } finally { await db.close(); }
});
