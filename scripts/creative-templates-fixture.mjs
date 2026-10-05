// Writes tests/fixtures/creative-lucas-templates.json: every Lucas template
// version this code renders, with the spec hash the renderer computes. The
// sandbox registers each through creative_register_template and checks that
// Postgres computes the same hash; tests/creative-engine.test.mjs checks the
// file is current. Re-run after changing a spec (which is a new version).
//   node scripts/creative-templates-fixture.mjs
import fs from "node:fs";
import { lucasTemplates } from "../supabase/functions/creative-engine/registry.ts";
import { specHash } from "../supabase/functions/creative-engine/spec.ts";

export async function fixture() {
  return Promise.all(lucasTemplates().map(async (t) => ({ ...t, spec_hash: await specHash(t.spec) })));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL("../tests/fixtures/creative-lucas-templates.json", import.meta.url);
  fs.writeFileSync(out, JSON.stringify(await fixture(), null, 1) + "\n");
  console.log(`wrote ${out.pathname}`);
}
