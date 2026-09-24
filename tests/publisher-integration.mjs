// End-to-end check of the Business Profile publisher (0046) against a real
// database: the full migration replay (0045 triggers, 0046 publisher_runs)
// behind PostgREST, so every write the publisher makes arrives as
// session_user authenticator / role service_role — the publisher identity
// 0045 recognises. The handler and store are the deployed ones
// (supabase/functions/post-publisher); only Google is fake.
//
//   npm run test:publisher     (scripts/test-tasks-ui.sh with UI_SPEC set)
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { createPostPublisher } from "../supabase/functions/post-publisher/handler.ts";
import { createStore } from "../supabase/functions/post-publisher/store.ts";

const { PGRST_URL, JWT_SECRET, PSQL } = process.env;
assert.ok(PGRST_URL && JWT_SECRET && PSQL, "run through npm run test:publisher");

const TEAM = { id: "00000000-0000-4000-a000-000000000001", email: "sandbox-team@compassmarketing.ai" };
const CA = "00000000-0000-4000-b000-00000000000a";
const LOC = "accounts/111/locations/222";

const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const sign = (claims) => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`; return `${h}.${createHmac("sha256", JWT_SECRET).update(h).digest("base64url")}`; };
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const serviceKey = sign({ role: "service_role", exp: exp() });
const anonKey = sign({ role: "anon", exp: exp() });
const teamToken = sign({ sub: TEAM.id, role: "authenticated", aud: "authenticated", email: TEAM.email, exp: exp() });

const sql = (q) => execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q } }).toString().trim();
const sqlFails = (q) => { try { sql(q); return null; } catch (e) { return String(e.stderr ?? e.message); } };

// Supabase's gateway, reduced to /auth/v1/user and /rest/v1.
const gateway = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (url.pathname === "/auth/v1/user") {
    const ok = bearer === teamToken;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(ok ? { id: TEAM.id, email: TEAM.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" } : { message: "invalid JWT" }));
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = {};
    for (const k of ["authorization", "content-type", "prefer", "accept", "range", "accept-profile", "content-profile"]) if (req.headers[k]) headers[k] = req.headers[k];
    const up = await fetch(`${PGRST_URL}${url.pathname.slice(8)}${url.search}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = Buffer.from(await up.arrayBuffer());
    const h = {};
    for (const k of ["content-type", "content-range", "preference-applied", "location"]) { const v = up.headers.get(k); if (v) h[k] = v; }
    res.writeHead(up.status, h);
    return res.end(out);
  }
  res.writeHead(404).end();
});
await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

