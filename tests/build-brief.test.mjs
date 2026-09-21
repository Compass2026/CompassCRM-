import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeBuildBrief, renderBuildBriefMarkdown, attachPreviewOutcome, FOUNDATION_V1 } from "../src/lib/build-brief.ts";
import { detectContentContract } from "../src/lib/content-adapters.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/sites.json", import.meta.url), "utf8"));
const trees = JSON.parse(readFileSync(new URL("./fixtures/trees.json", import.meta.url), "utf8"));
const now = new Date("2026-09-20T12:00:00Z");

test("new build: v1-pinned brief with the Foundation brand-content adapter, not Astro", () => {
  const b = composeBuildBrief({ ...fx.new_build, generatedBy: "test", now });
  assert.equal(b.work_mode, "new_build");
  assert.equal(b.standard.source_sha, FOUNDATION_V1.source_sha);
  assert.equal(b.standard.applies_as, "source");
  assert.equal(b.content_adapter.key, "foundation_brand_content");
  assert.equal(b.framework.stack, "nextjs");
  assert.equal(b.framework.foundation_adopted, true);
  assert.equal(b.repository.production_branch, "main");
  assert.equal(b.content_adapter.mutations.city_page, "pull_request");
  assert.ok(b.standard.documents.length === 3);
});

test("the city gate: coverage plus distinctive material is planned; coverage alone stays a candidate", () => {
  const b = composeBuildBrief({ ...fx.new_build, generatedBy: "test", now });
  const northgate = b.page_plan.find((p) => p.group === "Northgate, MO");
  const eastgate = b.page_plan.find((p) => p.group === "Eastgate, MO");
  assert.equal(northgate.status, "planned");
  assert.equal(northgate.route, "/service-area/northgate-mo");
  assert.equal(eastgate.status, "candidate");
  assert.ok(b.missing_inputs.some((m) => m.startsWith("city Eastgate, MO")));
  // links only to planned/existing pages
  assert.ok(b.internal_links.some((l) => l.to === "Northgate, MO"));
  assert.ok(!b.internal_links.some((l) => l.to === "Eastgate, MO"));
});

test("unverified claims are recorded as not usable and missing inputs are explicit", () => {
  const b = composeBuildBrief({ ...fx.new_build, generatedBy: "test", now });
  const founded = b.factual_sources.find((f) => f.claim === "Founded 1998");
  assert.equal(founded.usable, false);
  assert.ok(b.missing_inputs.some((m) => m.includes("photo assets")));
  assert.match(b.contact.recipients, /server-side/);
});

test("client retains the site: no push, proposed documents only", () => {
  const b = composeBuildBrief({ ...fx.client_retains, generatedBy: "test", now });
  assert.equal(b.work_mode, "client_retains");
  assert.equal(b.content_adapter.key, "unsupported");
  assert.equal(b.repository.preview_branch, null);
  assert.deepEqual(Object.values(b.content_adapter.mutations), ["proposed_document", "proposed_document", "proposed_document", "proposed_document"]);
  assert.ok(b.acceptance_checks.some((c) => /no push/.test(c)));
});

test("existing-site upgrade with a non-main production branch keeps its branch, framework and production configuration and plans a preview", () => {
  const detected = detectContentContract(trees.markdown_blog);
  const b = composeBuildBrief({ ...fx.upgrade_non_main, detected, generatedBy: "test", now });
  assert.equal(b.work_mode, "upgrade_existing");
  assert.equal(b.repository.production_branch, "production");
  assert.equal(b.repository.pr_base, "production");
  assert.match(b.repository.preview_branch, /^compass\/preview-20260920-/);
  assert.equal(b.repository.vercel_project, "ridge-safety");
  assert.equal(b.repository.production_url, "https://ridge.example");
  assert.equal(b.framework.stack, "nextjs");
  assert.equal(b.framework.foundation_adopted, false); // a version is not evidence of adoption
  assert.equal(b.framework.foundation_sha, null);
  assert.equal(b.standard.applies_as, "reference");
  assert.equal(b.content_adapter.key, "markdown_blog");
  assert.match(b.contact.form, /preserve/);
  assert.ok(b.acceptance_checks.some((c) => c.includes("production unchanged until Tom merges")));
});

