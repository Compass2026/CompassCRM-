// Blog hero images (20261015210000): the publication contract, the live
// check, the publisher's hash check and the drafter's validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { preparePublication } from '../supabase/functions/content-drafter/publication.ts';
import { loadHero, verifyLiveArticle } from '../supabase/functions/blog-publisher/handler.ts';
import { heroProblems, parseHero } from '../supabase/functions/content-drafter/hero.ts';
import { parseBlogDraft } from '../supabase/functions/content-drafter/handler.ts';
import { validateContentEntry, detectContentContract } from '../src/lib/content-adapters.ts';
import { GOOD_BLOG } from './fixtures/blog-lucas.mjs';

const hash = 'sha256:' + 'a'.repeat(64);
const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const fileHash = createHash('sha256').update(bytes).digest('hex');
const hero = {
  asset_id: '2d897658-6dd0-4b0b-9180-1456219497e0', content_hash: fileHash, alt: 'Homeowner reviewing utility bills at a kitchen table',
  kind: 'social_post', illustrative: true, mime_type: 'image/png', width: 1730, height: 909, size_bytes: bytes.length,
  storage_path: 'client/upload/hero.png',
};
const release = {
  draft_id: 'a922bdfa-2adb-4a80-8fe2-c8f489beed00', client_id: 'client', version: 3, keyword_id: 'keyword',
  title: 'Solar consultation', slug: 'solar-consultation', meta_title: 'Solar Consultation', meta_description: 'What to gather.',
  h1: 'What to gather before a solar consultation', body_markdown: '## Bills\n\nBring [your bills](https://www.example.test/services/installation).',
  cta: { text: 'Get a quote', url: 'https://www.example.test/contact' }, internal_links: [],
  destination: { site_id: 'site', url: 'https://www.example.test', repo_url: 'https://github.com/example/site', branch: 'main',
    content_adapter: 'json_blog', content_paths: { blog: 'data/blog-posts.json', blog_route: '/blog/{slug}/' }, controlled_by_compass: true },
  hero,
};
const v1 = { version: 1, adapter: 'json_blog', keyword_provenance: true, markdown: true, seo_fields: true };
const heroContract = { ...v1, hero_image: true, hero_image_dir: 'public/blog/images', hero_image_url_prefix: '/blog/images/' };
const read = (contract = heroContract, extra = []) => ({ head: 'b'.repeat(40), repo_url: release.destination.repo_url, branch: 'main', files: [
  { path: 'compass-blog.json', content: JSON.stringify(contract) }, { path: 'data/blog-posts.json', content: '[]' }, ...extra] });
const b64 = { base64: Buffer.from(bytes).toString('base64') };
const imagePath = `public/blog/images/solar-consultation-${fileHash.slice(0, 12)}.png`;

test('a hero article commits its image with the article and carries heroImage', () => {
  const out = preparePublication(release, hash, read(), '2026-10-15', b64);
  assert.equal(out.url, 'https://www.example.test/blog/solar-consultation/');
  assert.deepEqual(out.files.map((f) => f.path), ['data/blog-posts.json', imagePath]);
  assert.equal(out.files[1].encoding, 'base64');
  assert.equal(out.files[1].content, b64.base64);
  const [article] = JSON.parse(out.files[0].content);
  assert.deepEqual(article.heroImage, { src: `/blog/images/solar-consultation-${fileHash.slice(0, 12)}.png`,
    alt: hero.alt, width: 1730, height: 909, illustrative: true });
  assert.equal(out.hero_src, article.heroImage.src);
  assert.deepEqual(validateContentEntry('json_blog', release.destination.content_paths, out.files.map((f) => f.path)).ok, true,
    'site-push accepts the image as part of the blog entry');
  assert.equal(validateContentEntry('json_blog', release.destination.content_paths, ['public/blog/images/../x.png']).ok, false);
  assert.equal(validateContentEntry('json_blog', release.destination.content_paths, ['public/logo.png']).ok, false);
});

