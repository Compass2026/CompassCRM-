// The brand-asset picker's rule (src/lib/post-media.ts): which assets a post
// may take, shared by the picker and linkAssetAction, and the text that lets
// a person tell assets with the same scanner label apart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assetEligibility, pickerText } from "../src/lib/post-media.ts";

const photo = (over = {}) => ({
  id: "db6eec44-9c4d-4313-82d7-d27e5dfd9bda", label: "Photo from the home page", kind: "photo",
  storage_path: "102d3b20-2795-44ae-bd64-d1e43916291c/scan/photo-1789337329087-10.jpg", width: 950, height: 1200,
  content_hash: "8de9ed919b5143f17afd15591457bcfbcd2a9812e5d7b2296d82dca4426e7060", creative_use: "approved",
  depicts_own_work: true, subjects: ["roof replacement", "residential roofing", "architectural shingles", "completed project", "exterior"],
  ...over,
});

test("Business Profile: only stored, hashed photos approved for creative use", () => {
  assert.deepEqual(assetEligibility("google_business", photo()), { ok: true });
  assert.equal(assetEligibility("google_business", photo({ depicts_own_work: false })).ok, true, "approved illustration stays usable");
  assert.match(assetEligibility("google_business", photo({ creative_use: "unreviewed" })).reason, /Approve the photo/);
  assert.match(assetEligibility("google_business", photo({ creative_use: "excluded" })).reason, /excluded/);
  assert.match(assetEligibility("google_business", photo({ kind: "logo_primary" })).reason, /takes a photo/);
  assert.match(assetEligibility("google_business", photo({ kind: "social_post" })).reason, /takes a photo/);
  assert.match(assetEligibility("google_business", photo({ content_hash: null })).reason, /hashed/);
  assert.match(assetEligibility("google_business", photo({ storage_path: null })).reason, /stored/);
});

test("other channels keep their rule, minus excluded assets", () => {
  assert.equal(assetEligibility("facebook", photo({ kind: "social_post", creative_use: "unreviewed", content_hash: null })).ok, true);
  assert.equal(assetEligibility("instagram", photo({ kind: "logo_primary", creative_use: "unreviewed" })).ok, true);
  assert.equal(assetEligibility("facebook", photo({ creative_use: "excluded" })).ok, false);
});

test("a generic scanner label is replaced by the reviewed subjects; the facts pin the file", () => {
  const t = pickerText(photo());
  assert.equal(t.title, "roof replacement, residential roofing, architectural shingles, completed project");
  assert.equal(t.meta, "950×1200 · own work · id db6eec44 · hash 8de9ed919b51");
  assert.match(t.alt, /roof replacement/);
  const other = pickerText(photo({ id: "db8e7148-8f13-47c4-9ecf-47053df220e6", content_hash: "8f722ede88412b673c675011892bd8fc67125ea0b4b43a37d1cc1fd745d659b8",
    subjects: ["roof replacement", "roof installation", "active project"] }));
  assert.notEqual(other.title, t.title, "two photos with the same scanner label read differently");
  assert.match(other.meta, /id db8e7148 · hash 8f722ede8841/);
});

test("a real label is kept; illustration and non-photos say what they are", () => {
  assert.equal(pickerText(photo({ label: "Brick home, new architectural shingle roof" })).title, "Brick home, new architectural shingle roof");
  assert.match(pickerText(photo({ depicts_own_work: false })).meta, /not own work \(illustration or stock\)/);
  assert.match(pickerText(photo({ kind: "logo_primary", label: "Logo", subjects: [] })).meta, /logo primary/);
  assert.match(pickerText(photo({ content_hash: null })).meta, /no hash/);
});