test("an existing city page counts as existing; a city group with no page and no evidence is a candidate", () => {
  const b = composeBuildBrief({ ...fx.upgrade_non_main, detected: detectContentContract(trees.markdown_blog), generatedBy: "test", now });
  assert.equal(b.page_plan.find((p) => p.group === "St. Louis, MO").status, "exists");
  assert.equal(b.page_plan.find((p) => p.group === "Chicago, IL").status, "candidate");
});

test("a Foundation site whose brand is not recorded is not writable and says why", () => {
  const foundation = JSON.parse(readFileSync(new URL("./fixtures/foundation-v1-tree.json", import.meta.url), "utf8"));
  const site = { ...fx.upgrade_non_main.site, content_paths: null };
  const b = composeBuildBrief({ ...fx.upgrade_non_main, site, detected: detectContentContract(foundation), generatedBy: "test", now });
  assert.equal(b.content_adapter.key, "foundation_brand_content");
  assert.equal(b.framework.foundation_adopted, false);
  assert.ok(b.missing_inputs.some((m) => /content_paths\.brand is not recorded/.test(m)));
  assert.ok(b.missing_inputs.some((m) => /not writable/.test(m)));
  const ok = composeBuildBrief({ ...fx.upgrade_non_main, site, detected: detectContentContract(foundation, { brand: "showme" }), generatedBy: "test", now });
  assert.equal(ok.framework.foundation_adopted, true);
  // The pinned SHA moves when a Foundation change is accepted (v1 went to
  // f928381 on Sept 21 2026 for service-area support). Assert against the
  // constant, not a literal, so a move shows up as one edit in one place.
  assert.equal(ok.framework.foundation_sha, FOUNDATION_V1.source_sha);
});

test("the Markdown rendering carries the pinned SHA, the branches and the acceptance checklist", () => {
  const md = renderBuildBriefMarkdown(composeBuildBrief({ ...fx.upgrade_non_main, generatedBy: "test", now }));
  assert.ok(md.includes(FOUNDATION_V1.source_sha));
  assert.match(md, /Production branch of record: `production`/);
  assert.match(md, /- \[ \] /);
});

test("verification results and preview links attach to the existing work records", () => {
  const b = composeBuildBrief({ ...fx.upgrade_non_main, generatedBy: "test", now });
  const out = attachPreviewOutcome(b, {
    branch: "compass/preview-20260920-ridge",
    base: "production",
    commit_url: "https://github.com/Compass2026/ridge-safety/commit/abc",
    pull_request_url: "https://github.com/Compass2026/ridge-safety/pull/7",
    deployment_url: "https://ridge-safety-abc.vercel.app",
    checks: [
      { name: "typecheck", result: "pass" },
      { name: "crawl", result: "pass" },
      { name: "browser suite", result: "deferred", detail: "no Chromium in the Routine environment" },
    ],
  }, now);
  assert.equal(out.brief.repository.production_branch, "production");
  assert.equal(out.brief.repository.preview_branch, "compass/preview-20260920-ridge");
  assert.equal(out.brief.preview.pull_request_url, "https://github.com/Compass2026/ridge-safety/pull/7");
  assert.deepEqual(out.brief.evidence.builder_checks, ["pass: typecheck", "pass: crawl"]);
  assert.deepEqual(out.brief.evidence.deferred, ["browser suite (no Chromium in the Routine environment)"]);
  assert.match(out.evidence_line, /production unchanged/);
  assert.equal(out.deliverables.length, 2);
  assert.equal(out.change_log.status, "proposed");
  assert.equal(out.change_log.after.production_branch, "production");
  assert.match(out.decision.rule_text, /never relabels/);
});
