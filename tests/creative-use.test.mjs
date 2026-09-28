// Creative use review rules (src/lib/creative-use.ts): what an approval
// needs, exclusion reasons, subject tags, focal points, suggestions kept
// apart, the stale-page guard and the history lines. The database enforces
// the same rules (sandbox: source_asset_hashing.test.sql).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fileBlockers, fileStatus, historyLine, parseFocal, parseSubjects, readSuggestions,
  reviewCounts, sameReviewSnapshot, validateReview,
} from "../src/lib/creative-use.ts";

const H = "a".repeat(64);
const asset = (over = {}) => ({
  id: "00000000-0000-4000-8000-000000000001", kind: "photo", source: "website_scan", label: "Photo from the home page",
  storage_path: "c/scan/p.jpg", url: "https://x.test/p.jpg", width: 1066, height: 1600,
  content_hash: H, content_hashed_at: "2026-09-28T00:00:00Z", creative_use: "unreviewed",
  depicts_own_work: null, subjects: [], focal_x: null, focal_y: null, creative_review_note: null,
  creative_reviewed_at: null, creative_suggestions: null, ...over,
});
const input = (over = {}) => ({ decision: "approved", ownWork: "yes", subjects: "roof, shingles", focalX: "50", focalY: "40", reason: "", ...over });

test("file status: hashed, unhashed, link-only, no file", () => {
  assert.equal(fileStatus(asset()), "hashed");
  assert.equal(fileStatus(asset({ content_hash: null, content_hashed_at: null })), "unhashed");
  assert.equal(fileStatus(asset({ storage_path: null })), "link_only");
  assert.equal(fileStatus(asset({ storage_path: null, url: null })), "no_file");
  assert.deepEqual(fileBlockers(asset()), []);
  assert.match(fileBlockers(asset({ storage_path: null }))[0], /brand-scan import/);
  assert.match(fileBlockers(asset({ width: null }))[0], /dimensions/);
});

test("a complete photo approval writes exactly the governed values", () => {
  const r = validateReview(asset(), input());
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { creative_use: "approved", depicts_own_work: true, subjects: ["roof", "shingles"], focal_x: 0.5, focal_y: 0.4, creative_review_note: null });
});

test("a photo approval needs the own-work decision, subjects, a focal point and a hashed file", () => {
  const errs = (a, i) => { const r = validateReview(a, i); assert.equal(r.ok, false); return r.errors.join(" | "); };
  assert.match(errs(asset(), input({ ownWork: "" })), /own work/);
  assert.match(errs(asset(), input({ subjects: "" })), /subject tag/);
  assert.match(errs(asset(), input({ focalX: "", focalY: "" })), /focal point/);
  assert.match(errs(asset({ content_hash: null, content_hashed_at: null }), input()), /not been hashed/);
  assert.match(errs(asset({ storage_path: null }), input()), /Only a link/);
  // Own work "no" is an explicit decision (the photo is then approved but unusable as a source).
  assert.equal(validateReview(asset(), input({ ownWork: "no" })).ok, true);
});

test("a logo approval needs subjects, not own work or a focal point", () => {
  const logo = asset({ kind: "logo_primary", width: 600, height: 200 });
  const r = validateReview(logo, input({ ownWork: "", focalX: "", focalY: "", subjects: "logo" }));
  assert.equal(r.ok, true); assert.equal(r.patch.depicts_own_work, null);
  assert.equal(validateReview(logo, input({ subjects: "" })).ok, false);
});

test("exclusion needs a reason; keeping unreviewed needs nothing", () => {
  assert.equal(validateReview(asset(), input({ decision: "excluded", reason: "  " })).ok, false);
  const ex = validateReview(asset({ content_hash: null, content_hashed_at: null }), input({ decision: "excluded", reason: "Shows a neighbour's house", ownWork: "" }));
  assert.equal(ex.ok, true); assert.equal(ex.patch.creative_review_note, "Shows a neighbour's house");
  const keep = validateReview(asset({ storage_path: null }), input({ decision: "unreviewed", ownWork: "", subjects: "", focalX: "", focalY: "" }));
  assert.equal(keep.ok, true); assert.equal(keep.patch.creative_use, "unreviewed");
  assert.equal(validateReview(asset(), input({ decision: "publish" })).ok, false);
});

test("subject tags: lower-cased, trimmed, de-duplicated; bad ones refused", () => {
  assert.deepEqual(parseSubjects(" Roof,  Metal   Roof, roof ,,").subjects, ["roof", "metal roof"]);
  assert.equal(parseSubjects("roof!, ok").errors.length, 1);
  assert.equal(parseSubjects(Array.from({ length: 21 }, (_, i) => `t${i}`).join(",")).errors.length, 1);
});

test("focal point: percentages in, fractions out; both or neither", () => {
  assert.deepEqual(parseFocal("50", "40"), { x: 0.5, y: 0.4, error: null });
  assert.deepEqual(parseFocal("", ""), { x: null, y: null, error: null });
  assert.ok(parseFocal("101", "5").error);
  assert.ok(parseFocal("50", "").error);
});

test("suggestions are read defensively and never contain a decision", () => {
  const s = readSuggestions({ subjects: ["Roof", "bad!", 3], focal: { x: 0.4, y: 0.3 }, depicts_own_work: true, model: "vision-x" });
  assert.deepEqual(s, { subjects: ["roof"], focal: { x: 0.4, y: 0.3 }, ownWork: true, model: "vision-x" });
  assert.equal(readSuggestions({ focal: { x: 2, y: 0 } }), null);
  assert.equal(readSuggestions("approve me"), null);
  // A suggestion alone never approves: the teammate's input decides.
  const withSugg = asset({ creative_suggestions: { subjects: ["roof"], focal: { x: 0.5, y: 0.5 }, depicts_own_work: true } });
  assert.equal(validateReview(withSugg, input({ ownWork: "", subjects: "", focalX: "", focalY: "" })).ok, false);
});

test("the stale-page guard compares file hash, state and review time", () => {
  const seen = { content_hash: H, creative_use: "unreviewed", creative_reviewed_at: null };
  assert.equal(sameReviewSnapshot(asset(), seen), true);
  assert.equal(sameReviewSnapshot(asset({ content_hash: "b".repeat(64) }), seen), false);
  assert.equal(sameReviewSnapshot(asset({ creative_reviewed_at: "2026-09-28T01:00:00Z" }), seen), false);
});

test("counts and history lines", () => {
  const c = reviewCounts([asset(), asset({ creative_use: "approved" }), asset({ creative_use: "excluded", storage_path: null })]);
  assert.deepEqual(c, { unreviewed: 1, approved: 1, excluded: 1, hashed: 2, total: 3, linkOnly: 1 });
  assert.match(historyLine({ action: "approved", actor_kind: "team", note: null, changes: { approved_content_hash: H } }, "Tom"), /^Tom approved it .*aaaaaaaaaaaa/);
  assert.match(historyLine({ action: "hashed", actor_kind: "hasher", note: null, changes: { content_hash: { from: null, to: H } } }, null), /^Source hashing recorded/);
  assert.match(historyLine({ action: "excluded", actor_kind: "team", note: "Stock photo", changes: {} }, null), /excluded it: Stock photo/);
});
