// Compass Website Foundation v1 (foundation_brand_content): the approved hero
// image and the TL;DR slot, both opt-in through compass-blog.json (Nov 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { preparePublication, heroImagePlan } from "../supabase/functions/content-drafter/publication.ts";
import { readCompassPosts } from "../supabase/functions/content-drafter/foundation-blog.ts";
import { loadHero, verifyLiveArticle } from "../supabase/functions/blog-publisher/handler.ts";
import { validateContentEntry, detectContentContract, assertWriteAllowed, describeAdapter } from "../src/lib/content-adapters.ts";
import { resolvePushPlan } from "../supabase/functions/site-push/plan.ts";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
// What origin/main (before this change) wrote for two hero-less releases.
const BEFORE = JSON.parse(fixture("foundation-heroless-before.json"));
const SITE = "https://harbor-lane.example";
const HASH = BEFORE.cases[0].hash;
const DATE = BEFORE.cases[0].date;
const POSTS = "brands/harbor-lane/content/blog/compass-posts.ts";
const EMPTY = BEFORE.cases[0].read.files[1].content;
const CONTRACT = JSON.parse(BEFORE.cases[0].read.files[0].content);
const HERO_CONTRACT = { ...CONTRACT, tldr: true, hero_image: true, hero_image_dir: "public/blog/images", hero_image_url_prefix: "/blog/images/" };

const bytes = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4, 87, 69, 66, 80]);
const fileHash = createHash("sha256").update(bytes).digest("hex");
const b64 = { base64: Buffer.from(bytes).toString("base64") };
const hero = { asset_id: "2d897658-6dd0-4b0b-9180-1456219497e0", content_hash: fileHash, alt: "A synthetic illustration of a breaker panel",
  kind: "social_post", illustrative: true, mime_type: "image/webp", width: 1600, height: 900, size_bytes: bytes.length, storage_path: "client/hero.webp" };
const IMAGE = `public/blog/images/compass-publishing-test-${fileHash.slice(0, 12)}.webp`;
const SRC = `/blog/images/compass-publishing-test-${fileHash.slice(0, 12)}.webp`;

const release = (over = {}) => ({ ...structuredClone(BEFORE.cases[0].release), hero, ...over });
const repo = (contract = HERO_CONTRACT, posts = EMPTY, extra = []) => ({ head: "b".repeat(40), repo_url: "https://github.com/example/site", branch: "main", files: [
  { path: "compass-blog.json", content: JSON.stringify(contract) }, { path: POSTS, content: posts },
  { path: "brands/harbor-lane/content/blog/index.ts", size: 900 }, ...extra] });

test("hero-less: byte-identical to the adapter before heroes, whether or not the site opted into heroes", () => {
  for (const c of BEFORE.cases) {
    for (const contract of [CONTRACT, { ...CONTRACT, hero_image: true, hero_image_dir: "public/blog/images", hero_image_url_prefix: "/blog/images/" }]) {
      const out = preparePublication(c.release, c.hash, { ...c.read, files: [{ path: "compass-blog.json", content: JSON.stringify(contract) }, c.read.files[1]] }, c.date);
      assert.deepEqual(out, c.result, `${c.name}, hero_image ${contract.hero_image}`);
    }
  }
});

