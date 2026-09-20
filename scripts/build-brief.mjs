#!/usr/bin/env node
// Compose a website build brief from CRM rows the worker already exported.
//
//   node --no-warnings scripts/build-brief.mjs input.json            # JSON brief to stdout
//   node --no-warnings scripts/build-brief.mjs input.json --markdown # the Drive document body
//   node --no-warnings scripts/build-brief.mjs input.json --attach outcome.json
//
// input.json = { client, site, services, pageGroups, claims, locations, brand,
//   assets, cityEvidence?, tree?: string[] (paths from site-push {read:true}),
//   repoDefaultBranch?, generatedBy }
// With `tree`, the content adapter is detected from the actual repository
// (src/lib/content-adapters.ts); without it the brief says so under
// missing_inputs. `--attach` folds a preview outcome (see attachPreviewOutcome)
// into the brief and prints the rows to record.
//
// Zero dependencies; Node 22.18+ strips the TypeScript it imports.
import { readFileSync } from "node:fs";
import { composeBuildBrief, renderBuildBriefMarkdown, attachPreviewOutcome } from "../src/lib/build-brief.ts";
import { detectContentContract } from "../src/lib/content-adapters.ts";

const [inputPath, ...flags] = process.argv.slice(2);
if (!inputPath) {
  console.error("usage: build-brief.mjs <input.json> [--markdown] [--attach outcome.json]");
  process.exit(2);
}
const input = JSON.parse(readFileSync(inputPath, "utf8"));
const detected = Array.isArray(input.tree) ? detectContentContract(input.tree, input.site?.content_paths ?? null) : input.detected ?? null;
let brief = composeBuildBrief({ ...input, detected, generatedBy: input.generatedBy ?? "scripts/build-brief.mjs" });

const attachIdx = flags.indexOf("--attach");
if (attachIdx >= 0) {
  const outcome = JSON.parse(readFileSync(flags[attachIdx + 1], "utf8"));
  const attached = attachPreviewOutcome(input.existingBrief ?? brief, outcome);
  console.log(JSON.stringify(attached, null, 2));
  process.exit(0);
}
if (flags.includes("--markdown")) process.stdout.write(renderBuildBriefMarkdown(brief));
else console.log(JSON.stringify(brief, null, 2));
