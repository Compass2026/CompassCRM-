import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { activeAgreementPayment, safePaymentUrl } from "../src/lib/agreements.ts";
const hash = v => createHash("sha256").update(v).digest("hex");
const admin = "10000000-0000-4000-8000-000000000001";
const member = "10000000-0000-4000-8000-000000000002";
const client = "20000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000002";
const paymentToken = "p".repeat(43);
const migration = "../supabase/migrations/20261014225000_agreement_payment_preparation.sql";
test("prepare while issued, verify, sign, and reach the exact payment capability without a charge", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
      create table clients(id uuid primary key,name text,status text);
      create table team_members(id uuid primary key,auth_user_id uuid,name text,role text);
      insert into clients values ('${client}','Fictional Customer','active'),('${other}','Other Customer','active');
      insert into team_members values ('${admin}','${admin}','Admin','admin'),('${member}','${member}','Member','member');
      create table plans(client_id uuid primary key,package_id uuid,collection text,agreed_amount_cents bigint,agreed_currency text,agreed_billing_interval text,agreed_billing_interval_count integer,start_date date,term_months integer,managed_ad_budget_cents bigint);
      insert into plans values ('${client}','30000000-0000-4000-8000-000000000001','stripe',50000,'usd','month',1,'2026-10-01',null,null);
      create table checkout_sessions(client_id uuid,livemode boolean,status text,expires_at timestamptz,url text,created_at timestamptz);
      create table stripe_customers(client_id uuid,livemode boolean,stripe_customer_id text,unlinked_at timestamptz,deleted_at timestamptz);
      insert into stripe_customers values('${client}',true,'cus_fictional',null,null);
      create table billing_payment_links(id uuid primary key default gen_random_uuid(),client_id uuid,token_hash text,livemode boolean,customer_id text,agreement jsonb,issued_by uuid,expires_at timestamptz,revoked_at timestamptz);
      create function billing_livemode() returns boolean language sql as $$ select coalesce(nullif(current_setting('test.live',true),''),'true')::boolean $$;
      create function is_team() returns boolean language sql as $$ select false $$;
      create function billing_payment_plan(uuid) returns jsonb language sql as $$ select to_jsonb(p) from plans p where client_id=$1 $$;
      create function client_entitlements_for(uuid) returns table(service_name text,quantity integer,unit text,period text,sort_order integer,enabled boolean) language sql as $$ select 'Blog Posts',8,'posts','month',1,true $$;
    `);
    await db.exec(readFileSync(new URL("../supabase/migrations/20261007180518_native_agreements.sql", import.meta.url), "utf8"));
    await db.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
    const owner = () => db.exec("set session authorization postgres");
    const runtime = () => db.exec("set session authorization agreement_service");
    const staff = async (action,args) => (await db.query("select agreement_private.staff($1,$2,$3) as r",[admin,action,args])).rows[0].r;
    const prepare = async (id,token=paymentToken,actor=admin) => (await db.query("select agreement_private.prepare_payment($1,$2,$3) as r",[actor,id,token])).rows[0].r;
    const signer = async (action,args={}) => (await db.query("select agreement_private.signer($1,$2,$3,$4) as r",[hash("signing link"),hash("session"),action,args])).rows[0].r;
    await runtime();
    const draft = await staff("create",{client_id:client});
    await staff("save",{id:draft.id,client_id:client,recipient_name:"Fictional Customer",recipient_email:"customer@example.com",terms:"This is a fictional test agreement with sufficiently long test terms."});
    await assert.rejects(prepare(draft.id),/agreement_live_issued_required/);
    const issued = await staff("issue",{id:draft.id,reviewed:true,provider_name:"Admin",token_hash:hash("signing link")});
    assert.equal((await prepare(issued.id,null)).payment_url,null);
    await assert.rejects(prepare(issued.id),/agreement_payment_link_required/);
    await owner();
    await db.query("insert into billing_payment_links(client_id,token_hash,livemode,customer_id,agreement,issued_by,expires_at) values($1,$2,true,'cus_fictional',billing_payment_plan($1),$3,now()+interval '7 days')",[client,hash(paymentToken),admin]);
    for (const role of ["anon","authenticated","service_role"]) {
      await db.exec(`set session authorization ${role}`);
      await assert.rejects(prepare(issued.id),/permission denied/);
      await owner();
    }
    await assert.rejects(prepare(issued.id),/agreement_runtime_only/);
    await runtime();
    await assert.rejects(prepare(issued.id,paymentToken,member),/agreement_admin_only/);
    await assert.rejects(prepare(issued.id,"https://evil.example"),/agreement_payment_link_required/);
    const prepared = await prepare(issued.id);
    assert.equal(prepared.status,"issued");
    assert.equal(prepared.payment_url,`/pay/${paymentToken}`);
    assert.deepEqual(prepared.snapshot,issued.snapshot);
    assert.equal(prepared.content_hash,issued.content_hash);
    assert.equal(prepared.signed_at,null);
    await prepare(issued.id);
    assert.equal((await staff("read",{id:issued.id})).events.filter(e=>e.kind==="payment_prepared").length,1);
    assert.deepEqual(await signer("read"),{verified:false,issuer:"Compass Marketing Advisors LLC"});
    await signer("code",{code_hash:hash("123456")});
    assert.deepEqual(await signer("verify",{code_hash:hash("123456"),session_hash:hash("session")}),{ok:true});
    const signed = await signer("sign",{name:"Fictional Customer",consent:true,content_hash:issued.content_hash});
    assert.equal(signed.status,"signed");
    assert.equal(activeAgreementPayment(signed),`/pay/${paymentToken}`);
    assert.deepEqual(signed.snapshot,issued.snapshot);
    assert.equal((await prepare(issued.id)).signer_name,"Fictional Customer");
    await owner();
    assert.equal((await db.query("select count(*)::int as n from checkout_sessions")).rows[0].n,0);
    for (const [change,restore] of [
      ["update billing_payment_links set revoked_at=now()","update billing_payment_links set revoked_at=null"],
      ["update billing_payment_links set expires_at=now()-interval '1 second'","update billing_payment_links set expires_at=now()+interval '7 days'"],
      ["update billing_payment_links set livemode=false","update billing_payment_links set livemode=true"],
      [`update billing_payment_links set client_id='${other}'`,`update billing_payment_links set client_id='${client}'`],
      ["update stripe_customers set unlinked_at=now()","update stripe_customers set unlinked_at=null"],
      ["update clients set status='offboarded'","update clients set status='active'"],
    ]) {
      await db.exec(change); await runtime();
      await assert.rejects(prepare(issued.id),/agreement_payment_link_required/);
      await owner(); await db.exec(restore);
    }
    await db.exec("update plans set agreed_amount_cents=65000"); await runtime();
    await assert.rejects(prepare(issued.id,null),/agreement_signed_scope_changed/);
    await owner(); await db.exec("update plans set agreed_amount_cents=50000"); await runtime();
    await db.exec("set test.live='false'"); await assert.rejects(prepare(issued.id),/agreement_live_issued_required/);
    // Apply the external-payment fix after a Stripe agreement has been signed.
    // Existing scope comparisons, frozen records and payment handoff must survive.
    await owner();
    await db.exec(`alter table plans add column external_amount_cents bigint,
      add column external_currency text, add column external_interval text`);
    const scopeBefore = (await db.query("select agreement_private.scope($1) as scope", [client])).rows[0].scope;
    await db.exec(readFileSync(new URL("../supabase/migrations/20261030034002_external_payment_agreement_scope.sql", import.meta.url), "utf8"));
    assert.deepEqual((await db.query("select agreement_private.scope($1) as scope", [client])).rows[0].scope, scopeBefore);
    await db.exec("set test.live='true'");
    await runtime();
    const unchanged = await prepare(signed.id, null);
    assert.deepEqual(unchanged.snapshot, signed.snapshot);
    assert.equal(unchanged.content_hash, signed.content_hash);
    assert.equal(unchanged.signed_at, signed.signed_at);
    await owner();
    // Deliberately stale Stripe fields must not supply any external fee data.
    await db.query(`insert into plans(client_id,collection,agreed_amount_cents,agreed_currency,
      agreed_billing_interval,agreed_billing_interval_count,external_amount_cents,external_currency,
      external_interval,start_date) values($1,'external',99999,'eur','year',3,50000,'usd','month','2026-10-30')`, [other]);
    await runtime();
    const externalDraft = await staff("create", {client_id: other});
    assert.deepEqual(externalDraft.snapshot.scope.plan, {
      package_id:null, collection:"external", amount_cents:50000, currency:"usd",
      interval:"month", interval_count:1, start_date:"2026-10-30", term_months:null, managed_ad_budget_cents:null,
    });
    await owner();
    await db.query("update plans set external_amount_cents=60000,external_currency='cad',external_interval='year' where client_id=$1", [other]);
    await runtime();
    const externalSaved = await staff("save", {id:externalDraft.id,client_id:other,
      recipient_name:"Manual Customer",recipient_email:"manual@example.com",
      terms:"Fictional manual payment agreement. Payments are made manually; no automatic billing."});
    assert.equal(externalSaved.snapshot.scope.plan.amount_cents,60000);
    assert.equal(externalSaved.snapshot.scope.plan.currency,"cad");
    assert.equal(externalSaved.snapshot.scope.plan.interval,"year");
    const externalIssued = await staff("issue", {id:externalDraft.id,reviewed:true,provider_name:"Admin",token_hash:hash("manual signing link")});
    await assert.rejects(prepare(externalIssued.id,null),/agreement_stripe_required/);
    const manualSigner = async (action,args={}) => (await db.query("select agreement_private.signer($1,$2,$3,$4) as r",[hash("manual signing link"),hash("manual session"),action,args])).rows[0].r;
    await manualSigner("code",{code_hash:hash("654321")});
    assert.deepEqual(await manualSigner("verify",{code_hash:hash("654321"),session_hash:hash("manual session")}),{ok:true});
    const externalSigned = await manualSigner("sign",{name:"Manual Customer",consent:true,content_hash:externalIssued.content_hash});
    assert.equal(externalSigned.status,"signed");
    assert.equal(externalSigned.payment_url,null);
    assert.equal(activeAgreementPayment(externalSigned),null);
    assert.equal(activeAgreementPayment({...externalSigned,payment_url:`/pay/${paymentToken}`,payment_expires_at:new Date(Date.now()+86400000).toISOString()}),null);
    await assert.rejects(prepare(externalSigned.id,null),/agreement_stripe_required/);
    await owner();
    for (const table of ["checkout_sessions","stripe_customers","billing_payment_links"]) {
      assert.equal((await db.query(`select count(*)::int as n from ${table} where client_id=$1`,[other])).rows[0].n,0);
    }
  } finally { await db.close(); }
});
test("agreement links accept only exact same-origin capabilities and Stripe Checkout", () => {
  assert.equal(safePaymentUrl(`/pay/${paymentToken}`),`/pay/${paymentToken}`);
  for (const url of [`//evil.example/pay/${paymentToken}`,`/pay/${paymentToken}?redirect=https://evil.example`,`/pay/${paymentToken}/..`,`/pay/${paymentToken}\n`,`https://compass-crm-ten.vercel.app.evil.example/pay/${paymentToken}`]) assert.equal(safePaymentUrl(url),null);
});
