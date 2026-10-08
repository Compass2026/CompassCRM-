// Zernio → canonical imported post (supabase/functions/social-history/map.ts).
// The dry run and the import share this mapping. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldReport, formatOf, mapPost } from "../supabase/functions/social-history/map.ts";
import { ACCOUNT, OTHER_ACCOUNT, PAGE, zPost } from "./fixtures/zernio-fake.mjs";

test("a synced Facebook photo post maps every field; reactions come from Zernio's likes", () => {
  const m = mapPost(zPost(1), ACCOUNT);
  assert.equal(m.ok, true);
  const r = m.row;
  assert.equal(r.platform_post_id, `${PAGE}_9001`);
  assert.equal(r.provider_post_id, "ext000000000000000000001");
  assert.equal(r.provider_scheduled_id, null);
  assert.equal(r.permalink, `https://www.facebook.com/${PAGE}/posts/9001`);
  assert.equal(r.published_at, "2026-10-06T15:00:00.000Z");
  assert.match(r.copy, /Fictionville/);
  assert.equal(r.format, "photo");
  assert.deepEqual(r.media, [{ type: "image", url: "https://media.zernio.example/1.jpg", thumbnail_url: "https://media.zernio.example/1.jpg", alt: null, status: null, width: null, height: null }]);
  assert.equal(r.is_paid, false);
  assert.equal(r.is_owner, true);
  assert.equal(r.metrics.reactions, 21);
  assert.equal(r.metrics.impressions, 401);
  assert.equal(r.metrics.reach, 301);
  assert.equal(r.metrics.comments, 3);
  assert.equal(r.metrics.shares, 1);
  assert.equal(r.metrics.clicks, 5);
  assert.equal(r.metrics.views, 0, "a real zero stays zero");
  assert.equal(r.metrics.saves, null, "saves is not a Facebook metric");
  assert.deepEqual(r.metrics.unavailable, ["saves"]);
  assert.equal(r.metrics.provider_updated_at, "2026-10-07T12:00:00.000Z");
  assert.ok(!("content" in r.raw), "copy is stored once, in its column");
  assert.deepEqual(m.notes, []);
});

test("zero reach and impressions next to real engagement are recorded as not supplied, not as zero", () => {
  const m = mapPost(zPost(2, { analytics: { impressions: 0, reach: 0, likes: 14, comments: 2, shares: 0, saves: 0, clicks: 0, views: 0, engagementRate: 0, lastUpdated: "2026-10-07T12:00:00Z" } }), ACCOUNT);
  assert.equal(m.row.metrics.impressions, null);
  assert.equal(m.row.metrics.reach, null);
  assert.equal(m.row.metrics.engagement_rate, null);
  assert.equal(m.row.metrics.reactions, 14);
  assert.deepEqual(m.row.metrics.unavailable, ["engagement_rate", "impressions", "reach", "saves"]);
  assert.ok(m.notes.includes("insights_not_supplied"));
  // No engagement at all: zeros are believable and kept.
  const quiet = mapPost(zPost(3, { analytics: { impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, clicks: 0, views: 0 } }), ACCOUNT);
  assert.equal(quiet.row.metrics.reach, 0);
});

test("pending or unavailable analytics give no snapshot, with the reason noted", () => {
  const p = mapPost(zPost(4, { syncStatus: "pending" }), ACCOUNT);
  assert.equal(p.row.metrics, null);
  assert.ok(p.notes.includes("metrics_pending"));
  const u = mapPost(zPost(5, { syncStatus: "unavailable", errorCode: "permission_missing" }), ACCOUNT);
  assert.equal(u.row.metrics, null);
  assert.ok(u.notes.includes("metrics_unavailable:permission_missing"));
});

