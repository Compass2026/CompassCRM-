// Shared fixtures for the Creative Engine tests: the production snapshot of
// Lucas's governed facts, and synthetic stand-in photos / logo at the
// production sizes, rasterised by the pinned engine (deterministic).
import fs from "node:fs";
import crypto from "node:crypto";
import { nodeEngine } from "../../scripts/lib/creative-engine-node.mjs";
import { specHash } from "../../supabase/functions/creative-engine/spec.ts";
import { lucasPreviewRefs } from "../../supabase/functions/creative-engine/previews.ts";

export const read = (p) => fs.readFileSync(new URL(`../${p.replace(/^\.\//, "")}`, import.meta.url), "utf8");
export const FACTS = JSON.parse(read("./fixtures/creative-lucas-facts.json"));
export const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
export const clone = (v) => JSON.parse(JSON.stringify(v));

export const RR = "4288b96c-db9f-436e-b492-78f5fa7f1f21";
export const SIDING = "c60685d4-16f9-4544-9978-3d7182b47edf";
export const C = {
  oc: "818761df-41bb-41ab-afab-6ecbe4779803", dur: "fa1d2070-c56c-4a75-a7ce-43effb6f0d21", bbb: "7c2a2d65-8242-4734-851d-fa3d6f58911e",
  scope: "fc6e22d0-f704-43f8-b39b-24f8750ada61", free: "d7c9864d-6e9e-4010-bd5c-4e0e5128ce72", warranty: "64d13e2d-c6d0-417d-b5c8-b3f368fb2077",
  reviews: "ca802383-d8a4-42ea-a7a1-c2747e113cff", address: "b73742bd-3d98-40f5-997f-846860397621", storm: "28ba6126-91e5-478b-8aae-2ec2ee9ea111",
};
export const P = {
  hero: "3a5e930a-1841-4cc3-860e-f6abbdf3e5a1", crane: "c7db9166-f6ed-4581-8aaf-fbe6aeee43d5", a1: "db8e7148-8f13-47c4-9ecf-47053df220e6",
  a2: "1979f6aa-accb-46b0-919a-7af48d7d6f87", done: "db6eec44-9c4d-4313-82d7-d27e5dfd9bda", edge: "8dfb59dd-1aab-4f2f-9200-1aff067b5396",
  owner: "57d63a06-12d6-4a92-9950-495736f385a8", excluded: "3b515e61-f713-454a-a746-96853d0487f0",
};
export const LOGO = "0c945d6f-c1ff-4b94-8c2b-afa777366e35";

// ── Synthetic sources: deterministic stand-ins at the production sizes ──────
export { ORANGE } from "./creative-synthetic.mjs";
import { syntheticSvg } from "./creative-synthetic.mjs";
let sources;
export async function syntheticSources() {
  if (sources) return sources;
  const engine = await nodeEngine();
  const facts = clone(FACTS);
  const bytes = new Map();
  for (const a of facts.assets) {
    if (!a.width) continue;
    const png = engine.rasterize(syntheticSvg(a));
    a.content_hash = sha(png);
    bytes.set(a.content_hash, png);
  }
  sources = { facts, bytes, reader: async (a) => bytes.get(a.content_hash) };
  return sources;
}

export async function requestFor(t, over = {}) {
  return { template: { key: t.key, version: t.version, spec_hash: await specHash(t.spec) }, client_id: FACTS.client.id,
    ...lucasPreviewRefs(t.key), ...over };
}
