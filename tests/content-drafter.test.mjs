// The content-drafter (supabase/functions/content-drafter): the blog brief,
// the lint (the post drafter's detectors on every word a reader sees, plus
// the article's own rules), the request boundary and the Markdown export.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBlogBrief, blogBriefHash, BLOG_RULES } from "../supabase/functions/content-drafter/brief.ts";
import { lintBlog, wordCount } from "../supabase/functions/content-drafter/lint.ts";
import { createContentDrafter, parseBlogDraft } from "../supabase/functions/content-drafter/handler.ts";
import { toMarkdown } from "../supabase/functions/content-drafter/markdown.ts";
import { lucas, GAZETTEER, OC, REVIEWS, FREE_QUOTES, PAGE, SITE } from "./fixtures/drafter-lucas.mjs";
import { GOOD_BLOG, draftRow, DRAFT_ID } from "./fixtures/blog-lucas.mjs";

const clone = (v) => JSON.parse(JSON.stringify(v));
const brief = () => {
  const r = buildBlogBrief(lucas(), draftRow(), [{ url: `${SITE}/blog/gutters-and-your-roof`, title: "Gutters and your roof" }]);
  assert.ok(r.ok, JSON.stringify(r));
  return r.brief;
};
const codes = (r) => r.problems.map((p) => p.code);
const lint = (over = {}) => lintBlog(brief(), { ...clone(GOOD_BLOG), ...over }, { gazetteer: GAZETTEER });

test("brief: the post drafter's gate and claim rule, the client's own pages, the standing CTA", () => {
  const b = brief();
  assert.equal(b.kind, "blog");
  assert.equal(b.target.search_intent, "informational");
  assert.deepEqual(b.target.service, { id: draftRow().service_id, name: "Roof Replacement", page_url: PAGE });
  assert.ok(b.allowed_facts.claims.some((c) => c.id === OC));
  for (const id of [REVIEWS, FREE_QUOTES]) assert.ok(b.excluded.claims.some((c) => c.id === id), id);
  assert.deepEqual(b.links.required.map((l) => l.url), [PAGE]);
  const allowed = b.links.allowed.map((l) => l.url);
  assert.ok(allowed.includes(SITE) && allowed.includes(PAGE) && allowed.includes(`${SITE}/blog/gutters-and-your-roof`));
  assert.ok(!allowed.includes(`${SITE}/services/metal`), "a draft service's page is not linkable");
  assert.deepEqual(b.cta, { text: "Request a quote", url: PAGE });
  assert.equal(b.rules.min_words, BLOG_RULES.min_words);
});

test("brief: refusals — a web page, no intent, an unapproved board, no usable claim", () => {
  const no = (input, row, code) => {
    const r = buildBlogBrief(input, row);
    assert.ok(!r.ok && r.refusals.some((x) => x.code === code), `${code}: ${JSON.stringify(r)}`);
  };
  no(lucas(), draftRow({ deliverable: "web_page" }), "deliverable_unsupported");
  no(lucas(), draftRow({ search_intent: null }), "intent_missing");
  const unapproved = lucas(); unapproved.board.status = "draft";
  no(unapproved, draftRow(), "brand_board_not_approved");
  const noClaims = lucas(); noClaims.claims = noClaims.claims.filter((c) => c.status === "unverified");
  no(noClaims, draftRow(), "no_usable_claim");
});

test("brief hash: stable for the same record, different when the record changes", async () => {
  assert.equal(await blogBriefHash(brief()), await blogBriefHash(brief()));
  const changed = lucas(); changed.board.standing_cta = "Book an inspection";
  const r = buildBlogBrief(changed, draftRow());
  assert.notEqual(await blogBriefHash(r.brief), await blogBriefHash(brief()));
});

test("lint: the good draft passes", () => {
  const r = lint();
  assert.ok(wordCount(GOOD_BLOG.body_markdown) >= BLOG_RULES.min_words);
  assert.deepEqual(r.problems, []);
});