test("formats: album, video, reel, story, text", () => {
  const two = [{ type: "image", url: "https://m.example/a.jpg", thumbnail: "https://m.example/a.jpg" }, { type: "image", url: "https://m.example/b.jpg", thumbnail: "https://m.example/b.jpg" }];
  assert.equal(mapPost(zPost(6, { mediaType: "carousel", mediaItems: two }), ACCOUNT).row.format, "album");
  assert.equal(mapPost(zPost(7, { mediaType: "image", mediaItems: two }), ACCOUNT).row.format, "album");
  assert.equal(mapPost(zPost(8, { mediaType: "video", mediaItems: [{ type: "video", url: "https://m.example/v.mp4", thumbnail: "https://m.example/v.jpg" }] }), ACCOUNT).row.format, "video");
  assert.equal(mapPost(zPost(9, { mediaType: "video", url: "https://www.facebook.com/reel/123", mediaItems: [{ type: "video", url: null, thumbnail: "https://m.example/v.jpg", mediaStatus: "unavailable" }] }), ACCOUNT).row.format, "reel");
  const story = mapPost(zPost(10, { url: `https://www.facebook.com/stories/${PAGE}/1` }), ACCOUNT);
  assert.equal(story.row.format, "story");
  assert.equal(story.row.metrics.clicks, null, "Meta has no story clicks");
  const text = mapPost(zPost(11, { mediaType: "text" }), ACCOUNT);
  assert.equal(text.row.format, "text");
  assert.deepEqual(text.row.media, []);
  assert.equal(formatOf({ mediaType: null, mediaItems: [] }, null), "text");
});

test("withheld media, paid delivery, posts the Page did not author and Zernio-scheduled posts are flagged", () => {
  const w = mapPost(zPost(12, { mediaType: "video", mediaItems: [{ type: "video", url: null, thumbnail: null, mediaStatus: "unavailable", unavailableReason: "platform_withheld" }] }), ACCOUNT);
  assert.ok(w.notes.includes("media_withheld"));
  assert.equal(w.row.media[0].status, "unavailable");
  const ad = mapPost(zPost(13, { isAd: true }), ACCOUNT);
  assert.equal(ad.row.is_paid, true);
  assert.ok(ad.notes.includes("paid_delivery"));
  const visitor = mapPost(zPost(14, { isOwner: false }), ACCOUNT);
  assert.equal(visitor.row.is_owner, false);
  assert.ok(visitor.notes.includes("not_authored_by_page"));
  const viaZernio = mapPost(zPost(15, { latePostId: "67000000000000000000abcd" }), ACCOUNT);
  assert.equal(viaZernio.row.provider_scheduled_id, "67000000000000000000abcd");
});

test("a post is skipped, never guessed, without this account's entry, a platform id or a publish time", () => {
  assert.deepEqual(mapPost(zPost(16), OTHER_ACCOUNT), { ok: false, reason: "not_this_account", provider_post_id: "ext000000000000000000016" });
  assert.equal(mapPost(zPost(17, { platformPostId: null }), ACCOUNT).reason, "no_platform_post_id");
  assert.equal(mapPost(zPost(18, { publishedAt: null }), ACCOUNT).reason, "no_published_at");
  const http = mapPost(zPost(19, { url: "http://insecure.example/p" }), ACCOUNT);
  assert.equal(http.row.permalink, null);
  assert.ok(http.notes.includes("no_permalink"));
});

test("the field report counts what arrived across a sample", () => {
  const posts = [zPost(1), zPost(2, { syncStatus: "pending" }), zPost(3, { mediaType: "text" }), zPost(4, { platformPostId: null })];
  const rep = fieldReport(posts, posts.map((p) => mapPost(p, ACCOUNT)));
  assert.equal(rep.returned, 4);
  assert.equal(rep.mappable, 3);
  assert.deepEqual(rep.skipped, { no_platform_post_id: 1 });
  assert.equal(rep.fields.copy, 3);
  assert.equal(rep.fields.media_items, 2);
  assert.deepEqual(rep.formats, { photo: 2, text: 1 });
  assert.equal(rep.metrics.synced, 2);
  assert.equal(rep.metrics.not_synced, 1);
  assert.deepEqual(rep.metrics.per_metric.reactions, { present: 2, zero: 0, unavailable: 0 });
  assert.deepEqual(rep.metrics.per_metric.saves, { present: 0, zero: 0, unavailable: 2 });
});
