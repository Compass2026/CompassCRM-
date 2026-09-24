// Business Profile channel rules for the post publisher (0046): what can go
// to Google as approved, the exact request, retry timing and the check
// before re-sending. Pure; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalPost,
  channelProblems,
  findExistingPost,
  isTransient,
  nextRetryAt,
} from "../supabase/functions/post-publisher/channel.ts";

const std = (o = {}) => ({ platform: "google_business", post_type: "standard", copy: "Slow drains? We clear them the same week.", cta_type: "LEARN_MORE", cta_url: "https://a.example.test/drains", assets: [], ...o });
const codes = (s) => channelProblems(s).map((p) => p.code);

test("a well-formed standard post has no problems", () => {
  assert.deepEqual(channelProblems(std()), []);
  assert.deepEqual(channelProblems(std({ cta_type: null, cta_url: null })), [], "no button is fine");
  assert.deepEqual(channelProblems(std({ cta_type: "CALL", cta_url: null })), []);
});

test("preflight catches what Google would refuse", () => {
  assert.deepEqual(codes(std({ platform: "facebook" })), ["not_gbp"]);
  assert.deepEqual(codes(std({ copy: "  " })), ["no_copy"]);
  assert.deepEqual(codes(std({ copy: "x".repeat(1501) })), ["too_long"]);
  assert.deepEqual(codes(std({ copy: "x".repeat(1500) })), []);
  assert.deepEqual(codes(std({ cta_type: "CLICK_HERE" })), ["cta_unknown"]);
  assert.deepEqual(codes(std({ cta_url: null })), ["cta_needs_link"]);
  assert.deepEqual(codes(std({ cta_url: "http://a.example.test" })), ["link_not_https"]);
  assert.deepEqual(codes(std({ cta_type: "CALL", cta_url: "https://a.example.test" })), ["cta_call_has_link"]);
  assert.deepEqual(codes(std({ cta_type: null })), ["link_without_cta"]);
  const photo = (n) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, storage_path: `c/p${i}.jpg`, url: null, sort_order: i }));
  assert.deepEqual(codes(std({ assets: photo(1) })), []);
  assert.deepEqual(codes(std({ assets: photo(2) })), ["too_many_photos"], "one photo per post in v1");
  assert.deepEqual(codes(std({ assets: [{ id: "a", storage_path: null, url: "http://x", sort_order: 0 }] })), ["photo_unusable"]);
});

test("offer posts need their offer's terms; the link is a redeem link", () => {
  const offer = { id: "o1", title: "Free estimates", terms: "Free estimates on any drain job.", starts_on: null, ends_on: null };
  assert.deepEqual(codes({ ...std(), post_type: "offer", cta_type: null, offer }), []);
  assert.deepEqual(codes({ ...std(), post_type: "offer", offer: null }), ["offer_missing"]);
  assert.deepEqual(codes({ ...std(), post_type: "offer", offer: { ...offer, terms: " " } }), ["offer_terms_missing"]);
  assert.deepEqual(codes({ ...std(), post_type: "offer", offer, cta_url: "http://x" }), ["link_not_https"]);
});

test("the request is built from the snapshot exactly", () => {
  assert.deepEqual(buildLocalPost(std(), null), {
    languageCode: "en-US", summary: "Slow drains? We clear them the same week.", topicType: "STANDARD",
    callToAction: { actionType: "LEARN_MORE", url: "https://a.example.test/drains" },
  });
  assert.deepEqual(buildLocalPost(std({ cta_type: "CALL", cta_url: null }), "https://signed.example/p.jpg"), {
    languageCode: "en-US", summary: "Slow drains? We clear them the same week.", topicType: "STANDARD",
    callToAction: { actionType: "CALL" }, media: [{ mediaFormat: "PHOTO", sourceUrl: "https://signed.example/p.jpg" }],
  });
  const offer = { id: "o1", title: "Fall special", terms: "$79 drain clearing", starts_on: "2026-10-01", ends_on: "2026-10-31" };
  assert.deepEqual(buildLocalPost({ ...std(), post_type: "offer", cta_type: null, offer }, null), {
    languageCode: "en-US", summary: "Slow drains? We clear them the same week.", topicType: "OFFER",
    offer: { termsConditions: "$79 drain clearing", redeemOnlineUrl: "https://a.example.test/drains" },
    event: { title: "Fall special", schedule: { startDate: { year: 2026, month: 10, day: 1 }, endDate: { year: 2026, month: 10, day: 31 } } },
  });
  // A standing offer: no dates, so no schedule is invented.
  const standing = buildLocalPost({ ...std(), post_type: "offer", cta_url: null, offer: { ...offer, starts_on: null, ends_on: null } }, null);
  assert.deepEqual(standing.event, { title: "Fall special" });
  assert.deepEqual(standing.offer, { termsConditions: "$79 drain clearing" });
  assert.equal(standing.callToAction, undefined, "offer posts carry a redeem link, not a button");
});

test("only 429, 5xx and network failures are transient; retries back off and stop at three", () => {
  for (const s of [null, 429, 500, 503]) assert.equal(isTransient(s), true, String(s));
  for (const s of [400, 401, 403, 404, 409]) assert.equal(isTransient(s), false, String(s));
  const t = "2026-09-24T10:00:00.000Z";
  assert.equal(nextRetryAt(t, 1).toISOString(), "2026-09-24T10:10:00.000Z");
  assert.equal(nextRetryAt(t, 2).toISOString(), "2026-09-24T10:30:00.000Z");
  assert.equal(nextRetryAt(t, 3), null, "three attempts, then a person decides");
});

test("the check before re-sending matches the same text created after the last attempt", () => {
  const posts = [
    { name: "accounts/1/locations/2/localPosts/old", summary: "Slow drains? We clear them the same week.", createTime: "2026-09-20T09:00:00Z" },
    { name: "accounts/1/locations/2/localPosts/new", summary: "Slow drains?  We clear them\nthe same week.", createTime: "2026-09-24T10:00:30Z", searchUrl: "https://g.example/new" },
  ];
  assert.equal(findExistingPost(posts, "Slow drains? We clear them the same week.", "2026-09-24T10:00:00Z").name, "accounts/1/locations/2/localPosts/new");
  assert.equal(findExistingPost(posts, "Different text", "2026-09-24T10:00:00Z"), null);
  assert.equal(findExistingPost(posts, "Slow drains? We clear them the same week.", "2026-09-25T00:00:00Z"), null, "older than the attempt");
  assert.equal(findExistingPost(posts, "Slow drains? We clear them the same week.", null), null, "no previous attempt, nothing to find");
});