test("hero: the posts file and the content-addressed image in one change; typed heroImage; TL;DR in its slot above it", () => {
  const out = preparePublication(release(), HASH, repo(), DATE, b64);
  assert.equal(out.already_present, false);
  assert.equal(out.expected_head, "b".repeat(40));
  assert.deepEqual(out.files.map((f) => [f.path, f.encoding ?? "utf-8"]), [[POSTS, "utf-8"], [IMAGE, "base64"]]);
  assert.equal(out.files[1].content, b64.base64);
  assert.equal(out.hero_src, SRC);
  assert.equal(out.tldr_mode, "slot");
  const [a] = readCompassPosts(out.files[0].content).posts;
  assert.deepEqual(Object.keys(a), ["slug", "path", "title", "tldr", "seo", "excerpt", "publishedAt", "heroImage", "relatedServices", "body", "compass"]);
  assert.deepEqual(a.heroImage, { src: SRC, alt: hero.alt, width: 1600, height: 900, illustrative: true });
  assert.equal(a.tldr, release().tldr);
  assert.equal(JSON.stringify(a.body).includes("TL;DR"), false, "the summary is in the slot, not the body");
  assert.equal(a.image, undefined, "the hand-added client photo field is never written");
  assert.equal(a.seo.title, release().meta_title, "the approved meta title is carried as the SEO title");
  assert.equal(a.title, release().h1);
  assert.ok(!/Illustrat/i.test(JSON.stringify(a.body)), "no visible caption is added");
  // the slot without a hero still keeps the body free of the summary
  const slotOnly = readCompassPosts(preparePublication(release({ hero: null }), HASH, repo(), DATE).files[0].content).posts[0];
  assert.equal(slotOnly.tldr, release().tldr);
  assert.equal(slotOnly.heroImage, undefined);
});

test("hero refusals: not opted in, wrong folder or prefix, no TL;DR slot, missing bytes, bad file facts", () => {
  const p = (r, contract = HERO_CONTRACT, bytesIn = b64) => () => preparePublication(r, HASH, repo(contract), DATE, bytesIn);
  assert.throws(p(release(), CONTRACT), /hero image upgrade/);
  assert.throws(p(release(), { ...HERO_CONTRACT, hero_image: "yes" }), /hero image upgrade/);
  assert.throws(p(release(), { ...HERO_CONTRACT, hero_image_dir: "public/photos" }), /folder does not match/);
  assert.throws(p(release(), { ...HERO_CONTRACT, hero_image_url_prefix: "https://cdn.example/" }), /URL prefix/);
  assert.throws(p(release(), { ...HERO_CONTRACT, tldr: false }), /TL;DR upgrade/, "the summary must sit above the hero");
  assert.equal(p(release({ tldr: null }), { ...HERO_CONTRACT, tldr: false })().files.length, 2, "a release without a summary needs no slot");
  assert.throws(p(release(), HERO_CONTRACT, null), /could not be loaded/);
  assert.throws(p(release({ hero: { ...hero, alt: " " } })), /alt text/);
  assert.throws(p(release({ hero: { ...hero, alt: "Two\nlines" } })), /alt text requires manual review/);
  assert.throws(p(release({ hero: { ...hero, mime_type: "image/gif" } })), /PNG, JPEG or WebP/);
  assert.throws(p(release({ hero: { ...hero, height: 0 } })), /dimensions/);
  assert.throws(p(release({ hero: { ...hero, content_hash: "abc" } })), /PNG, JPEG or WebP/);
  // a recorded folder other than the default must be what the site advertises
  const custom = release({ destination: { ...release().destination, content_paths: { ...release().destination.content_paths, blog_images: "public/blog/compass" } } });
  assert.throws(p(custom), /folder does not match/);
  assert.equal(p(custom, { ...HERO_CONTRACT, hero_image_dir: "public/blog/compass", hero_image_url_prefix: "/blog/compass/" })().files[1].path,
    `public/blog/compass/compass-publishing-test-${fileHash.slice(0, 12)}.webp`);
  // adapters that have no hero field still refuse
  assert.throws(() => heroImagePlan(release({ destination: { ...release().destination, content_adapter: "manual" } }), HERO_CONTRACT), /cannot carry a hero image/);
});

