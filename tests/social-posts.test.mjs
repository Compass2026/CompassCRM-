// The app side of the post review gate (0045): which steps a person sees,
// how the draft form is read, and how history reads. The database enforces
// the same rules; tests/social-post-review-migration.test.mjs covers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availableActions,
  describePostEvent,
  displayState,
  parsePostFields,
  postErrorMessage,
} from "../src/lib/social-posts.ts";

const form = (o) => (k) => (k in o ? o[k] : null);
const base = { platform: "google_business", search_intent: "informational", copy: "Family owned since 1998." };

test("a person sees only the steps the workflow allows", () => {
  const a = (r, p) => availableActions({ review_status: r, publish_status: p });
  assert.deepEqual(a("draft", "not_scheduled"), ["edit", "submit", "delete"]);
  assert.deepEqual(a("in_review", "not_scheduled"), ["approve", "reject", "withdraw"]);
  assert.deepEqual(a("rejected", "not_scheduled"), ["revise", "delete"]);
  assert.deepEqual(a("approved", "not_scheduled"), ["schedule", "reopen"]);
  assert.deepEqual(a("approved", "scheduled"), ["unschedule", "reopen"]);
  assert.deepEqual(a("approved", "failed"), ["schedule", "reopen"]);
  assert.deepEqual(a("approved", "publishing"), [], "nothing while the publisher works");
  assert.deepEqual(a("approved", "published"), [], "a published post is on record");
});

test("nothing past not_scheduled is offered without an approval", () => {
  for (const r of ["draft", "in_review", "rejected"]) {
    const acts = availableActions({ review_status: r, publish_status: "not_scheduled" });
    assert.ok(!acts.includes("schedule"), r);
  }
});

test("lists show the publishing state once a post is approved", () => {
  assert.equal(displayState({ review_status: "draft", publish_status: "not_scheduled" }).label, "Draft");
  assert.equal(displayState({ review_status: "approved", publish_status: "not_scheduled" }).label, "Approved");
  assert.equal(displayState({ review_status: "approved", publish_status: "scheduled" }).label, "Scheduled");
  assert.equal(displayState({ review_status: "approved", publish_status: "published" }).label, "Published");
});

test("the draft form mirrors the table rules in plain words", () => {
  assert.equal(parsePostFields(form({ ...base, platform: "myspace" })).error, "Pick a platform.");
  assert.match(parsePostFields(form({ ...base, search_intent: "buy" })).error, /search intent/);
  assert.match(parsePostFields(form({ ...base, copy: "   " })).error, /copy/);
  assert.match(parsePostFields(form({ ...base, copy: "x".repeat(3001) })).error, /under 3000/);
  assert.match(parsePostFields(form({ ...base, platform: "facebook", post_type: "offer" })).error, /Business Profile posts/);
  assert.match(parsePostFields(form({ ...base, post_type: "offer" })).error, /needs one of the client's offers/);
  assert.match(parsePostFields(form({ ...base, crm_facts_only: "on" })).error, /navigational posts/);
  assert.match(parsePostFields(form({ ...base, cta_url: "http://a.example.test" })).error, /https/);
  assert.match(parsePostFields(form({ ...base, service_id: "not-a-uuid" })).error, /not valid/);

  const ok = parsePostFields(
    form({ ...base, search_intent: "navigational", crm_facts_only: "on", cta_url: "https://a.example.test/contact", notes: " " })
  );
  assert.ok(ok.ok);
  assert.equal(ok.value.crm_facts_only, true);
  assert.equal(ok.value.post_type, "standard");
  assert.equal(ok.value.notes, null);
  assert.equal(ok.value.service_id, null);
});

test("history names people by name and never shows an Auth UUID", () => {
  const names = new Map([["tm-1", "Tom Example"]]);
  assert.equal(
    describePostEvent({ kind: "approved", actor_kind: "team", actor_id: "tm-1", from_value: "in_review", to_value: "approved", detail: {} }, names),
    "Tom Example: Approved"
  );
  assert.equal(
    describePostEvent({ kind: "created", actor_kind: "worker", actor_id: null, from_value: null, to_value: "draft", detail: {} }, names),
    "Worker: Drafted"
  );
  const lapse = describePostEvent(
    { kind: "grounding_lapsed", actor_kind: "system", actor_id: null, from_value: "approved", to_value: "in_review", detail: { problems: ["The offer is not confirmed."] } },
    names
  );
  assert.match(lapse, /^System: What the post stands on changed — The offer is not confirmed\. — Sent back to review\.$/);
  const recorded = describePostEvent(
    { kind: "grounding_lapsed", actor_kind: "system", actor_id: null, from_value: "approved", to_value: "approved", detail: { problems: ["x"] } },
    names
  );
  assert.match(recorded, /Recorded only/);
  assert.equal(
    describePostEvent({ kind: "rejected", actor_kind: "team", actor_id: "gone", from_value: null, to_value: null, detail: { note: "Too salesy" } }, names),
    "A former teammate: Rejected — “Too salesy”"
  );
});

test("database refusals read as instructions", () => {
  assert.equal(postErrorMessage('new row for relation "social_posts" violates check constraint "social_posts_execution_needs_approval"'), "Only an approved post can be scheduled.");
  assert.equal(postErrorMessage("insert or update on table \"post_claims\" violates foreign key constraint"), "That belongs to another client or no longer exists.");
  assert.equal(postErrorMessage("The post cannot be submitted: A commercial post needs at least one confirmed or sourced claim."),
    "The post cannot be submitted: A commercial post needs at least one confirmed or sourced claim.");
  assert.equal(postErrorMessage(undefined), "That did not work.");
});
