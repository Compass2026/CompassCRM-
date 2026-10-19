// Blog TL;DR (Oct 18 2026, 20261018230000): the rule in the brief, the
// linter and the parser; exactly-once delivery for a site with the TL;DR slot
// (Logic Solar), a JSON site without it (Ginger Huff's real contract) and an
// MDX site; the live check; and the legacy policy (approvals and releases made
// without a TL;DR are neither blocked nor rewritten).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBlogBrief, BLOG_RULES } from "../supabase/functions/content-drafter/brief.ts";
import { lintBlog } from "../supabase/functions/content-drafter/lint.ts";
import { parseBlogDraft, createContentDrafter } from "../supabase/functions/content-drafter/handler.ts";
import { preparePublication } from "../supabase/functions/content-drafter/publication.ts";
import { toMarkdown } from "../supabase/functions/content-drafter/markdown.ts";
import { tldrProblems, sentenceCount, bodyWithTldr, TLDR_LABEL } from "../supabase/functions/content-drafter/tldr.ts";
import { verifyLiveArticle } from "../supabase/functions/blog-publisher/handler.ts";
import { lucas, GAZETTEER, SITE } from "./fixtures/drafter-lucas.mjs";
import { GOOD_BLOG, draftRow } from "./fixtures/blog-lucas.mjs";

const clone = (v) => JSON.parse(JSON.stringify(v));
const brief = () => buildBlogBrief(lucas(), draftRow(), [{ url: `${SITE}/blog/gutters-and-your-roof`, title: "Gutters and your roof" }]).brief;
const codes = (r) => r.problems.map((p) => p.code);
const lint = (over = {}, b = brief()) => lintBlog(b, { ...clone(GOOD_BLOG), ...over }, { gazetteer: GAZETTEER });
const TLDR = GOOD_BLOG.tldr;

test("the brief carries the TL;DR rule in its own block, not in `rules` (legacy foundations stay equal)", () => {
  const b = brief();
  assert.equal(b.tldr.label, "TL;DR");
  assert.equal(b.tldr.required, true);
  assert.deepEqual(b.tldr.rules, { tldr_min_sentences: 2, tldr_max_sentences: 3, tldr_max_chars: 450 });
  assert.ok(b.tldr.guidance.some((g) => /body supports/.test(g)));
  assert.ok(!Object.keys(BLOG_RULES).some((k) => k.startsWith("tldr")), "rules unchanged, so approvals made before Oct 18 still match");
});

test("lint: a new blog without a valid TL;DR cannot pass", () => {
  assert.deepEqual(codes(lint()), [], "the good draft (with its TL;DR) passes");
  assert.ok(codes(lint({ tldr: undefined })).includes("tldr_missing"));
  assert.ok(codes(lint({ tldr: "   " })).includes("tldr_missing"));
  assert.ok(codes(lint({ tldr: "A roof wears out gradually." })).includes("tldr_sentences"), "one sentence");
  assert.ok(codes(lint({ tldr: "One. Two things. Three things. Four things." })).includes("tldr_sentences"), "four sentences");
  assert.ok(codes(lint({ tldr: `${"A roof wears out gradually over many seasons. ".repeat(10)}` })).includes("tldr_too_long"));
  assert.ok(codes(lint({ tldr: `TL;DR: ${TLDR}` })).includes("tldr_label_included"));
  assert.ok(codes(lint({ tldr: "Read the [guide](https://example.com). It explains the signs." })).includes("tldr_format"));
  assert.ok(codes(lint({ tldr: "A roof wears out **gradually**. Plan ahead." })).includes("tldr_format"));
  assert.ok(codes(lint({ tldr: "A roof wears out gradually.\nPlan a repair on your own schedule." })).includes("tldr_format"));
  assert.ok(codes(lint({ tldr: `${GOOD_BLOG.meta_description}` })).some((c) => c === "tldr_duplicates_metadata" || c === "tldr_sentences"));
  assert.ok(codes(lint({ body_markdown: `**TL;DR:** ${TLDR}\n\n${GOOD_BLOG.body_markdown}` })).includes("tldr_in_body"), "never twice");
});

test("lint: the TL;DR is held to the article's fact rules (no new numbers, prices, promises)", () => {
  assert.ok(codes(lint({ tldr: "Most roofs last 25 years. Plan a replacement before then." })).some((c) => c.startsWith("unsupported_")));
  assert.ok(codes(lint({ tldr: "We offer emergency repairs. Call before a small leak grows." })).includes("unsupported_response"));
  assert.ok(codes(lint({ tldr: "We are the best roofer in town. Call for a look at your roof." })).includes("unsupported_superlative"));
});

test("lint: a draft briefed before the rule is not asked for one (legacy review stays valid)", () => {
  const legacy = brief();
  delete legacy.tldr;
  assert.deepEqual(codes(lint({ tldr: undefined }, legacy)), []);
});

