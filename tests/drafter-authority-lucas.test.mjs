// The Lucas pilot, read-only: post-drafter v2 in brief and check mode over
// the production snapshot of Sept 27 2026 (tests/fixtures/drafter-authority-
// lucas.json: client_intelligence_input and the Authority state for the
// Roof Replacement transactional Business Profile opportunity, read with one
// SELECT; nothing was written). The store refuses every write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };

const snap = JSON.parse(readFileSync(new URL("./fixtures/drafter-authority-lucas.json", import.meta.url), "utf8"));
const refuse = () => { throw new Error("writes are refused"); };
const drafter = createPostDrafter({
  store: { secret: async () => "s", teamMemberForJwt: async () => null, input: async () => snap.input, authority: async () => snap.authority, attempts: refuse, recordRun: refuse, write: refuse },
  gazetteer, now: () => new Date(snap.captured_at),
});
const call = async (body) => {
  const r = await drafter.handle(new Request("http://x", { method: "POST", headers: { "x-cron-secret": "s" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const base = { client_id: "102d3b20-2795-44ae-bd64-d1e43916291c", authority_opportunity_id: "70ac7544-cd22-4221-ae61-d5d5daf9d9b5", expected_run_id: "082e8e2a-94cf-4b03-b385-2c7cd7fb239b" };
const EVIDENCE = ["fc6e22d0-f704-43f8-b39b-24f8750ada61", "fa1d2070-c56c-4a75-a7ce-43effb6f0d21"];
const PROBE =
  "Ready to get a roof replacement quote for your Wentzville home? Lucas Construction is a local Roofing, siding, guttering, fascia and soffit contractor, " +
  "so one team can look at the whole outside of your house, not just the shingles you can see from the street. Lucas Construction Installs Owens Corning " +
  "Duration shingles on the roofs we replace. Visit our Roof Replacement page to see how the process works, then request a quote and we will set up a time " +
  "to come out and take a look.";

test("Lucas: the transactional Roof Replacement brief, derived from the production opportunity", async () => {
  const r = await call({ mode: "brief", ...base });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body.brief;
  assert.equal(b.target.search_intent, "transactional");
  assert.equal(b.target.service.name, "Roof Replacement");
  assert.equal(b.target.keyword.text, "get a roofing quote wentzville");
  assert.deepEqual(b.target.cta, { type: "LEARN_MORE", url: "https://lucasconstructionmo.com/services/roof-replacement", in_copy_phrase: "Request a quote" });
  assert.deepEqual(b.authority.preferred_claim_ids, EVIDENCE);
  assert.deepEqual(b.allowed_facts.recommended_claim_ids, EVIDENCE);
  for (const id of EVIDENCE) assert.ok(b.allowed_facts.claims.some((c) => c.id === id), `${id} is Drafter-eligible`);
  assert.equal(b.authority.run_id, base.expected_run_id);
  assert.deepEqual(b.authority.recent_posts.map((p) => [p.id.slice(0, 8), p.review_status]), [["226ccecd", "rejected"], ["ea0600b3", "approved"]]);
  assert.deepEqual(b.allowed_facts.crm.places, ["Wentzville"]);
  assert.equal(r.body.request, null, "no Draft with AI request exists for Lucas");
});

test("Lucas: check passes a compliant draft and refuses a repeat of the approved commercial post", async () => {
  const hash = (await call({ mode: "brief", ...base })).body.brief_hash;
  const ok = await call({ mode: "check", ...base, brief_hash: hash, draft: { copy: PROBE, claim_ids: EVIDENCE } });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body.problems));
  const approved = snap.authority.recent_posts.find((p) => p.id.startsWith("ea0600b3"));
  const dup = await call({ mode: "check", ...base, brief_hash: hash, draft: { copy: approved.copy, claim_ids: ["818761df-41bb-41ab-afab-6ecbe4779803", "64d13e2d-c6d0-417d-b5c8-b3f368fb2077"] } });
  assert.deepEqual(dup.body.problems.map((p) => [p.code, p.match]), [["duplicate_recent_post", approved.id]]);
  // submit stops at the missing request before anything else.
  const sub = await call({ mode: "submit", ...base, brief_hash: hash, draft: { copy: PROBE, claim_ids: EVIDENCE }, runtime: "dry-run" });
  assert.equal(sub.status, 409);
  assert.equal(sub.body.code, "not_requested");
});