test('an article without a hero publishes exactly as before (no heroImage, no image file)', () => {
  const out = preparePublication({ ...release, hero: undefined }, hash, read(v1), '2026-10-15');
  assert.equal(out.files.length, 1);
  assert.equal(JSON.parse(out.files[0].content)[0].heroImage, undefined);
  assert.equal(out.hero_src, null);
});

test('an older site contract refuses a hero article instead of dropping the image', () => {
  assert.throws(() => preparePublication(release, hash, read(v1), '2026-10-15', b64), /hero image upgrade/);
  assert.throws(() => preparePublication(release, hash, read({ ...heroContract, hero_image_dir: 'public/other' }), '2026-10-15', b64), /folder does not match/);
  assert.throws(() => preparePublication(release, hash, read({ ...heroContract, hero_image_url_prefix: 'https://cdn/' }), '2026-10-15', b64), /URL prefix/);
  // A Markdown blog that has not opted in refuses exactly like a JSON blog (Nov 2026).
  assert.throws(() => preparePublication({ ...release, destination: { ...release.destination, content_adapter: 'markdown_blog',
    content_paths: { blog_dir: 'content/blog', blog_route: '/blog/{slug}' } } }, hash,
    { ...read({ ...v1, adapter: 'markdown_blog' }), files: [{ path: 'compass-blog.json', content: JSON.stringify({ ...v1, adapter: 'markdown_blog' }) }] },
    '2026-10-15', b64), /hero image upgrade/);
  assert.throws(() => preparePublication(release, hash, read(), '2026-10-15'), /could not be loaded/);
  assert.throws(() => preparePublication({ ...release, hero: { ...hero, alt: ' ' } }, hash, read(), '2026-10-15', b64), /alt text/);
});

test('retries reconcile the committed image; a different file at the path refuses', () => {
  const first = preparePublication(release, hash, read(), '2026-10-15', b64);
  const committed = read(heroContract, [{ path: imagePath, size: bytes.length }]);
  committed.files[1] = first.files[0];
  assert.equal(preparePublication(release, hash, committed, '2026-10-15').already_present, true);
  const imageOnly = read(heroContract, [{ path: imagePath, size: bytes.length }]);
  assert.deepEqual(preparePublication(release, hash, imageOnly, '2026-10-15').files.map((f) => f.path), ['data/blog-posts.json']);
  assert.throws(() => preparePublication(release, hash, read(heroContract, [{ path: imagePath, size: 99 }]), '2026-10-15', b64), /different file/);
  const lost = read(); lost.files[1] = first.files[0];
  assert.throws(() => preparePublication(release, hash, lost, '2026-10-15', b64), /hero image is missing/);
});

test('live verification requires the approved hero with its alt text', () => {
  const src = `/blog/images/solar-consultation-${fileHash.slice(0, 12)}.png`;
  const url = 'https://www.example.test/blog/solar-consultation/';
  const page = (img) => `<link rel="canonical" href="${url}"><article data-compass-release="${hash}"><h1>${release.h1}</h1>${img}<h2>Bills</h2><p>Bring <a href="https://www.example.test/services/installation">your bills</a>.</p></article>`;
  const good = page(`<picture><source type="image/webp" srcset="${src.replace('.png', '-640.webp')} 640w"><img src="${src}" alt="${hero.alt}" width="1730" height="909"></picture>`);
  assert.equal(verifyLiveArticle(good, release, hash, url, src), true);
  assert.equal(verifyLiveArticle(good.replace(`src="${src}"`, `src="https://www.example.test${src}"`), release, hash, url, src), true);
  assert.equal(verifyLiveArticle(page(`<img src="${src}" alt="Something else">`), release, hash, url, src), false);
  assert.equal(verifyLiveArticle(page(''), release, hash, url, src), false);
  assert.equal(verifyLiveArticle(good, release, hash, url, null), false);
  assert.equal(verifyLiveArticle(page(''), { ...release, hero: undefined }, hash, url), true);
});

test('the publisher loads only the exact approved file', async () => {
  assert.equal(await loadHero({}, { ...release, hero: null }), undefined);
  assert.deepEqual(await loadHero({ heroImage: async () => bytes }, release), b64);
  await assert.rejects(loadHero({ heroImage: async () => new Uint8Array([1]) }, release), /changed since approval/);
  await assert.rejects(loadHero({}, release), /could not be loaded/);
});