test("duplicates and retries: idempotent for the same release, refused for another, never a half-published hero", () => {
  const first = preparePublication(release(), HASH, repo(), DATE, b64);
  const published = first.files[0].content;
  // the same release with post and image committed: already present, nothing written
  const again = preparePublication(release(), HASH, repo(HERO_CONTRACT, published, [{ path: IMAGE, size: bytes.length }]), DATE, b64);
  assert.equal(again.already_present, true);
  assert.deepEqual(again.files, []);
  assert.equal(again.hero_src, SRC, "reconciliation still verifies the image on the live page");
  // a second publication of the same draft (a new approval, so a new release hash) is refused
  assert.throws(() => preparePublication(release({ version: 4 }), "sha256:" + "4".repeat(64), repo(HERO_CONTRACT, published, [{ path: IMAGE, size: bytes.length }]), DATE, b64), /slug already exists/);
  // another article on the same slug, hero-less or not
  assert.throws(() => preparePublication(release({ hero: null }), "sha256:" + "5".repeat(64), repo(HERO_CONTRACT, published), DATE), /slug already exists/);
  // a hand-written post on the slug
  assert.throws(() => preparePublication(release(), HASH, repo(HERO_CONTRACT, EMPTY, [{ path: "brands/harbor-lane/content/blog/compass-publishing-test.ts", size: 10 }]), DATE, b64), /hand-written/);
  // the post is there but its image is not
  assert.throws(() => preparePublication(release(), HASH, repo(HERO_CONTRACT, published), DATE, b64), /hero image is missing/);
  // the image is there (an earlier attempt), the post is not: only the post is written
  assert.deepEqual(preparePublication(release(), HASH, repo(HERO_CONTRACT, EMPTY, [{ path: IMAGE, size: bytes.length }]), DATE).files.map((f) => f.path), [POSTS]);
  // a different file at the content-addressed path
  assert.throws(() => preparePublication(release(), HASH, repo(HERO_CONTRACT, EMPTY, [{ path: IMAGE, size: 999 }]), DATE, b64), /different file/);
});

test("the publisher loads only the exact approved bytes (sha256)", async () => {
  assert.deepEqual(await loadHero({ heroImage: async () => bytes }, release()), b64);
  await assert.rejects(loadHero({ heroImage: async () => new Uint8Array([1, 2, 3]) }, release()), /changed since approval/);
  await assert.rejects(loadHero({}, release()), /could not be loaded/);
  assert.equal(await loadHero({}, release({ hero: null })), undefined);
});

test("live verification on a Foundation page: the hero's src and alt, below the TL;DR, with the approved meta title", () => {
  const url = `${SITE}/blog/compass-publishing-test`;
  const live = fixture("foundation-blog-page.html").replace(/<meta name="robots"[^>]*>/, "");
  const at = "It is never published.</p>";
  const withImg = (img) => live.replace(at, `${at}${img}`);
  const img = `<img alt="${hero.alt}" fetchPriority="high" width="1600" height="900" decoding="async" class="aspect-[16/9] h-auto w-full object-cover" src="${SRC}"/>`;
  const r = release({ body_markdown: [
    "## Why a quick check helps", "",
    `This is a synthetic publishing test with generic text. It checks that an approved article reaches the page intact, including links to [the service page](${SITE}/services/residential).`, "",
    "## What the test covers", "",
    "- Headings, paragraphs and **strong** text",
    "- A numbered list and *emphasis*",
    "- Links to the site's own pages and to an external source", "",
    "1. The CRM converts the approved Markdown.",
    "2. The site renders the typed blocks.", "",
    "## Sources", "",
    "- [Example reference](https://www.example.com/) — general reference",
  ].join("\n") });
  assert.equal(verifyLiveArticle(withImg(img), r, HASH, url, SRC), true);
  assert.equal(verifyLiveArticle(withImg(img.replace(SRC, `https://harbor-lane.example${SRC}`)), r, HASH, url, SRC), true, "an absolute src on the same path");
  assert.equal(verifyLiveArticle(live, r, HASH, url, SRC), false, "no image");
  assert.equal(verifyLiveArticle(withImg(img.replace(hero.alt, "Another alt")), r, HASH, url, SRC), false, "alt");
  assert.equal(verifyLiveArticle(withImg(img.replace(SRC, "/blog/images/other.webp")), r, HASH, url, SRC), false, "src");
  assert.equal(verifyLiveArticle(withImg(img), r, HASH, url, null), false, "no planned src");
  const above = live.replace(/<article([^>]*)>/, `<article$1>${img}`);
  assert.equal(verifyLiveArticle(above, r, HASH, url, SRC), false, "the image above the TL;DR");
  assert.equal(verifyLiveArticle(withImg(img).replace(/<title>[^<]*<\/title>/, "<title>Compass publishing test article | Harbor Lane Plumbing</title>"), r, HASH, url, SRC), false, "the H1 as <title>");
});

