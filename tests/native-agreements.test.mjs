import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import {
  agreementPrice,
  agreementStatus,
  safePaymentUrl,
} from "../src/lib/agreements.ts";

const hash = (v) => createHash("sha256").update(v).digest("hex");
const admin = "10000000-0000-4000-8000-000000000001";
const member = "10000000-0000-4000-8000-000000000002";
const client = "20000000-0000-4000-8000-000000000001";
const terms =
  "Existing reviewed contract terms. This is a fictional test agreement, not a customer contract.";

test("native agreement lifecycle, isolation, verification limits, immutability and payment boundaries", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema extensions;
      create extension pgcrypto with schema extensions;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create table clients(id uuid primary key,name text);
      create table team_members(id uuid primary key,auth_user_id uuid,name text,role text);
      insert into clients values ('${client}','Fictional Customer');
      insert into team_members values ('${admin}','${admin}','Test Admin','admin'),('${member}','${member}','Test Member','member');
      create table plans(client_id uuid primary key,package_id uuid,collection text,agreed_amount_cents bigint,agreed_currency text,agreed_billing_interval text,agreed_billing_interval_count integer,start_date date,term_months integer,managed_ad_budget_cents bigint);
      insert into plans values ('${client}','30000000-0000-4000-8000-000000000001','stripe',50000,'usd','month',1,'2026-10-01',null,null);
      create table checkout_sessions(client_id uuid,livemode boolean,status text,expires_at timestamptz,url text,created_at timestamptz default now());
      create function billing_livemode() returns boolean language sql as $$ select coalesce(nullif(current_setting('test.live',true),''),'false')::boolean $$;
      create function is_team() returns boolean language sql security definer as $$ select exists(select 1 from team_members where auth_user_id=auth.uid()) $$;
      create function client_entitlements_for(uuid) returns table(service_name text,quantity integer,unit text,period text,sort_order integer,enabled boolean) language sql as $$ select 'Blog Posts',8,'posts','month',1,true $$;
      grant usage on schema public,auth to authenticated,anon,service_role;
      grant execute on function auth.uid(),is_team() to authenticated;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
    `);
    await db.exec(
      readFileSync(
        new URL(
          "../supabase/migrations/20261007180518_native_agreements.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const privileges = await db.query(`select
      has_schema_privilege('anon','agreement_private','usage') as anon_api,
      has_table_privilege('agreement_service','plans','select') as runtime_plan,
      has_table_privilege('authenticated','agreement_contracts','update') as team_write,
      has_table_privilege('service_role','agreement_contracts','update') as shared_write`);
    assert.deepEqual(privileges.rows[0], {
      anon_api: false,
      runtime_plan: false,
      team_write: false,
      shared_write: false,
    });
    await assert.rejects(
      db.query("select agreement_private.staff($1,'list',$2)", [
        admin,
        { client_id: client },
      ]),
      /agreement_runtime_only/,
    );
    await db.exec("set session authorization agreement_service");
    const staff = async (action, args, actor = admin) =>
      (
        await db.query("select agreement_private.staff($1,$2,$3) as result", [
          actor,
          action,
          args,
        ])
      ).rows[0].result;
    const signer = async (token, session, action, args = {}) =>
      (
        await db.query(
          "select agreement_private.signer($1,$2,$3,$4) as result",
          [token, session, action, args],
        )
      ).rows[0].result;
    const draft = await staff("create", { client_id: client });
    assert.equal(draft.snapshot.scope.plan.amount_cents, 50000);
    await assert.rejects(
      staff("create", { client_id: client }, member),
      /agreement_admin_only/,
    );
    await assert.rejects(
      staff(
        "list",
        { client_id: client },
        "10000000-0000-4000-8000-000000000099",
      ),
      /agreement_team_only/,
    );
    await staff("save", {
      id: draft.id,
      client_id: client,
      recipient_name: "Test Customer",
      recipient_email: "customer@example.com",
      terms,
    });
    await assert.rejects(
      staff("issue", {
        id: draft.id,
        provider_name: "Test Admin",
        token_hash: hash("link"),
      }),
      /agreement_review_required/,
    );
    const issued = await staff("issue", {
      id: draft.id,
      provider_name: "Test Admin",
      reviewed: true,
      token_hash: hash("link"),
    });
    assert.equal(issued.content_hash.length, 64);
    assert.deepEqual(await signer(hash("missing"), null, "read"), {
      error: "unavailable",
    });
    assert.deepEqual(await signer(hash("link"), null, "read"), {
      verified: false,
      issuer: "Compass Marketing Advisors LLC",
    });
    assert.equal(
      (
        await signer(hash("link"), null, "sign", {
          name: "Customer",
          consent: true,
        })
      ).error,
      "verification_required",
    );
    await assert.rejects(
      staff("save", {
        id: draft.id,
        client_id: client,
        terms,
        recipient_name: "x",
        recipient_email: "x@example.com",
      }),
      /agreement_draft_only/,
    );
    await signer(hash("link"), null, "code", { code_hash: hash("123456") });
    assert.equal(
      (await signer(hash("link"), null, "code", { code_hash: hash("123456") }))
        .error,
      "code_rate_limited",
    );
    assert.equal(
      (
        await signer(hash("link"), null, "verify", {
          session_hash: hash("session"),
        })
      ).error,
      "invalid_code",
    );
    assert.equal(
      (
        await signer(hash("link"), null, "verify", {
          code_hash: hash("wrong"),
          session_hash: hash("session"),
        })
      ).error,
      "invalid_code",
    );
    assert.deepEqual(
      await signer(hash("link"), null, "verify", {
        code_hash: hash("123456"),
        session_hash: hash("session"),
      }),
      { ok: true },
    );
    assert.equal(
      (await signer(hash("link"), hash("session"), "read")).snapshot.terms,
      terms,
    );
    assert.equal(
      (
        await signer(hash("link"), hash("session"), "sign", {
          name: "Customer",
          content_hash: issued.content_hash,
        })
      ).error,
      "consent_required",
    );
    assert.equal(
      (
        await signer(hash("link"), hash("session"), "sign", {
          consent: true,
          content_hash: issued.content_hash,
        })
      ).error,
      "consent_required",
    );
    assert.equal(
      (
        await signer(hash("link"), hash("session"), "sign", {
          name: "Customer",
          consent: true,
          content_hash: hash("other version"),
        })
      ).error,
      "version_changed",
    );
    const signed = await signer(hash("link"), hash("session"), "sign", {
      name: "Customer",
      consent: true,
      content_hash: issued.content_hash,
    });
    assert.equal(signed.status, "signed");
    assert.equal(
      (
        await signer(hash("link"), hash("session"), "sign", {
          name: "Changed",
          consent: true,
          content_hash: issued.content_hash,
        })
      ).signer_name,
      "Customer",
    );
    await assert.rejects(
      staff("void", { id: signed.id }),
      /agreement_cannot_void/,
    );
    await assert.rejects(
      staff("payment", { id: signed.id }),
      /agreement_live_signed_only/,
    );
    await staff("template", { terms: `${terms} New version.`, reviewed: true });
    assert.equal(
      (await staff("read", { id: signed.id })).snapshot.terms,
      terms,
    );
    const artifact = async (bytes) =>
      (
        await db.query(
          "select agreement_private.artifact($1,$2,$3,$4,$5) as result",
          [signed.id, null, hash("link"), hash("session"), bytes],
        )
      ).rows[0].result;
    const pdf = Buffer.from("%PDF-1.7 fictional test bytes");
    assert.equal((await artifact(pdf)).sha256, hash(pdf));
    assert.equal(
      (await artifact(Buffer.from("%PDF-1.7 replacement"))).sha256,
      hash(pdf),
    );
    await db.exec("set session authorization postgres; set test.live='true';");
    await db.query(
      "insert into checkout_sessions values ($1,true,'open',now()+interval '1 day','https://checkout.stripe.com/c/pay/test',now())",
      [client],
    );
    await db.exec("set session authorization agreement_service");
    assert.match(
      (await staff("payment", { id: signed.id })).payment_url,
      /checkout.stripe.com/,
    );
    await db.exec("set session authorization postgres");
    await db.query(
      "update plans set agreed_amount_cents=65000 where client_id=$1",
      [client],
    );
    await db.exec("set session authorization agreement_service");
    await assert.rejects(
      staff("payment", { id: signed.id }),
      /agreement_signed_scope_changed/,
    );
    const second = await staff("create", { client_id: client });
    await staff("save", {
      id: second.id,
      client_id: client,
      recipient_name: "Customer",
      recipient_email: "customer@example.com",
      terms,
    });
    await staff("issue", {
      id: second.id,
      provider_name: "Admin",
      reviewed: true,
      token_hash: hash("old"),
    });
    await staff("relink", {
      id: second.id,
      reviewed: true,
      token_hash: hash("new"),
    });
    assert.equal(
      (await signer(hash("old"), null, "read")).error,
      "unavailable",
    );
    assert.equal((await signer(hash("new"), null, "read")).verified, false);
    await signer(hash("new"), null, "code", { code_hash: hash("correct") });
    for (let n = 0; n < 5; n++)
      assert.equal(
        (
          await signer(hash("new"), null, "verify", {
            code_hash: hash("bad"),
            session_hash: hash("s"),
          })
        ).error,
        "invalid_code",
      );
    assert.equal(
      (
        await signer(hash("new"), null, "verify", {
          code_hash: hash("correct"),
          session_hash: hash("s"),
        })
      ).error,
      "code_expired",
    );
    await db.exec("set session authorization postgres");
    await assert.rejects(
      db.query("update agreement_contracts set title='Tampered' where id=$1", [
        signed.id,
      ]),
      /agreement_write_boundary/,
    );
    await assert.rejects(
      db.query("delete from agreement_events where contract_id=$1", [
        signed.id,
      ]),
      /agreement_write_boundary/,
    );
    await db.exec("set session authorization authenticated");
    assert.equal(
      (await db.query("select * from agreement_contracts")).rows.length,
      0,
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      admin,
    ]);
    assert.equal(
      (await db.query("select * from agreement_contracts")).rows.length,
      2,
    );
    await assert.rejects(
      db.exec("select agreement_private.staff(null,'list','{}')"),
      /permission denied/,
    );
  } finally {
    await db.close();
  }
});

test("agreement display and payment links preserve approved terms", () => {
  assert.equal(
    agreementPrice({
      plan: {
        amount_cents: 50000,
        currency: "usd",
        interval: "month",
        interval_count: 1,
      },
    }),
    "$500.00 / month",
  );
  assert.equal(
    agreementStatus({ status: "issued", expires_at: "2020-01-01" }),
    "expired",
  );
  assert.equal(
    agreementStatus({ status: "signed", expires_at: "2020-01-01" }),
    "signed",
  );
  assert.equal(
    safePaymentUrl("https://checkout.stripe.com/c/pay/test"),
    "https://checkout.stripe.com/c/pay/test",
  );
  assert.equal(
    safePaymentUrl("https://checkout.stripe.com.evil.example/payment"),
    null,
  );
  assert.equal(safePaymentUrl("javascript:alert(1)"), null);
});
