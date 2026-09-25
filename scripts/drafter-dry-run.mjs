#!/usr/bin/env node
// AI Drafter v1 dry run. Read-only: it reads a DrafterInput JSON (from
// scripts/drafter-input.sql) and writes nothing anywhere.
//
//   node --no-warnings scripts/drafter-dry-run.mjs --input input.json \
//     --service "Roof Replacement" --intent commercial \
//     --keyword "roof replacement wentzville" --page /services/roof-replacement \
//     --cta LEARN_MORE [--channel google_business] [--type standard]
//
//   Prints the governed brief, its hash, the chosen and excluded claims and
//   facts, the channel rules and the model request — or every refusal.
//
//   Add --lint to judge a draft read from stdin: {"copy": "...", "claim_ids": [...]}.
//   The draft is only printed with its result; it is never saved.
import fs from "node:fs";
import { buildBrief, briefHash } from "../supabase/functions/post-drafter/brief.ts";
import { lintDraft } from "../supabase/functions/post-drafter/lint.ts";
import { modelRequest } from "../supabase/functions/post-drafter/prompt.ts";

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);
const die = (msg) => { console.error(msg); process.exit(2); };

const inputPath = arg("input") ?? die("--input <DrafterInput JSON> is required (see scripts/drafter-input.sql).");
let input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
if (Array.isArray(input)) input = input[0];
if (input && input.input) input = input.input;

const service = arg("service") ? input.services.find((s) => s.name.toLowerCase() === arg("service").toLowerCase()) : null;
if (arg("service") && !service) die(`No service named "${arg("service")}".`);
const keyword = arg("keyword") ? input.keywords.find((k) => k.keyword.toLowerCase() === arg("keyword").toLowerCase()) : null;
if (arg("keyword") && !keyword) die(`No keyword "${arg("keyword")}".`);
if (arg("page") && service && !(service.page_url ?? "").replace(/\/+$/, "").endsWith(arg("page").replace(/\/+$/, ""))) {
  die(`${service.name}'s page is ${service.page_url}, not ${arg("page")}.`);
}

const target = {
  channel: arg("channel", "google_business"),
  postType: arg("type", "standard"),
  intent: arg("intent") ?? die("--intent is required."),
  serviceId: service?.id ?? null,
  keywordId: keyword?.id ?? null,
  ctaType: arg("cta"),
  offerId: arg("offer"),
  assetIds: arg("assets") ? arg("assets").split(",") : [],
};

const result = buildBrief(input, target);
if (!result.ok) {
  console.log(JSON.stringify({ eligible: false, target, refusals: result.refusals }, null, 2));
  process.exit(1);
}
const { brief } = result;
const hash = await briefHash(brief);

// Places from the bundled GeoNames list, for the client's state.
const cities = JSON.parse(fs.readFileSync(new URL("../src/data/us-cities.json", import.meta.url), "utf8"));
const gazetteer = [...new Set(cities.filter((c) => c[1] === input.client.state).map((c) => c[0]))];

if (flag("lint")) {
  const draft = JSON.parse(fs.readFileSync(0, "utf8"));
  const lint = lintDraft(brief, draft, { gazetteer });
  console.log(JSON.stringify({ brief_hash: hash, characters: draft.copy.trim().length, ...lint }, null, 2));
  process.exit(lint.ok ? 0 : 1);
}

console.log(JSON.stringify({
  eligible: true,
  brief_hash: hash,
  chosen_claims: brief.allowed_facts.recommended_claim_ids.map((id) => brief.allowed_facts.claims.find((c) => c.id === id)),
  excluded: brief.excluded,
  channel_rules: brief.channel_rules,
  brief,
  model_request: flag("request") ? modelRequest(brief) : undefined,
}, null, 2));