test('the drafter validates a proposed hero: format, same client, kind, stored and hashed', () => {
  const id = '2d897658-6dd0-4b0b-9180-1456219497e0';
  assert.equal(parseHero({}), null);
  assert.deepEqual(parseHero({ hero_asset_id: id, hero_alt: '  A roof  ' }), { asset_id: id, alt: 'A roof' });
  assert.match(parseHero({ hero_asset_id: 'x', hero_alt: 'A' }), /uuid/);
  assert.match(parseHero({ hero_asset_id: id }), /hero_alt/);
  assert.match(parseHero({ hero_asset_id: id, hero_alt: 'x'.repeat(251) }), /250/);
  assert.deepEqual(parseBlogDraft({ ...GOOD_BLOG, hero_asset_id: id, hero_alt: 'A roof' }).hero, { asset_id: id, alt: 'A roof' });
  assert.equal(parseBlogDraft(GOOD_BLOG).hero, undefined);
  assert.match(parseBlogDraft({ ...GOOD_BLOG, hero_asset_id: id }), /hero_alt/);
  const asset = { id, client_id: 'c', kind: 'social_post', storage_path: 'p', content_hash: 'h', mime_type: 'image/png', width: 10, height: 10 };
  assert.deepEqual(heroProblems(asset, 'c'), []);
  assert.match(heroProblems(asset, 'other')[0], /this client/);
  assert.match(heroProblems(null, 'c')[0], /this client/);
  assert.match(heroProblems({ ...asset, kind: 'logo_primary' }, 'c').join(' '), /photo or a social graphic/);
  assert.match(heroProblems({ ...asset, content_hash: null }, 'c').join(' '), /stored, hashed/);
  assert.match(heroProblems({ ...asset, mime_type: 'image/gif' }, 'c').join(' '), /PNG/);
});

test('the json_blog detector accepts a prerender.js pipeline as well as prerender.mjs', () => {
  const tree = ['compass-blog.json', 'data/blog-posts.json', 'src/content/compass-blog.ts', 'src/routing.ts'];
  assert.equal(detectContentContract([...tree, 'scripts/prerender.js']).adapter, 'json_blog');
  assert.equal(detectContentContract([...tree, 'scripts/prerender.mjs']).adapter, 'json_blog');
  assert.notEqual(detectContentContract(tree).adapter, 'json_blog');
});

