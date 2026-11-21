// Content drafts in the CRM (src/lib/content-drafts.ts): what each status
// offers, and the Markdown preview (text only, http(s) links only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftActions, draftStatusLabels, isDraftStatus, parseMarkdown, parseInline, supersedeCandidates } from "../src/lib/content-drafts.ts";

test("what a teammate may do in each status", () => {
  const a = (status, extra = {}) => draftActions({ status, final_content_post_id: null, title: "x", ...extra });
  assert.deepEqual(a("requested"), ["supersede", "delete", "export"]);
  assert.deepEqual(a("draft"), ["edit", "submit", "regenerate", "supersede", "delete", "export"]);
  assert.deepEqual(a("in_review"), ["approve", "reject", "withdraw", "delete", "export"]);
  assert.deepEqual(a("rejected"), ["edit", "regenerate", "delete", "export"]);
  assert.deepEqual(a("approved"), ["reopen", "export"]);
  assert.ok(!a("draft", { final_content_post_id: "p" }).includes("delete"), "a draft that made the final article is kept");
  assert.ok(!a("requested", { title: null }).includes("export"));
});

test("superseded is terminal: a record, never edited, regenerated, retired again or deleted", () => {
  assert.ok(isDraftStatus("superseded"));
  assert.equal(draftStatusLabels.superseded.label, "Superseded");
  assert.deepEqual(draftActions({ status: "superseded", final_content_post_id: null, title: "x" }), ["export"]);
  assert.deepEqual(draftActions({ status: "superseded", final_content_post_id: null, title: null }), []);
});

test("supersede candidates: other live drafts, the same keyword first, then newest", () => {
  const self = { id: "self", keyword_id: "kw" };
  const rows = [
    { id: "self", status: "requested", keyword_id: "kw", updated_at: "2026-11-20" },
    { id: "old-same", status: "in_review", keyword_id: "kw", updated_at: "2026-11-06" },
    { id: "new-other", status: "draft", keyword_id: "kw2", updated_at: "2026-11-19" },
    { id: "retired", status: "superseded", keyword_id: "kw", updated_at: "2026-11-20" },
    { id: "newer-same", status: "approved", keyword_id: "kw", updated_at: "2026-11-10" },
  ];
  assert.deepEqual(supersedeCandidates(self, rows).map((r) => r.id), ["newer-same", "old-same", "new-other"]);
  assert.deepEqual(supersedeCandidates({ id: "x", keyword_id: null }, rows.slice(1, 3)).map((r) => r.id), ["new-other", "old-same"]);
});

test("Markdown preview: headings, paragraphs, lists, emphasis, safe links", () => {
  const b = parseMarkdown("## One\n\nFirst line\nsecond line.\n\n- a\n- **b**\n\n1. x\n2. y\n\n### Two\nSee [our page](https://x.example.test/p) and [bad](javascript:alert(1)).");
  assert.deepEqual(b.map((x) => x.t), ["h2", "p", "ul", "ol", "h3", "p"]);
  assert.equal(b[1].inline[0].v, "First line second line.");
  assert.deepEqual(b[2].items[1], [{ t: "strong", v: "b" }]);
  const last = b[5].inline;
  assert.deepEqual(last.find((i) => i.t === "link"), { t: "link", v: "our page", href: "https://x.example.test/p" });
  assert.ok(!last.some((i) => i.t === "link" && i.href.startsWith("javascript")), "only http(s) links");
  assert.ok(last.some((i) => i.t === "text" && i.v.includes("[bad](javascript:alert(1))")), "anything else stays text");
  assert.deepEqual(parseInline("<script>x</script>"), [{ t: "text", v: "<script>x</script>" }]);
});