// A fake Google Business Profile API.
const google = { creates: [], responses: [], existing: [] };
const fakeFetch = async (url, init = {}) => {
  const u = String(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (u.startsWith("https://oauth2.googleapis.com/token")) return json(200, { access_token: "at" });
  if (u.includes("mybusinessbusinessinformation") && u.includes("/v1/locations/")) return json(200, { name: "locations/222", metadata: { mapsUri: "https://maps.example/harbor" } });
  if (u.includes("/localPosts") && (init.method ?? "GET") === "GET") return json(200, { localPosts: google.existing });
  if (u.includes("/localPosts") && init.method === "POST") {
    const body = JSON.parse(init.body);
    google.creates.push(body);
    const next = google.responses.shift() ?? { status: 200 };
    if (next.status !== 200) return json(next.status, { error: { message: next.message ?? "error" } });
    const n = google.creates.length;
    return json(200, { name: `${LOC}/localPosts/${n}`, searchUrl: `https://g.example/${n}`, createTime: new Date().toISOString(), summary: body.summary });
  }
  return json(404, { error: { message: `unexpected ${u}` } });
};

const service = createClient(gatewayUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const asTeam = createClient(gatewayUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${teamToken}` } } });
let clock = new Date();
const publisher = createPostPublisher({ store: createStore(service), fetch: fakeFetch, now: () => clock, googleTimeoutMs: 2000 });

const checks = [];
const ok = (name) => { checks.push(name); console.log(`  ✔ ${name}`); };

// Draft (as the worker, SQL as postgres) → link a claim → submit → a person approves through the API.
async function approvedPost(fields) {
  const cols = Object.keys(fields);
  const vals = Object.values(fields).map((v) => (v === null ? "null" : `'${String(v).replaceAll("'", "''")}'`));
  const id = sql(`insert into social_posts (${cols.join(",")}) values (${vals.join(",")}) returning id`).split("\n")[0];
  if (fields.search_intent !== "navigational") sql(`insert into post_claims (post_id, claim_id) values ('${id}', '00000000-0000-4000-f000-00000000000a')`);
  sql(`update social_posts set review_status = 'in_review' where id = '${id}'`);
  const { error } = await asTeam.from("social_posts").update({ review_status: "approved" }).eq("id", id);
  assert.equal(error, null, error?.message);
  return id;
}
const schedule = async (id, at = new Date(Date.now() - 60_000).toISOString()) => {
  const { error } = await asTeam.from("social_posts").update({ scheduled_at: at, publish_status: "scheduled" }).eq("id", id);
  assert.equal(error, null, error?.message);
};
const row = (id, cols) => sql(`select ${cols} from social_posts where id = '${id}'`);
const base = { client_id: CA, platform: "google_business", search_intent: "commercial", service_id: "00000000-0000-4000-e000-00000000000a", cta_type: "LEARN_MORE", cta_url: "https://a.example.test/drains" };

try {
  // Secrets the function reads through get_secret (the sandbox Vault stub).
  sql(`select vault.create_secret('cron', 'SYNC_CRON_SECRET'); select vault.create_secret('cid', 'GSC_CLIENT_ID'); select vault.create_secret('csec', 'GSC_CLIENT_SECRET'); select vault.create_secret('rt', 'GOOGLE_OPS_REFRESH_TOKEN')`);
  sql(`update clients set gbp_location = '${LOC}' where id = '${CA}'`);

  // 0. Shape.
  assert.equal(sql(`select value::text from app_settings where key = 'publisher'`), `{"clients": [], "enabled": false}`);
  assert.match(sql(`select command from cron.job where jobname = 'post-publisher-tick'`), /post-publisher/);
  const { error: runInsert } = await asTeam.from("publisher_runs").insert({ post_id: "00000000-0000-4000-f300-00000000000a", client_id: CA, mode: "tick", outcome: "published" });
  assert.ok(runInsert, "a team member cannot write publisher_runs");
  const anon = createClient(gatewayUrl, anonKey, { auth: { persistSession: false } });
  const { error: anonRead } = await anon.from("publisher_runs").select("id");
  assert.ok(anonRead, "anon cannot read publisher_runs");
  ok("0046 shape: switch off by default, tick scheduled, publisher_runs team-read-only");

  // 1. Switch off: a due post stays scheduled; nothing is sent.
  const p1 = await approvedPost({ ...base, copy: "Slow drains? A licensed master plumber clears them the same week." });
  await schedule(p1);
  await publisher.tick({ mode: "tick" });
  assert.equal(row(p1, "publish_status"), "scheduled");
  assert.equal(google.creates.length, 0);
  ok("Switched off: a due post stays scheduled and nothing reaches Google");

  // 2. On, for the pilot client: published as the service-role publisher.
  sql(`update app_settings set value = jsonb_build_object('enabled', true, 'clients', jsonb_build_array('${CA}')) where key = 'publisher'`);
  const approval = row(p1, "reviewed_by || '|' || reviewed_at || '|' || approved_hash");
  await publisher.tick({ mode: "tick" });
  assert.equal(row(p1, "publish_status || '|' || external_post_id || '|' || published_url || '|' || publish_attempts"), `published|${LOC}/localPosts/1|https://g.example/1|1`);
  assert.equal(row(p1, "reviewed_by || '|' || reviewed_at || '|' || approved_hash"), approval, "publishing left the approval untouched");
  assert.equal(sql(`select string_agg(kind || ':' || actor_kind, ',' order by id) from post_events where post_id = '${p1}' and kind in ('publishing','published')`), "publishing:publisher,published:publisher");
  assert.equal(sql(`select outcome || '|' || mode from publisher_runs where post_id = '${p1}'`), "published|tick");
  assert.equal(google.creates[0].summary, "Slow drains? A licensed master plumber clears them the same week.");
  ok("Published through PostgREST as the service-role publisher; events name the publisher; approval unchanged");

  // 3. Transient failure, then the retry after backoff, with the real triggers.
  const p2 = await approvedPost({ ...base, copy: "Second post: same-week drain clearing." });
  await schedule(p2);
  google.responses.push({ status: 503, message: "backend unavailable" });
  await publisher.tick({ mode: "tick" });
  assert.equal(row(p2, "publish_status || '|' || publish_attempts"), "failed|1");
  assert.equal(sql(`select transient from publisher_runs where post_id = '${p2}' order by id desc limit 1`), "t");
  clock = new Date(Date.now() + 11 * 60_000);
  await publisher.tick({ mode: "tick" });
  assert.equal(row(p2, "publish_status || '|' || publish_attempts"), "published|2");
  assert.equal(sql(`select string_agg(outcome, ',' order by id) from publisher_runs where post_id = '${p2}'`), "failed,retry_scheduled,published");
  assert.equal(sql(`select count(*) from post_events where post_id = '${p2}' and kind = 'retried' and actor_kind = 'publisher'`), "1");
  clock = new Date();
  ok("503 → failed (transient) → retried after backoff → published; each step recorded");

  // 4. A snapshot Google would refuse: unscheduled, TOM task, never sent.
  const sent = google.creates.length;
  const p3 = await approvedPost({ ...base, copy: "x".repeat(1600) });
  await schedule(p3);
  await publisher.tick({ mode: "tick" });
  assert.equal(row(p3, "publish_status"), "not_scheduled");
  assert.equal(google.creates.length, sent);
  assert.match(sql(`select detail from publisher_runs where post_id = '${p3}'`), /at most 1500 characters/);
  assert.equal(sql(`select t.key || '|' || t.owner || '|' || t.status from publisher_runs r join tasks t on t.id = r.task_id where r.post_id = '${p3}'`), "publisher_fix_post|TOM|open");
  ok("Preflight block: unscheduled, recorded, and a TOM task to fix the post");

  // 5. Support changed without a trigger noticing (offer ended by date): 0045 refuses the claim; the post goes back to review.
  const p4 = await approvedPost({ ...base, post_type: "offer", offer_id: "00000000-0000-4000-f100-00000000000a", search_intent: "transactional", service_id: null, cta_type: null, copy: "Free estimates on any drain job." });
  await schedule(p4);
  sql(`alter table offers disable trigger offers_zz_recheck_posts; update offers set starts_on = current_date - 30, ends_on = current_date - 1 where id = '00000000-0000-4000-f100-00000000000a'; alter table offers enable trigger offers_zz_recheck_posts`);
  await publisher.tick({ mode: "tick" });
  assert.equal(row(p4, "review_status || '|' || publish_status"), "in_review|not_scheduled");
  assert.match(sql(`select outcome || '|' || detail from publisher_runs where post_id = '${p4}'`), /^lapsed\|.*changed since it was approved|^lapsed\|.*offer ended/);
  assert.equal(google.creates.length, sent);
  ok("A lapsed post is refused at claim by 0045, sent back to review, never published");

  // 6. Publish now: the same path, as a person asking through the function's JWT door.
  const p5 = await approvedPost({ ...base, copy: "Published now by a person's request." });
  await schedule(p5, new Date().toISOString());
  const res = await publisher.handle(new Request("https://fn.local/post-publisher", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${teamToken}` }, body: JSON.stringify({ mode: "now", post_id: p5 }) }));
  assert.equal(res.status, 200);
  assert.equal(row(p5, "publish_status"), "published");
  assert.equal(sql(`select mode from publisher_runs where post_id = '${p5}'`), "now");
  const forged = await publisher.handle(new Request("https://fn.local/post-publisher", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${anonKey}` }, body: JSON.stringify({ mode: "now", post_id: p5 }) }));
  assert.equal(forged.status, 403);
  ok("Publish now: same governed path, recorded as mode now; a non-team caller is refused");

  // 7. A Facebook post due now: a TOM task to post it by hand; closed when marked published.
  const fb = await approvedPost({ client_id: CA, platform: "facebook", search_intent: "informational", service_id: "00000000-0000-4000-e000-00000000001a", copy: "Is your water heater over ten years old?" });
  await schedule(fb);
  await publisher.tick({ mode: "tick" });
  await publisher.tick({ mode: "tick" });
  assert.equal(sql(`select count(*) from tasks where key = 'post_by_hand' and notes like '%post_id=${fb}%'`), "1");
  assert.equal(row(fb, "publish_status"), "scheduled", "the publisher never posts to Facebook");
  const { error: manual } = await asTeam.from("social_posts").update({ publish_status: "published", published_at: new Date(Date.now() - 60_000).toISOString(), published_url: "https://facebook.example/p/1" }).eq("id", fb);
  assert.equal(manual, null, manual?.message);
  await publisher.tick({ mode: "tick" });
  assert.equal(sql(`select status from tasks where key = 'post_by_hand' and notes like '%post_id=${fb}%'`), "done");
  ok("Facebook post due: one TOM hand-posting task, closed once a person marks it published");

  // 8. The worker's SQL login still cannot publish anything itself.
  assert.match(sqlFails(`update social_posts set publish_status = 'publishing' where id = '${p2}'`) ?? "", /Only the publisher|cannot go from published/);
  ok("The worker's SQL login cannot act as the publisher");

  console.log(`Publisher integration checks passed (${checks.length}).`);
} finally {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
