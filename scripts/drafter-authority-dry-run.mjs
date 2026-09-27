// Read-only dry run of post-drafter v2's Authority mode over a production
// snapshot: the deployed handler, a store that serves the snapshot and refuses
// every write. brief and check only; submit is never called.
//
//   node --no-warnings scripts/drafter-authority-dry-run.mjs <snapshot.json> [draft.txt]
//
// The snapshot is { captured_at, input: client_intelligence_input(client),
// authority: <what store.authority() returns> }, read with one SELECT.
import { readFileSync } from "node:fs";
import { createPostDrafter } from "../supabase/functions/post-drafter/handler.ts";
import gazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };

const [file, draftFile] = process.argv.slice(2);
if (!file) { console.error("usage: drafter-authority-dry-run.mjs <snapshot.json> [draft.txt]"); process.exit(2); }
const snap = JSON.parse(readFileSync(file, "utf8"));
const refuse = () => { throw new Error("dry run: writes are refused"); };
const store = {
  secret: async (n) => (n === "SYNC_CRON_SECRET" ? "dry-run" : null),
  teamMemberForJwt: async () => null,
  input: async () => snap.input,
  authority: async () => snap.authority,
  attempts: refuse, recordRun: refuse, write: refuse,
};
const drafter = createPostDrafter({ store, gazetteer, now: () => new Date(snap.captured_at) });
const call = async (body) => {
  const r = await drafter.handle(new Request("http://dry-run/post-drafter", { method: "POST", headers: { "x-cron-secret": "dry-run" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

const base = { client_id: snap.input.client.id, authority_opportunity_id: snap.authority.opportunity.id, expected_run_id: snap.authority.latest_run?.id };
const b = await call({ mode: "brief", ...base });
console.log(JSON.stringify({ mode: "brief", status: b.status, ...(b.status === 200 ? { brief_hash: b.body.brief_hash, request: b.body.request, brief: b.body.brief, instructions: b.body.model_request.instructions } : b.body) }, null, 1));
if (b.status === 200 && draftFile) {
  const [copy, ids] = readFileSync(draftFile, "utf8").split("\n---\n");
  const c = await call({ mode: "check", ...base, brief_hash: b.body.brief_hash, draft: { copy: copy.trim(), claim_ids: ids.trim().split(/\s+/) } });
  console.log(JSON.stringify({ mode: "check", status: c.status, ok: c.body.ok, characters: c.body.characters, problems: c.body.problems, warnings: c.body.warnings }, null, 1));
}
