import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runAuthority } from "../supabase/functions/authority/engine.ts";
import { lucasAuthority, ROOF } from "./fixtures/authority-lucas.mjs";

const source = readFileSync(new URL("../src/components/authority/keyword-campaigns.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function("require", "exports", compiled)(createRequire(import.meta.url), exports);
const render = (campaigns) => renderToStaticMarkup(createElement(exports.KeywordCampaigns, { campaigns }));

test("campaign UI renders the shared foundation, channel boundaries and unknown measurements", () => {
  const campaign = runAuthority(lucasAuthority()).campaigns.find((c) => c.service_id === ROOF);
  const html = render([campaign]);
  for (const text of ["Primary keyword", "Supporting keyword cluster", "Owner target page", "Intent mix", "Authority objective", "Business Profile", "Facebook", "Paid ads", "Not planned", "Traffic and conversions: not connected"]) assert.ok(html.includes(text), text);
  assert.match(html, /<summary/);
  assert.match(html, /scope="col"/);
  assert.match(html, /Publication requires human approval/);
  assert.equal(render([]), "");
});

test("campaign UI exposes blockers and escapes stored content", () => {
  const campaign = runAuthority(lucasAuthority()).campaigns[0];
  campaign.name = "<script>untrusted</script>";
  campaign.blockers = ["Resolve competing owners"];
  const html = render([campaign]);
  assert.match(html, /Foundation blocked/);
  assert.match(html, /Resolve competing owners/);
  assert.ok(!html.includes("<script>"));
});
