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

const sql = (q) => {
  try { return execFileSync("/bin/sh", ["-c", `${PSQL} -c "$Q"`], { env: { ...process.env, Q: q }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
  catch (e) { const err = new Error(`${String(e.stderr ?? e.message).trim()}\n  in: ${q}`); err.stderr = e.stderr; throw err; }
};
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
const google = { creates: [], responses: [], existing: [], tokenOk: true, access: true };
const fakeFetch = async (url, init = {}) => {
  const u = String(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (u.startsWith("https://oauth2.googleapis.com/token")) return google.tokenOk ? json(200, { access_token: "at" }) : json(400, { error: "invalid_grant" });
  if (u.includes("mybusinessbusinessinformation") && u.includes("/v1/locations/")) {
    return google.access ? json(200, { name: "locations/222", metadata: { mapsUri: "https://maps.example/harbor" } }) : json(403, { error: { message: "The caller does not have permission" } });
  }
  if (u.includes("/localPosts") && (init.method ?? "GET") === "GET") return json(200, { localPosts: google.existing });
  if (u.includes("/localPosts") && init.method === "POST") {
    const body = JSON.parse(init.body);
    google.creates.push(body);
    const next = google.responses.shift() ?? { status: 200 };
    if (next.status !== 200) return json(next.status, { error: { message: next.message ?? "error" } });
    if (next.body) return json(200, next.body); // e.g. a 2xx that names no post
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
// A LocalPost as Google would list one of `base`'s posts.
const listed = (id, summary, createTime = new Date().toISOString(), o = {}) => ({
  name: `${LOC}/localPosts/${id}`, summary, createTime, state: "LIVE", topicType: "STANDARD",
  callToAction: { actionType: "LEARN_MORE", url: "https://a.example.test/drains" }, searchUrl: `https://g.example/${id}`, ...o,
});
const runs = (id) => sql(`select string_agg(outcome, ',' order by id) from publisher_runs where post_id = '${id}'`);
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

  // 7. Hand-post reminders are cycles: schedule → opened → unschedule → closed →
  //    reschedule the same post → a new reminder → marked published → closed.
  const fb = await approvedPost({ client_id: CA, platform: "facebook", search_intent: "informational", service_id: "00000000-0000-4000-e000-00000000001a", copy: "Is your water heater over ten years old?" });
  const handTasks = () => sql(`select coalesce(string_agg(status::text, ',' order by created_at, id), '') from tasks where key = 'post_by_hand' and notes like '%post_id=${fb}%'`);
  await schedule(fb);
  await publisher.tick({ mode: "tick" });
  await publisher.tick({ mode: "tick" });
  assert.equal(runs(fb), "reminder_opened");
  assert.equal(handTasks(), "open");
  assert.equal(row(fb, "publish_status"), "scheduled", "the publisher never posts to Facebook");
  const { error: unsched } = await asTeam.from("social_posts").update({ publish_status: "not_scheduled" }).eq("id", fb);
  assert.equal(unsched, null, unsched?.message);
  await publisher.tick({ mode: "tick" });
  assert.equal(runs(fb), "reminder_opened,reminder_closed");
  assert.equal(handTasks(), "done");
  await schedule(fb); // the same post, scheduled again and due
  await publisher.tick({ mode: "tick" });
  await publisher.tick({ mode: "tick" });
  assert.equal(runs(fb), "reminder_opened,reminder_closed,reminder_opened", "a second cycle, opened once");
  assert.equal(handTasks(), "done,open", "a fresh task for the new cycle");
  assert.equal(sql(`select outcome from publisher_reminder_state(array['${fb}'::uuid])`), "reminder_opened");
  const { error: manual } = await asTeam.from("social_posts").update({ publish_status: "published", published_at: new Date(Date.now() - 60_000).toISOString(), published_url: "https://facebook.example/p/1" }).eq("id", fb);
  assert.equal(manual, null, manual?.message);
  await publisher.tick({ mode: "tick" });
  assert.equal(runs(fb), "reminder_opened,reminder_closed,reminder_opened,reminder_closed");
  assert.equal(handTasks(), "done,done");
  assert.equal(sql(`select outcome from publisher_reminder_state(array['${fb}'::uuid])`), "reminder_closed");
  ok("Hand-post reminders: unschedule closes, rescheduling the same post opens a new cycle, marking published closes it");

  // 9. A 2xx that names no post: nothing recorded; ten minutes later exactly one safe match is reconciled.
  const u1copy = "Uncertain answer: same-week drain clearing.";
  const u1 = await approvedPost({ ...base, copy: u1copy });
  await schedule(u1);
  google.responses.push({ status: 200, body: { summary: u1copy } });
  let before = google.creates.length;
  await publisher.tick({ mode: "tick" });
  assert.equal(row(u1, "publish_status || '|' || coalesce(external_post_id, '-') || '|' || coalesce(published_url, '-')"), "publishing|-|-");
  assert.equal(runs(u1), "uncertain");
  google.existing = [listed("u1", u1copy)];
  clock = new Date(Date.now() + 11 * 60_000);
  await publisher.tick({ mode: "tick" });
  assert.equal(row(u1, "publish_status || '|' || external_post_id"), `published|${LOC}/localPosts/u1`);
  assert.equal(runs(u1), "uncertain,reconciled");
  assert.equal(google.creates.length, before + 1, "sent once");
  google.existing = []; clock = new Date();
  ok("2xx without a LocalPost name: uncertain, nothing recorded; reconciled from exactly one safe match");

  // 10. Not exactly one safe match: never re-sent, never recorded; a person checks, then the single match is found.
  const a1copy = "Ambiguous answer: two posts with this text appeared.";
  const a1 = await approvedPost({ ...base, copy: a1copy });
  await schedule(a1);
  google.responses.push({ status: 200, body: {} });
  before = google.creates.length;
  await publisher.tick({ mode: "tick" });
  google.existing = [listed("a1", a1copy), listed("a1dup", a1copy), listed("a1other", a1copy, undefined, { callToAction: { actionType: "CALL" } })];
  clock = new Date(Date.now() + 11 * 60_000);
  await publisher.tick({ mode: "tick" });
  assert.equal(row(a1, "publish_status || '|' || coalesce(external_post_id, '-')"), "failed|-");
  assert.equal(runs(a1), "uncertain,ambiguous");
  assert.match(sql(`select detail from publisher_runs where post_id = '${a1}' and outcome = 'ambiguous'`), /2 exact matches.*could not be confirmed/);
  const checkTask = () => sql(`select status from tasks where key = 'publisher_check_post' and notes like '%post_id=${a1}%'`);
  assert.equal(checkTask(), "open");
  clock = new Date(Date.now() + 5 * 60 * 60_000);
  await publisher.tick({ mode: "tick" });
  assert.equal(runs(a1), "uncertain,ambiguous", "no automatic retry after an ambiguous check");
  assert.equal(google.creates.length, before + 1);
  // The person removes the duplicate and the other post, then schedules it again.
  google.existing = [listed("a1", a1copy)];
  clock = new Date();
  await schedule(a1);
  await publisher.tick({ mode: "tick" });
  assert.equal(row(a1, "publish_status || '|' || external_post_id"), `published|${LOC}/localPosts/a1`);
  assert.equal(runs(a1), "uncertain,ambiguous,reconciled");
  assert.equal(google.creates.length, before + 1, "never sent a second time");
  assert.equal(checkTask(), "done");
  google.existing = [];
  ok("Ambiguous check: not re-sent or recorded, a TOM task; after the person's fix the one match is reconciled and the task closes");

  // 11. The publisher closes its own tasks once it verifies the fix.
  google.tokenOk = false;
  const g1 = await approvedPost({ ...base, copy: "Waiting on Google: drain camera inspections." });
  await schedule(g1);
  await publisher.tick({ mode: "tick" });
  await publisher.tick({ mode: "tick" });
  assert.equal(sql(`select count(*) from tasks where key = 'publisher_connect_google' and status <> 'done'`), "1", "one open task while it stays broken");
  google.tokenOk = true;
  await publisher.tick({ mode: "tick" });
  assert.equal(sql(`select count(*) from tasks where key = 'publisher_connect_google' and status <> 'done'`), "0");
  assert.match(sql(`select notes from tasks where key = 'publisher_connect_google' order by created_at desc limit 1`), /Resolved automatically by the publisher: Google sign-in works again/);
  assert.equal(row(g1, "publish_status"), "published");

  google.access = false;
  const g2 = await approvedPost({ ...base, copy: "Waiting on access: sewer line repair." });
  await schedule(g2);
  await publisher.tick({ mode: "tick" });
  assert.equal(sql(`select status from tasks where key = 'publisher_profile_access' and client_id = '${CA}' order by created_at desc limit 1`), "open");
  google.access = true;
  await publisher.tick({ mode: "tick" });
  assert.equal(sql(`select status from tasks where key = 'publisher_profile_access' and client_id = '${CA}' order by created_at desc limit 1`), "done");
  assert.equal(row(g2, "publish_status"), "published");

  // p3 (step 4) was refused for length: a person reopens it, fixes the copy, gets it approved and schedules it.
  for (const set of [{ review_status: "draft" }, { copy: "Fixed: drain clearing, same week, by a licensed master plumber." }, { review_status: "in_review" }, { review_status: "approved" }]) {
    const { error } = await asTeam.from("social_posts").update(set).eq("id", p3);
    assert.equal(error, null, error?.message);
  }
  await schedule(p3);
  await publisher.tick({ mode: "tick" });
  assert.equal(row(p3, "publish_status"), "published");
  assert.equal(sql(`select status from tasks where key = 'publisher_fix_post' and notes like '%post_id=${p3}%'`), "done");
  ok("Publisher tasks close themselves: Google connected, profile reachable, the repaired post published");

  // 8. The worker's SQL login still cannot publish anything itself.
  assert.match(sqlFails(`update social_posts set publish_status = 'publishing' where id = '${p2}'`) ?? "", /Only the publisher|cannot go from published/);
  ok("The worker's SQL login cannot act as the publisher");

  console.log(`Publisher integration checks passed (${checks.length}).`);
} finally {
  gateway.closeAllConnections();
  await new Promise((r) => gateway.close(r));
}