test("lint: the post drafter's factual refusals, on every word a reader sees", () => {
  const add = (s) => ({ body_markdown: GOOD_BLOG.body_markdown + `\n${s}\n` });
  assert.ok(codes(lint(add("A new roof can cost less than you think."))).includes("unsupported_pricing"));
  assert.ok(codes(lint(add("Most roofs last about twenty to 30 years."))).some((c) => ["unsupported_tenure", "unsupported_number"].includes(c)));
  assert.ok(codes(lint(add("Every job carries our Lifetime Workmanship Warranty."))).includes("unsupported_credential"), "a credential not linked as a claim");
  assert.ok(codes(lint(add("Our crews are the best in the area."))).includes("unsupported_superlative"));
  assert.ok(codes(lint(add("Asphalt holds up well here."))).includes("unsupported_material"));
  assert.ok(codes(lint(add("Your roof needs to be replaced."))).includes("unsupported_diagnosis"));
  assert.ok(codes(lint(add("We also work in O'Fallon."))).includes("unapproved_location"));
  assert.ok(codes(lint(add("Call (314) 555-0100 today."))).includes("wrong_phone"));
  assert.ok(codes(lint({ title: "The best roofs in Wentzville" })).includes("unsupported_superlative"), "the title is read too");
  assert.ok(codes(lint({ claim_ids: [OC, REVIEWS] })).includes("claim_not_allowed"));
});

test("lint: structure, links and the CTA", () => {
  assert.ok(codes(lint({ slug: "How Long?" })).includes("slug_invalid"));
  assert.ok(codes(lint({ meta_title: "x".repeat(80) })).includes("meta_title_too_long"));
  assert.ok(codes(lint({ meta_description: "Too short." })).includes("meta_description_too_short"));
  assert.ok(codes(lint({ body_markdown: "# Title\n" + GOOD_BLOG.body_markdown })).includes("h1_in_body"));
  assert.ok(codes(lint({ outline: [...GOOD_BLOG.outline, { level: 2, heading: "Not in the body" }] })).includes("outline_mismatch"));
  assert.ok(codes(lint({ body_markdown: GOOD_BLOG.body_markdown.split("## Signs")[0] })).includes("too_short"));
  assert.ok(codes(lint({ body_markdown: GOOD_BLOG.body_markdown.replace(`(${PAGE})`, "(https://other.example.test/roofs)") }))
    .some((c) => c === "link_not_allowed"));
  assert.ok(codes(lint({ body_markdown: GOOD_BLOG.body_markdown.replace(`[roof replacement](${PAGE})`, "roof replacement") })).includes("required_link_missing"));
  assert.ok(codes(lint({ body_markdown: GOOD_BLOG.body_markdown + "\nSee https://lucasconstructionmo.com/\n" })).includes("url_in_body"));
  assert.ok(codes(lint({ cta: { text: "Get a free estimate", url: PAGE } })).includes("cta_not_standing"));
  assert.ok(codes(lint({ internal_links: [{ url: "https://competitor.example.test/", anchor: "x" }] })).includes("link_not_allowed"));
  const stuffed = lint({ body_markdown: GOOD_BLOG.body_markdown + "\nhow long does a roof last ".repeat(6) });
  assert.ok(codes(stuffed).includes("keyword_stuffing"));
});