test('the drafter refuses an ineligible hero before writing and submits a good one with the content', async () => {
  const { createContentDrafter } = await import('../supabase/functions/content-drafter/handler.ts');
  const { lucas, GAZETTEER } = await import('./fixtures/drafter-lucas.mjs');
  const { draftRow, DRAFT_ID } = await import('./fixtures/blog-lucas.mjs');
  const clientId = lucas().client.id;
  const assets = {
    good: { id: '2d897658-6dd0-4b0b-9180-1456219497e0', client_id: clientId, kind: 'social_post', storage_path: 'p', content_hash: 'h', mime_type: 'image/png', width: 1730, height: 909 },
    other: { id: '3d897658-6dd0-4b0b-9180-1456219497e0', client_id: '00000000-0000-4000-8000-0000000000ff', kind: 'photo', storage_path: 'p', content_hash: 'h', mime_type: 'image/jpeg', width: 9, height: 9 },
  };
  const writes = [];
  const store = {
    async secret(n) { return n === 'SYNC_CRON_SECRET' ? 'cron' : null; },
    async teamMemberForJwt() { return null; },
    async draft(id) { return id === DRAFT_ID ? draftRow() : null; },
    async input() { return lucas(); }, async sitePages() { return []; },
    async claimHolder() { return null; },
    async heroAsset(id) { return Object.values(assets).find((a) => a.id === id) ?? null; },
    async write(p) { writes.push(p); return { draft_id: p.draft_id, status: 'in_review', version: 2, word_count: 820 }; },
  };
  const fn = createContentDrafter({ store, gazetteer: { MO: GAZETTEER } });
  const call = async (body) => { const r = await fn.handle(new Request('http://x', { method: 'POST', headers: { 'x-cron-secret': 'cron' }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; };
  const { body: { brief_hash } } = await call({ mode: 'brief', draft_id: DRAFT_ID });
  const submit = (hero) => call({ mode: 'submit', draft_id: DRAFT_ID, brief_hash, runtime: 'test', draft: { ...GOOD_BLOG, ...hero } });
  const refused = await submit({ hero_asset_id: assets.other.id, hero_alt: 'A roof' });
  assert.equal(refused.status, 422);
  assert.match(refused.body.message, /this client/);
  assert.equal((await submit({ hero_asset_id: assets.good.id })).status, 400);
  assert.equal(writes.length, 0, 'nothing is written for a refused hero');
  const ok = await submit({ hero_asset_id: assets.good.id, hero_alt: 'Homeowner reviewing bills' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(writes[0].content.hero, { asset_id: assets.good.id, alt: 'Homeowner reviewing bills' });
  assert.equal((await submit({})).status, 201);
  assert.equal(writes[1].content.hero, undefined, 'a hero-less submit is unchanged');
});

// ── Markdown blog (BHG shape, Nov 2026) ─────────────────────────────────────
// The same hero, carried in the post's front matter instead of heroImage, with
// the same content-addressed file in the same commit.
const mdRelease = { ...release, destination: { ...release.destination, url: 'https://www.example.test/', content_adapter: 'markdown_blog',
  content_paths: { adapter: 'markdown_blog', blog_dir: 'content/blog', blog_route: '/blog/{slug}', blog_format: 'markdown' } } };
const mdV1 = { version: 1, adapter: 'markdown_blog', keyword_provenance: true, markdown: true, seo_fields: true };
const mdHero = { ...mdV1, hero_image: true, hero_image_dir: 'public/blog/images', hero_image_url_prefix: '/blog/images/' };
const mdRead = (contract = mdHero, extra = []) => ({ head: 'b'.repeat(40), repo_url: release.destination.repo_url, branch: 'main', files: [
  { path: 'compass-blog.json', content: JSON.stringify(contract) }, { path: 'content/blog/other-post.mdx', size: 900 }, ...extra] });
const mdPost = 'content/blog/solar-consultation.mdx';
const mdSrc = `/blog/images/solar-consultation-${fileHash.slice(0, 12)}.png`;
// Exactly what the Markdown adapter wrote before heroes existed (pinned bytes).
const HEROLESS_MDX = ['---', 'title: "Solar consultation"', 'meta_title: "Solar Consultation"', 'h1: "What to gather before a solar consultation"',
  'date: "2026-10-15"', 'excerpt: "What to gather."', 'compass_draft_id: "a922bdfa-2adb-4a80-8fe2-c8f489beed00"', `compass_release_hash: "${hash}"`,
  'keyword_id: "keyword"', '---', '', '## Bills', '', 'Bring [your bills](https://www.example.test/services/installation).', '',
  '[Get a quote](https://www.example.test/contact)', ''].join('\n');

test('markdown: a hero article commits its image with the post and writes the hero into the front matter', () => {
  const out = preparePublication(mdRelease, hash, mdRead(), '2026-10-15', b64);
  assert.equal(out.url, 'https://www.example.test/blog/solar-consultation');
  assert.deepEqual(out.files.map((f) => f.path), [mdPost, imagePath]);
  assert.equal(out.files[1].encoding, 'base64');
  assert.equal(out.files[1].content, b64.base64);
  assert.equal(out.hero_src, mdSrc);
  const front = ['hero_image:', `  src: "${mdSrc}"`, `  alt: "${hero.alt}"`, '  width: 1730', '  height: 909', '  illustrative: true'].join('\n');
  assert.equal(out.files[0].content, HEROLESS_MDX.replace('keyword_id: "keyword"\n---', `keyword_id: "keyword"\n${front}\n---`),
    'the hero block sits after the provenance keys; nothing else changes');
  assert.ok(!/Illustrat/i.test(out.files[0].content.split('---')[2]), 'no visible caption is added to the body');
  const photo = preparePublication({ ...mdRelease, hero: { ...hero, kind: 'photo', illustrative: false, alt: 'Crew "on site": inspection' } }, hash, mdRead(), '2026-10-15', b64);
  assert.match(photo.files[0].content, /\n {2}alt: "Crew \\"on site\\": inspection"\n {2}width: 1730\n {2}height: 909\n {2}illustrative: false\n---\n/);
  const paths = mdRelease.destination.content_paths;
  assert.equal(validateContentEntry('markdown_blog', paths, out.files.map((f) => f.path)).ok, true, 'site-push accepts the image as part of the post');
  assert.equal(validateContentEntry('markdown_blog', paths, [imagePath]).ok, false, 'never an image on its own');
  assert.equal(validateContentEntry('markdown_blog', paths, ['content/blog/another-post.mdx', imagePath]).ok, false, 'never beside a different post');
  assert.equal(validateContentEntry('markdown_blog', paths, [mdPost, 'public/blog/images/../x.png']).ok, false);
  assert.equal(validateContentEntry('markdown_blog', paths, [mdPost, 'public/logo.png']).ok, false);
  assert.equal(validateContentEntry('markdown_blog', paths, [mdPost, 'public/blog/images/solar-consultation.png']).ok, false, 'content-addressed names only');
  assert.equal(validateContentEntry('markdown_blog', { ...paths, blog_images: 'public/img/blog' }, [mdPost, imagePath]).ok, false, 'only the recorded folder');
});

test('markdown: an article without a hero publishes byte-for-byte as before, opted in or not', () => {
  for (const contract of [mdV1, mdHero]) {
    const out = preparePublication({ ...mdRelease, hero: undefined }, hash, mdRead(contract), '2026-10-15');
    assert.deepEqual(out.files, [{ path: mdPost, content: HEROLESS_MDX }]);
    assert.equal(out.hero_src, null);
  }
});

test('markdown: a site that did not opt in, or opted in wrongly, refuses the hero article', () => {
  assert.throws(() => preparePublication(mdRelease, hash, mdRead(mdV1), '2026-10-15', b64), /hero image upgrade/);
  assert.throws(() => preparePublication(mdRelease, hash, mdRead({ ...mdHero, hero_image: 'yes' }), '2026-10-15', b64), /hero image upgrade/);
  assert.throws(() => preparePublication(mdRelease, hash, mdRead({ ...mdHero, hero_image_dir: 'public/other' }), '2026-10-15', b64), /folder does not match/);
  assert.throws(() => preparePublication(mdRelease, hash, mdRead({ ...mdHero, hero_image_url_prefix: 'https://cdn/' }), '2026-10-15', b64), /URL prefix/);
  assert.throws(() => preparePublication(mdRelease, hash, mdRead(), '2026-10-15'), /could not be loaded/);
  assert.throws(() => preparePublication({ ...mdRelease, hero: { ...hero, alt: ' ' } }, hash, mdRead(), '2026-10-15', b64), /alt text/);
  assert.throws(() => preparePublication({ ...mdRelease, hero: { ...hero, alt: 'Two\nlines' } }, hash, mdRead(), '2026-10-15', b64), /alt text requires manual review/);
  assert.throws(() => preparePublication({ ...mdRelease, hero: { ...hero, mime_type: 'image/gif' } }, hash, mdRead(), '2026-10-15', b64), /PNG, JPEG or WebP/);
  assert.throws(() => preparePublication({ ...mdRelease, hero: { ...hero, width: 0 } }, hash, mdRead(), '2026-10-15', b64), /dimensions/);
  // The summary must sit above the hero, and a Markdown post has no TL;DR slot.
  assert.throws(() => preparePublication({ ...mdRelease, tldr: 'Bring a year of bills.' }, hash, mdRead(), '2026-10-15', b64), /TL;DR upgrade/);
  // The recorded folder may be another one, as long as the site says the same.
  const custom = { ...mdRelease, destination: { ...mdRelease.destination, content_paths: { ...mdRelease.destination.content_paths, blog_images: 'public/img/blog' } } };
  const out = preparePublication(custom, hash, mdRead({ ...mdHero, hero_image_dir: 'public/img/blog', hero_image_url_prefix: '/img/blog/' }), '2026-10-15', b64);
  assert.equal(out.files[1].path, `public/img/blog/solar-consultation-${fileHash.slice(0, 12)}.png`);
  assert.equal(out.hero_src, `/img/blog/solar-consultation-${fileHash.slice(0, 12)}.png`);
});

test('markdown: expected head, retries and collisions behave as on JSON blogs', () => {
  const first = preparePublication(mdRelease, hash, mdRead(), '2026-10-15', b64);
  assert.equal(first.expected_head, 'b'.repeat(40), 'the push names the head it read');
  assert.throws(() => preparePublication(mdRelease, hash, { ...mdRead(), head: '' }, '2026-10-15', b64), /head is missing/);
  assert.throws(() => preparePublication(mdRelease, 'sha256:short', mdRead(), '2026-10-15', b64), /released keyword-backed/);
  // Post and image both committed: already present, nothing to write.
  const done = mdRead(mdHero, [first.files[0], { path: imagePath, size: bytes.length }]);
  const again = preparePublication(mdRelease, hash, done, '2026-10-15');
  assert.equal(again.already_present, true);
  assert.equal(again.hero_src, mdSrc, 'reconciliation still verifies the image on the live page');
  // Image committed, post not: only the post is written.
  assert.deepEqual(preparePublication(mdRelease, hash, mdRead(mdHero, [{ path: imagePath, size: bytes.length }]), '2026-10-15').files.map((f) => f.path), [mdPost]);
  // A different file at the content-addressed path refuses.
  assert.throws(() => preparePublication(mdRelease, hash, mdRead(mdHero, [{ path: imagePath, size: 99 }]), '2026-10-15', b64), /different file/);
  // The post is there but its image is gone.
  assert.throws(() => preparePublication(mdRelease, hash, mdRead(mdHero, [first.files[0]]), '2026-10-15', b64), /hero image is missing/);
  // Same slug, different content (another release, or the hero-less version).
  const heroless = preparePublication({ ...mdRelease, hero: undefined }, hash, mdRead(), '2026-10-15').files[0];
  assert.throws(() => preparePublication(mdRelease, hash, mdRead(mdHero, [heroless]), '2026-10-15', b64), /already exists/);
});

test('markdown: live verification requires the approved hero with its alt text', () => {
  const url = 'https://www.example.test/blog/solar-consultation';
  const page = (img) => `<link rel="canonical" href="${url}"><div data-compass-release="${hash}"><h1>${release.h1}</h1>${img}<article><h2>Bills</h2><p>Bring <a href="https://www.example.test/services/installation">your bills</a>.</p></article></div>`;
  const good = page(`<img alt="${hero.alt}" width="1730" height="909" decoding="async" src="${mdSrc}">`);
  assert.equal(verifyLiveArticle(good, mdRelease, hash, url, mdSrc), true);
  assert.equal(verifyLiveArticle(page(`<img src="${mdSrc}" alt="Something else">`), mdRelease, hash, url, mdSrc), false);
  assert.equal(verifyLiveArticle(page(`<img src="/blog/images/other.png" alt="${hero.alt}">`), mdRelease, hash, url, mdSrc), false);
  assert.equal(verifyLiveArticle(page(''), mdRelease, hash, url, mdSrc), false);
  assert.equal(verifyLiveArticle(page(''), { ...mdRelease, hero: undefined }, hash, url), true);
});

test('the publisher sends a Markdown hero post and its image in one push at the head it read, then requires the image live', async () => {
  const { createBlogPublisher } = await import('../supabase/functions/blog-publisher/handler.ts');
  const { buildBlogBrief } = await import('../supabase/functions/content-drafter/brief.ts');
  const { lucas, OC, SITE } = await import('./fixtures/drafter-lucas.mjs');
  const { draftRow, DRAFT_ID } = await import('./fixtures/blog-lucas.mjs');
  // A release approved before the TL;DR rule (no summary): a Markdown post has
  // no TL;DR slot, and the summary would otherwise sit under the hero.
  const r = { ...draftRow(), ...structuredClone(GOOD_BLOG), version: 1, draft_id: DRAFT_ID, claims: [{ id: OC }], hero,
    destination: { site_id: 'site', url: SITE, repo_url: 'https://github.com/example/site', branch: 'main', controlled_by_compass: true,
      content_adapter: 'markdown_blog', content_paths: { adapter: 'markdown_blog', blog_dir: 'content/blog', blog_route: '/blog/{slug}', blog_format: 'markdown' } } };
  r.brief = buildBlogBrief(lucas(), draftRow()).brief;
  delete r.brief.tldr; delete r.tldr; delete r.id;
  const post = `content/blog/${r.slug}.mdx`;
  const image = `public/blog/images/${r.slug}-${fileHash.slice(0, 12)}.png`;
  const src = `/blog/images/${r.slug}-${fileHash.slice(0, 12)}.png`;
  const url = new URL(`/blog/${r.slug}`, SITE).href;
  const pushes = [];
  const finishes = [];
  const render = (img) => {
    const lines = r.body_markdown.split(/\n+/).filter(Boolean).map((l) => `<p>${l.replace(/^#+\s*|^\s*(?:-|\d+\.)\s+/, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>').replace(/[*_`]/g, '')}</p>`).join('');
    return `<link rel="canonical" href="${url}"><div data-compass-release="${hash}"><h1>${r.h1}</h1>${img}<article>${lines}</article></div>`;
  };
  let live = render(`<img src="${src}" alt="${hero.alt}" width="${hero.width}" height="${hero.height}">`);
  const deps = {
    authorized: async () => true,
    claim: async () => ({ id: DRAFT_ID, lease_token: 'token', status: 'publishing', snapshot: r, release_hash: hash, scheduled_at: '2026-10-15T16:00:00Z' }),
    resume: async () => { throw new Error('unused'); }, authorize: async () => {}, finish: async (...a) => { finishes.push(a); },
    input: async () => lucas(), pages: async () => [], heroImage: async () => bytes,
    sitePush: async (b) => {
      if (b.read) return Response.json({ head: 'b'.repeat(40), repo_url: r.destination.repo_url, branch: 'main', files: [{ path: 'compass-blog.json', content: JSON.stringify(mdHero) }] });
      pushes.push(b);
      return Response.json({ commit_url: `https://github.com/example/site/commit/${'c'.repeat(40)}`, vercel: { ready_state: 'READY', target: 'production' } });
    },
    fetchLive: async () => new Response(live),
  };
  const run = () => createBlogPublisher(deps)(new Request('https://test/publish', { method: 'POST', body: JSON.stringify({ publication_id: DRAFT_ID }) }));
  const ok = await (await run()).json();
  assert.equal(ok.status, 'published', JSON.stringify(ok));
  assert.equal(pushes.length, 1, 'one push, one commit');
  assert.equal(pushes[0].expected_head, 'b'.repeat(40));
  assert.equal(pushes[0].branch, 'main');
  assert.deepEqual(pushes[0].files.map((f) => [f.path, f.encoding ?? 'utf-8']), [[post, 'utf-8'], [image, 'base64']]);
  assert.match(pushes[0].files[0].content, new RegExp(`\\nhero_image:\\n  src: "${src}"\\n  alt: "${hero.alt}"\\n  width: 1730\\n  height: 909\\n  illustrative: true\\n---\\n`));
  assert.equal(validateContentEntry('markdown_blog', r.destination.content_paths, pushes[0].files.map((f) => f.path)).ok, true);
  // Without the image on the live page the release is not confirmed.
  live = render('');
  assert.equal((await (await run()).json()).status, 'uncertain');
  // A replaced file in storage is refused before anything is written.
  pushes.length = 0;
  deps.heroImage = async () => new Uint8Array([1, 2, 3]);
  const changed = await (await run()).json();
  assert.equal(changed.status, 'blocked');
  assert.match(changed.error, /changed since approval/);
  assert.equal(pushes.length, 0);
});
