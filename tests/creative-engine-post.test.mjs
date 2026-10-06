// What a post's creative may carry (supabase/functions/creative-engine/
// post-bindings.ts): the post's service, its linked claims and the client's
// approved own-work photos of that service — picked deterministically, never
// a claim the post does not link, never people, never a stand-in photo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { postRefs, pickPhotos, seasonFor } from "../supabase/functions/creative-engine/post-bindings.ts";
import { plan } from "../supabase/functions/creative-engine/govern.ts";
import { findTemplate } from "../supabase/functions/creative-engine/registry.ts";
import { specHash } from "../supabase/functions/creative-engine/spec.ts";
import { CopyRefusal } from "../supabase/functions/creative-engine/text.ts";
import { C, P, RR, SIDING, syntheticSources } from "./helpers/creative-fixtures.mjs";

const T = (key) => findTemplate(key, 1);
const postOf = (facts, over = {}) => ({
  id: "p-1", client_id: facts.client.id, platform: "google_business", service_id: RR, copy: "x",
  review_status: "draft", creative_policy: "optional", creative_version: 0, scheduled_at: null, claim_ids: [C.oc, C.dur], ...over,
});
const refusal = (fn) => {
  try { fn(); } catch (e) { if (e instanceof CopyRefusal) return e.code; throw e; }
  return null;
};
async function planFor(key, facts, post) {
  const t = T(key);
  return plan(t.spec, facts, { template: { key, version: 1, spec_hash: await specHash(t.spec), id: "tpl" }, client_id: facts.client.id, ...postRefs(t.spec, facts, post) }, "tpl");
}

test("Service Spotlight: the service as headline, the post's claims as subline and points, the hero photo", async () => {
  const { facts } = await syntheticSources();
  const refs = postRefs(T("lucas-service-spotlight-gbp").spec, facts, postOf(facts));
  assert.deepEqual(refs.bindings.headline, { role: "service_name", source_id: RR });
  assert.deepEqual(refs.bindings.eyebrow, { role: "service_segment", source_id: RR });
  assert.deepEqual(refs.bindings.subline, { role: "claim", source_id: C.oc });
  assert.deepEqual(refs.bindings.points, [{ role: "claim", source_id: C.dur }]);
  assert.deepEqual(refs.photos, { photos: [P.hero] }, "IMG_7051 is the only hero-grade own-work photo");
  const p = await planFor("lucas-service-spotlight-gbp", facts, postOf(facts));
  assert.equal(p.service_id, RR);
});

test("claims the creative may not carry are left off; with none, the subline is the tagline", async () => {
  const { facts } = await syntheticSources();
  const post = postOf(facts, { claim_ids: [C.warranty, C.reviews, C.free, C.address] });
  const refs = postRefs(T("lucas-service-spotlight-gbp").spec, facts, post);
  assert.deepEqual(refs.bindings.subline, { role: "tagline" });
  assert.equal(refs.bindings.points, undefined);
  const p = await planFor("lucas-service-spotlight-gbp", facts, post);
  assert.ok(![...p.lines, ...Object.values(p.lists).flat()].some((l) => l.role === "claim"));
});

test("only claims linked to the post: an unlinked usable claim never appears", async () => {
  const { facts } = await syntheticSources();
  const refs = postRefs(T("lucas-trust-know-how-gbp").spec, facts, postOf(facts, { claim_ids: [C.oc, C.dur, C.bbb] }));
  const ids = [refs.bindings.headline, ...refs.bindings.points].map((b) => b.source_id);
  assert.deepEqual(ids, [C.oc, C.dur, C.bbb]);
  assert.ok(!ids.includes(C.scope));
  assert.equal(refusal(() => postRefs(T("lucas-trust-know-how-gbp").spec, facts, postOf(facts))), "not_enough_claims");
});

test("photos: approved own work of the service, no people, no repeats, never enlarged", async () => {
  const { facts } = await syntheticSources();
  for (const key of ["lucas-real-work-facebook", "lucas-service-light-gbp", "lucas-seasonal-instagram"]) {
    const picked = Object.values(pickPhotos(T(key).spec, facts, { id: RR, name: "Roof Replacement" })).flat();
    assert.equal(new Set(picked).size, picked.length, key);
    for (const id of picked) {
      const a = facts.assets.find((x) => x.id === id);
      assert.equal(a.depicts_own_work, true, key);
      assert.equal(a.creative_use, "approved", key);
      assert.ok(![P.owner, P.excluded].includes(id), key);
    }
    await planFor(key, facts, postOf(facts, { platform: T(key).channel }));
  }
  // Siding: no approved photo shows it, so there is no creative (no stand-in).
  const siding = postOf(facts, { service_id: SIDING });
  assert.equal(refusal(() => postRefs(T("lucas-service-spotlight-gbp").spec, facts, siding)), "no_eligible_photo");
});

test("Seasonal: the season of the post's Central date, never 'storm season'", async () => {
  assert.equal(seasonFor(new Date("2026-10-15T12:00:00Z")), "fall");
  assert.equal(seasonFor(new Date("2026-03-01T03:00:00Z")), "winter", "Feb 28 evening in Central time");
  assert.equal(seasonFor(new Date("2026-06-21T12:00:00Z")), "summer");
  assert.equal(seasonFor(new Date("2027-01-05T12:00:00Z")), "winter");
  const { facts } = await syntheticSources();
  const refs = postRefs(T("lucas-seasonal-gbp").spec, facts, postOf(facts, { scheduled_at: "2026-04-10T15:00:00Z" }));
  assert.deepEqual(refs.bindings.eyebrow, { role: "template_label", source_id: "spring" });
});

test("a post without a service gets no service-led template", async () => {
  const { facts } = await syntheticSources();
  for (const key of ["lucas-service-spotlight-gbp", "lucas-real-work-gbp", "lucas-service-light-gbp", "lucas-seasonal-gbp"]) {
    assert.equal(refusal(() => postRefs(T(key).spec, facts, postOf(facts, { service_id: null }))), "post_service_missing", key);
  }
});