function fakeStore({ row = draftRow(), writeResult = null } = {}) {
  const calls = [];
  return {
    calls,
    async secret(n) { return n === "SYNC_CRON_SECRET" ? "cron" : null; },
    async teamMemberForJwt(j) { return j === "team-jwt" ? "m-1" : null; },
    async draft(id) { return id === row.id ? row : null; },
    async input() { return lucas(); },
    async sitePages() { return []; },
    async write(p) { calls.push(p); return writeResult ?? { draft_id: p.draft_id, status: "in_review", version: 1, word_count: 820 }; },
    async openWeekly(p) { calls.push(["open", p]); return { draft_id: DRAFT_ID, plan_item_id: "pi", status: "requested", reused: false }; },
  };
}
const call = async (fn, body, headers = { "x-cron-secret": "cron" }) => {
  const r = await fn.handle(new Request("http://x", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};

test("handler: callers, brief, a stale brief, lint failures write nothing, submit writes once", async () => {
  const store = fakeStore();
  const fn = createContentDrafter({ store, gazetteer: { MO: GAZETTEER } });
  assert.equal((await call(fn, { mode: "version" }, {})).status, 401);
  assert.equal((await call(fn, { mode: "version" }, { authorization: "Bearer nope" })).status, 403);
  assert.equal((await call(fn, { mode: "version" }, { authorization: "Bearer team-jwt" })).status, 200);
  const b = await call(fn, { mode: "brief", draft_id: DRAFT_ID });
  assert.equal(b.status, 200);
  assert.match(b.body.brief_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await call(fn, { mode: "submit", draft_id: DRAFT_ID, brief_hash: "sha256:" + "0".repeat(64), runtime: "test", draft: GOOD_BLOG })).status, 409);
  const bad = await call(fn, { mode: "submit", draft_id: DRAFT_ID, brief_hash: b.body.brief_hash, runtime: "test", draft: { ...GOOD_BLOG, title: "The best roof guide" } });
  assert.equal(bad.status, 422);
  assert.equal(store.calls.length, 0, "a draft that fails lint is not written");
  const chk = await call(fn, { mode: "check", draft_id: DRAFT_ID, brief_hash: b.body.brief_hash, draft: GOOD_BLOG });
  assert.equal(chk.body.ok, true, JSON.stringify(chk.body.problems));
  const ok = await call(fn, { mode: "submit", draft_id: DRAFT_ID, brief_hash: b.body.brief_hash, runtime: "claude-worker-skill", draft: GOOD_BLOG });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const [p] = store.calls;
  assert.deepEqual(p.claim_ids, [OC]);
  assert.equal(p.content.claim_ids, undefined, "claims travel as relations, not inside the content");
  assert.equal(p.content.slug, GOOD_BLOG.slug);
  assert.equal(p.submit, true);
  assert.equal(p.brief_hash, b.body.brief_hash);
});

test("handler: a draft in review or approved is not written; the draft is parsed strictly", async () => {
  const fn = createContentDrafter({ store: fakeStore({ row: draftRow({ status: "in_review" }) }) });
  assert.equal((await call(fn, { mode: "brief", draft_id: DRAFT_ID })).status, 409);
  assert.equal((await call(createContentDrafter({ store: fakeStore() }), { mode: "brief", draft_id: "nope" })).status, 400);
  assert.match(parseBlogDraft({ ...GOOD_BLOG, outline: "x" }), /outline/);
  assert.match(parseBlogDraft({ ...GOOD_BLOG, claim_ids: ["x"] }), /claim_ids/);
});

test("Markdown export: front matter, the H1, the body, the CTA", () => {
  const md = toMarkdown({ ...GOOD_BLOG, primary_keyword: "how long does a roof last" });
  assert.match(md, /^---\ntitle: "How long does a roof last\? What Wentzville homeowners should know"\nslug: "how-long-does-a-roof-last"\n/);
  assert.match(md, /\nmeta_description: ".+"\nprimary_keyword: "how long does a roof last"\n---\n\n# How long does a roof last\?\n\n## What wears a roof out/);
  assert.ok(md.trimEnd().endsWith(`[Request a quote](${PAGE})`));
});

test("handler: open (the weekly blog) is the worker's alone and names the task, topic and intent", async () => {
  const store = fakeStore();
  const fn = createContentDrafter({ store });
  const body = { mode: "open", task_id: "11111111-1111-4111-8111-111111111111", topic: "When to clear a slow drain", search_intent: "informational" };
  assert.equal((await call(fn, body, { authorization: "Bearer team-jwt" })).status, 403);
  assert.equal((await call(fn, { ...body, topic: " " })).status, 400);
  assert.equal((await call(fn, { ...body, keyword_id: "nope" })).status, 400);
  const r = await call(fn, body);
  assert.equal(r.status, 201);
  assert.deepEqual(store.calls[0], ["open", { task_id: body.task_id, topic: body.topic, search_intent: "informational", keyword_id: null, service_id: null }]);
  assert.deepEqual((await call(fn, { mode: "version" })).body.modes, ["brief", "check", "submit", "open", "version"]);
});