test("parse: tldr is optional at the boundary, a string, trimmed", () => {
  assert.equal(parseBlogDraft({ ...GOOD_BLOG, tldr: `  ${TLDR}  ` }).tldr, TLDR);
  assert.equal("tldr" in parseBlogDraft({ ...GOOD_BLOG, tldr: undefined }), false);
  assert.match(parseBlogDraft({ ...GOOD_BLOG, tldr: 42 }), /tldr/);
});

test("sentence counting ignores common abbreviations", () => {
  assert.equal(sentenceCount("The U.S. Department of Energy says roof age matters. Plan ahead."), 2);
  assert.equal(sentenceCount("Ask questions, e.g. about shade. Then compare."), 2);
  assert.deepEqual(tldrProblems(TLDR, GOOD_BLOG), []);
});

test("submit sends the TL;DR to the write boundary with the content", async () => {
  const calls = [];
  const store = {
    secret: async (n) => (n === "SYNC_CRON_SECRET" ? "cron" : null),
    teamMemberForJwt: async () => null,
    draft: async () => draftRow(), input: async () => lucas(), sitePages: async () => [],
    claimHolder: async () => null,
    write: async (p) => { calls.push(p); return { draft_id: p.draft_id, status: "in_review", version: 1, word_count: 900 }; },
  };
  const fn = createContentDrafter({ store, gazetteer: { MO: GAZETTEER } });
  const post = (body) => fn.handle(new Request("https://x/content-drafter", { method: "POST", headers: { "x-cron-secret": "cron" }, body: JSON.stringify(body) }));
  const b = await (await post({ mode: "brief", draft_id: draftRow().id })).json();
  const bad = await post({ mode: "submit", draft_id: draftRow().id, brief_hash: b.brief_hash, runtime: "t", draft: { ...GOOD_BLOG, tldr: undefined } });
  assert.equal(bad.status, 422);
  assert.ok((await bad.json()).problems.some((p) => p.code === "tldr_missing"));
  assert.equal(calls.length, 0, "nothing written");
  const ok = await post({ mode: "submit", draft_id: draftRow().id, brief_hash: b.brief_hash, runtime: "t", draft: GOOD_BLOG });
  assert.equal(ok.status, 201);
  assert.equal(calls[0].content.tldr, TLDR);
  assert.ok(!calls[0].content.body_markdown.includes(TLDR_LABEL));
});