test("site-push: the image is a content entry only beside the posts file, only in the recorded folder, content-addressed", () => {
  const paths = { adapter: "foundation_brand_content", brand: "showme", content_dir: "brands/showme/content", posts_file: "brands/showme/content/blog/compass-posts.ts",
    blog_route: "/blog/{slug}", blog_images: "public/blog/images" };
  const img = `public/blog/images/compass-publishing-test-${fileHash.slice(0, 12)}.webp`;
  assert.equal(validateContentEntry("foundation_brand_content", paths, [paths.posts_file, img]).ok, true);
  assert.equal(validateContentEntry("foundation_brand_content", paths, [paths.posts_file]).ok, true, "hero-less posts unchanged");
  assert.equal(validateContentEntry("foundation_brand_content", paths, [img]).ok, false, "never an image on its own");
  for (const bad of ["public/blog/images/compass-publishing-test.webp", "public/photos/x-0123456789ab.webp", "public/blog/images/sub/x-0123456789ab.webp",
    "public/blog/images/x-0123456789ab.svg", "public/blog/images/../x-0123456789ab.webp"]) {
    assert.equal(validateContentEntry("foundation_brand_content", paths, [paths.posts_file, bad]).ok, false, bad);
  }
  assert.equal(validateContentEntry("foundation_brand_content", { ...paths, blog_images: "public/blog/compass" }, [paths.posts_file, img]).ok, false, "only the recorded folder");
  const noPosts = { ...paths, posts_file: undefined };
  assert.equal(validateContentEntry("foundation_brand_content", noPosts, [img]).ok, false, "no posts contract, no exception");
  assertWriteAllowed("foundation_brand_content", img, "", paths);
  assert.throws(() => assertWriteAllowed("foundation_brand_content", img, "", noPosts), /outside/);
  assert.match(describeAdapter("foundation_brand_content", paths).writes.blog_post, /hero image in public\/blog\/images\//);
  const site = { branch: "claude/template-completion", stack: "nextjs", work_mode: "new_build", controlled_by_compass: true, vercel_project: "x",
    content_adapter: "foundation_brand_content", content_paths: paths };
  const plan = resolvePushPlan({ requestedBranch: site.branch, previewRequested: false, pullRequest: false, productionBranchHint: null, siteRow: site,
    repoDefaultBranch: "claude/show-me-electrical-careers-k6km12", repoEmpty: false, headAuthorName: "Tom", filePaths: [paths.posts_file, img] });
  assert.equal(plan.refuse, null);
  assert.equal(plan.grant, "content_entry");
  assert.equal(plan.branch, site.branch);
});

test("detection: an opted-in Foundation contract records the hero folder; one that did not opt in records none", () => {
  const tree = JSON.parse(fixture("foundation-blog-tree.json"));
  const contract = { ...HERO_CONTRACT, brand: "showme", posts_file: "brands/showme/content/blog/compass-posts.ts" };
  const d = detectContentContract(tree, { brand: "showme" }, { registeredBrands: ["showme", "harbor-lane"], compassBlog: contract });
  assert.equal(d.paths.posts_file, "brands/showme/content/blog/compass-posts.ts");
  assert.equal(d.paths.blog_images, "public/blog/images");
  assert.equal(detectContentContract(tree, { brand: "showme" }, { compassBlog: { ...contract, hero_image: false } }).paths.blog_images, undefined);
});
