import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePublication, publicationUrl, validatePublishableMarkdown } from '../supabase/functions/content-drafter/publication.ts';
const hash = 'sha256:' + 'a'.repeat(64);
const release = {
  draft_id: 'draft', client_id: 'client', version: 1, keyword_id: 'keyword',
  title: 'Roof care', slug: 'roof-care', meta_title: 'Roof Care Guide', meta_description: 'Care for a roof.',
  h1: 'How to care for your roof', body_markdown: '## Inspection\n\nSee [roof repair](https://example.test/repair).',
  cta: { text: 'Request a quote', url: 'https://example.test/contact' }, internal_links: [],
  destination: { site_id: 'site', url: 'https://example.test', repo_url: 'https://github.com/example/site', branch: 'main',
    content_adapter: 'lucas_json', content_paths: { blog: 'data/blog-posts.json', blog_route: '/blog/{slug}' }, controlled_by_compass: true },
};
function read(r = release) {
 return { head: 'b'.repeat(40), repo_url: r.destination.repo_url, branch: 'main', files: [
  { path: 'compass-blog.json', content: JSON.stringify({version: 1, adapter: r.destination.content_adapter, keyword_provenance: true, markdown: true, seo_fields: true}) },
  ...(r.destination.content_adapter === 'lucas_json' ? [{path: 'data/blog-posts.json', content: '[{"slug":"old","blocks":[{"type":"p","text":"Original"}]}]'}] : []),
 ] };
}
test('JSON delivery preserves original posts, approved Markdown, links, H1 and SEO', () => {
 const result = preparePublication(release, hash, read(), '2026-10-12');
 const rows = JSON.parse(result.files[0].content);
 assert.deepEqual(rows[0], {slug:'old',blocks:[{type:'p',text:'Original'}]});
 assert.equal(rows[1].bodyMarkdown, release.body_markdown);
 assert.equal(rows[1].h1, release.h1); assert.equal(rows[1].metaTitle, release.meta_title);
 assert.equal(rows[1].compass.keyword_id, release.keyword_id);
 assert.equal(result.expected_head, 'b'.repeat(40));
 assert.equal(result.url, 'https://example.test/blog/roof-care');
});
test('exact retry reconciles existing content; slug collision and changed content refuse', () => {
 const repo = read(); const result = preparePublication(release, hash, repo, '2026-10-12');
 repo.files[1] = result.files[0];
 assert.equal(preparePublication(release, hash, repo, '2026-10-12').already_present, true);
 assert.throws(() => preparePublication({...release, title:'Changed'}, hash, repo, '2026-10-12'), /already exists/);
 assert.throws(() => preparePublication({...release, slug:'old'}, hash, read(), '2026-10-12'), /already exists/);
});
test('old renderer, unreadable JSON and changed destination cannot silently lose content', () => {
 const repo = read(); repo.files.shift();
 assert.throws(() => preparePublication(release, hash, repo, '2026-10-12'), /renderer upgrade/);
 assert.throws(() => preparePublication(release, hash, {...read(), branch:'other'}, '2026-10-12'), /destination changed/);
 const bad = read(); delete bad.files[1].content;
 assert.throws(() => preparePublication(release, hash, bad, '2026-10-12'), /no overwrite/);
});
test('Markdown adapter preserves SEO and provenance, and detects retry versus collision', () => {
 const r = {...release, destination:{...release.destination, content_adapter:'markdown_blog',content_paths:{blog_dir:'content/blog',blog_route:'/blog/{slug}'}}};
 const repo = read(r); const result = preparePublication(r, hash, repo, '2026-10-12');
 assert.equal(result.files[0].path, 'content/blog/roof-care.mdx');
 assert.ok(result.files[0].content.includes('meta_title: "Roof Care Guide"'));
 assert.ok(result.files[0].content.includes(release.body_markdown));
 repo.files.push(result.files[0]);
 assert.equal(preparePublication(r, hash, repo, '2026-10-12').already_present, true);
 assert.throws(() => preparePublication({...r, body_markdown:'Changed'}, hash, repo, '2026-10-12'), /already exists/);
});
test('MDX execution, bad routes, unsafe paths and protocols refuse before any write', () => {
 for (const body of ['import fs from "fs"', '{process.env.SECRET}', '<script>x</script>', '[x](javascript:alert)'])
  assert.throws(() => validatePublishableMarkdown(body));
 assert.throws(() => publicationUrl({...release, slug:'../bad'}));
 assert.throws(() => preparePublication({...release, destination:{...release.destination,content_paths:{...release.destination.content_paths,blog:'../secrets'}}},hash,read(),'2026-10-12'));
});

test('standalone JSON blog preserves approved data and a trailing-slash canonical', () => {
 const r = {...release, destination:{...release.destination, content_adapter:'json_blog',content_paths:{blog:'data/blog-posts.json',blog_route:'/{slug}/'}}};
 const repo = read(r); repo.files.push({path:'data/blog-posts.json',content:'[]'});
 const result = preparePublication(r,hash,repo,'2026-10-12');
 assert.equal(result.url,'https://example.test/roof-care/');
 const article=JSON.parse(result.files[0].content)[0];
 assert.equal(article.bodyMarkdown,release.body_markdown);
 assert.deepEqual(article.cta,release.cta);
 assert.equal(article.compass.keyword_id,release.keyword_id);
});