test("Markdown export: H1, then the TL;DR once, then the body; none for a legacy draft", () => {
  const md = toMarkdown({ ...GOOD_BLOG });
  assert.match(md, /\n# How long does a roof last\?\n\n\*\*TL;DR:\*\* A roof wears out gradually[^\n]+\n\n## What wears a roof out/);
  assert.equal(md.split("TL;DR").length - 1, 1);
  assert.ok(!toMarkdown({ ...GOOD_BLOG, tldr: null }).includes("TL;DR"));
});

// ── Delivery ────────────────────────────────────────────────────────────────
const hash = "sha256:" + "a".repeat(64);
const release = (over = {}) => ({
  draft_id: "a922bdfa-2adb-4a80-8fe2-c8f489beed00", client_id: "client", version: 5, keyword_id: "keyword",
  title: "Solar consultation", slug: "solar-consultation", meta_title: "Solar Consultation", meta_description: "What to gather.",
  h1: "What to gather before a solar consultation", body_markdown: "## Bills\n\nBring [your bills](https://www.example.test/services/installation).",
  tldr: "Bring a year of utility bills and notes on your roof. The design starts from that information.",
  cta: { text: "Get a quote", url: "https://www.example.test/contact" }, internal_links: [],
  destination: { site_id: "site", url: "https://www.example.test", repo_url: "https://github.com/example/site", branch: "main",
    content_adapter: "json_blog", content_paths: { blog: "data/blog-posts.json", blog_route: "/blog/{slug}/" }, controlled_by_compass: true },
  ...over,
});
// Ginger Huff's real compass-blog.json (Compass2026/gingerhuff-website@main, Oct 18 2026): no TL;DR slot.
const GINGER = { version: 1, adapter: "json_blog", keyword_provenance: true, markdown: true, seo_fields: true };
// Logic Solar's contract with the TL;DR slot (Compass2026/Logic-Solar, this release).
const LOGIC = { ...GINGER, hero_image: true, hero_image_dir: "public/blog/images", hero_image_url_prefix: "/blog/images/", tldr: true };
const read = (contract, extra = []) => ({ head: "b".repeat(40), repo_url: "https://github.com/example/site", branch: "main", files: [
  { path: "compass-blog.json", content: JSON.stringify(contract) }, { path: "data/blog-posts.json", content: "[]" }, ...extra] });
const article = (out) => JSON.parse(out.files[0].content)[0];

test("a site with the TL;DR slot gets the field; the body is untouched", () => {
  const out = preparePublication(release(), hash, read(LOGIC), "2026-10-18");
  const a = article(out);
  assert.equal(a.tldr, release().tldr);
  assert.equal(a.bodyMarkdown, release().body_markdown);
  assert.equal(out.tldr_mode, "slot");
});

test("a site without the slot (Ginger) gets it once, as the first paragraph of the body", () => {
  const out = preparePublication(release(), hash, read(GINGER), "2026-10-18");
  const a = article(out);
  assert.equal(a.tldr, undefined);
  assert.equal(a.bodyMarkdown, `**TL;DR:** ${release().tldr}\n\n${release().body_markdown}`);
  assert.equal(a.bodyMarkdown.split("TL;DR").length - 1, 1);
  assert.equal(out.tldr_mode, "body");
});

test("an MDX site gets it once at the top of the body", () => {
  const mdx = release({ destination: { ...release().destination, content_adapter: "markdown_blog", content_paths: { blog_dir: "content/blog", blog_route: "/blog/{slug}/" } } });
  const contract = { ...GINGER, adapter: "markdown_blog" };
  const out = preparePublication(mdx, hash, { ...read(contract), files: [{ path: "compass-blog.json", content: JSON.stringify(contract) }] }, "2026-10-18");
  const body = out.files[0].content.split("---\n").slice(2).join("---\n");
  assert.ok(body.startsWith(`\n**TL;DR:** ${release().tldr}\n\n## Bills`), body.slice(0, 120));
});

test("a release approved without a TL;DR is delivered exactly as before", () => {
  const legacy = release({ tldr: undefined });
  for (const contract of [GINGER, LOGIC]) {
    const out = preparePublication(legacy, hash, read(contract), "2026-10-18");
    const a = article(out);
    assert.equal(a.tldr, undefined);
    assert.equal(a.bodyMarkdown, legacy.body_markdown);
    assert.equal(out.tldr_mode, null);
  }
});

test("a hero site without the slot refuses rather than putting the summary under the image", () => {
  const hero = { asset_id: "x", content_hash: "f".repeat(64), alt: "Bills on a table", kind: "social_post", illustrative: true,
    mime_type: "image/png", width: 10, height: 10, size_bytes: 3, storage_path: "c/u/x.png" };
  const heroOnly = { ...LOGIC };
  delete heroOnly.tldr;
  assert.throws(() => preparePublication(release({ hero }), hash, read(heroOnly), "2026-10-18", { base64: "AAA=" }), /TL;DR upgrade/);
  assert.equal(preparePublication(release({ hero }), hash, read(LOGIC), "2026-10-18", { base64: "AAA=" }).tldr_mode, "slot");
});

test("markup in a TL;DR is refused at publication", () => {
  assert.throws(() => preparePublication(release({ tldr: "Bring <b>bills</b>. Then talk." }), hash, read(GINGER), "2026-10-18"), /manual review/);
});

test("the live check needs the labelled TL;DR exactly once, after the H1 and before the article and hero", () => {
  const r = release();
  const url = "https://www.example.test/blog/solar-consultation/";
  const page = (inner) => `<html><head></head><body><article data-compass-release="${hash}"><h1>${r.h1}</h1>${inner}<p>Bring <a href="https://www.example.test/services/installation">your bills</a>.</p><a href="${url}">self</a></article></body></html>`;
  const tl = `<aside><p>TL;DR</p><p>${r.tldr}</p></aside>`;
  assert.equal(verifyLiveArticle(page(tl + "<h2>Bills</h2>"), r, hash, url), true);
  assert.equal(verifyLiveArticle(page("<h2>Bills</h2>"), r, hash, url), false, "missing");
  assert.equal(verifyLiveArticle(page(tl + tl + "<h2>Bills</h2>"), r, hash, url), false, "twice");
  assert.equal(verifyLiveArticle(page(`<p>${r.tldr}</p><h2>Bills</h2>`), r, hash, url), false, "unlabelled");
  assert.equal(verifyLiveArticle(page("<h2>Bills</h2>").replace("</article>", `${tl}</article>`), r, hash, url), false, "after the article");
  // Structured data repeating the summary (JSON-LD "abstract") is not a second visible TL;DR,
  // and text that exists only in structured data never satisfies the visible checks.
  const jsonLd = `<script type="application/ld+json">${JSON.stringify({ "@type": "BlogPosting", abstract: r.tldr, headline: r.h1 })}</script>`;
  assert.equal(verifyLiveArticle(page(tl + "<h2>Bills</h2>").replace("<head></head>", `<head>${jsonLd}</head>`), r, hash, url), true, "JSON-LD abstract");
  assert.equal(verifyLiveArticle(page("<h2>Bills</h2>").replace("<head></head>", `<head>${jsonLd}</head>`), r, hash, url), false, "summary only in JSON-LD");
  const legacy = release({ tldr: undefined });
  assert.equal(verifyLiveArticle(page("<h2>Bills</h2>"), legacy, hash, url), true, "legacy release unaffected");
});

test("bodyWithTldr is a no-op without a summary", () => {
  assert.equal(bodyWithTldr("## A\n\nB", null), "## A\n\nB");
  assert.equal(bodyWithTldr("## A\n\nB", "One. Two."), "**TL;DR:** One. Two.\n\n## A\n\nB");
});
