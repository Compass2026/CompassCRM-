// Content drafts in the CRM (src/lib/content-drafts.ts): what each status
// offers, and the Markdown preview (text only, http(s) links only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { draftActions, parseMarkdown, parseInline } from "../src/lib/content-drafts.ts";

test("what a teammate may do in each status", () => {
  const a = (status, extra = {}) => draftActions({ status, final_content_post_id: null, title: "x", ...extra });
  assert.deepEqual(a("requested"), ["delete", "export"]);
  assert.deepEqual(a("draft"), ["edit", "submit", "regenerate", "delete", "export"]);
  assert.deepEqual(a("in_review"), ["approve", "reject", "withdraw", "delete", "export"]);
  assert.deepEqual(a("rejected"), ["edit", "regenerate", "delete", "export"]);
  assert.deepEqual(a("approved"), ["reopen", "export"]);
  assert.ok(!a("draft", { final_content_post_id: "p" }).includes("delete"), "a draft that made the final article is kept");
  assert.ok(!a("requested", { title: null }).includes("export"));
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
