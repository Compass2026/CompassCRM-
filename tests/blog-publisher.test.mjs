import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlogPublisher, verifyLiveArticle } from '../supabase/functions/blog-publisher/handler.ts';
import { buildBlogBrief } from "../supabase/functions/content-drafter/brief.ts";
import { lucas, OC, SITE } from './fixtures/drafter-lucas.mjs';
import { GOOD_BLOG, draftRow, DRAFT_ID } from './fixtures/blog-lucas.mjs';
const hash = 'sha256:'+'a'.repeat(64);
function harness(options={}) {
 const r={...draftRow(),...structuredClone(GOOD_BLOG),version:1,draft_id:DRAFT_ID,claims:[{id:OC}],
  destination:{site_id:'site',url:SITE,repo_url:'https://github.com/example/site',branch:'main',controlled_by_compass:true,content_adapter:'lucas_json',content_paths:{blog:'data/blog-posts.json',blog_route:'/blog/{slug}'}}};
 r.brief=buildBlogBrief(lucas(),draftRow()).brief;
 const calls=[];
 const deps={
  authorized:async()=>true, claim:async()=>({id:DRAFT_ID,lease_token:'token',status:'publishing',snapshot:r,release_hash:hash,scheduled_at:'2026-10-12T16:00:00Z'}),
  authorize:async()=>{calls.push('authorize');if(options.revoke)throw new Error('Approval changed');},
  finish:async(...args)=>calls.push(['finish',...args]),input:async()=>lucas(),pages:async()=>[],
  sitePush:async(body)=>{calls.push(body.read?'read':'push');if(body.read)return Response.json({head:'b'.repeat(40),repo_url:r.destination.repo_url,branch:'main',files:[
   {path:'compass-blog.json',content:JSON.stringify({version:1,adapter:'lucas_json',keyword_provenance:true,markdown:true,seo_fields:true})},
   {path:'data/blog-posts.json',content:'[]'}]});
   if(options.timeout)throw new Error('Network interrupted');
   return Response.json({commit_url:'https://github.com/example/site/commit/'+'c'.repeat(40),vercel:{ready_state:'READY',target:'production'}});},
  fetchLive:async()=>new Response('Not yet available',{status:404}),...options.deps};
 const run=()=>createBlogPublisher(deps)(new Request('https://test/publish',{method:'POST',body:JSON.stringify({publication_id:DRAFT_ID})}));
 return {r,calls,run};
}
test('authorization refuses before acquiring or writing publication',async()=>{
 const h=harness({deps:{authorized:async()=>false}});assert.equal((await h.run()).status,403);assert.deepEqual(h.calls,[]);
});
test('revocation immediately before commit blocks with no external write',async()=>{
 const h=harness({revoke:true});const r=await h.run();assert.equal((await r.json()).status,'blocked');
 assert.ok(h.calls.includes('authorize'));assert.ok(!h.calls.includes('push'));
});
test('ambiguous transport never becomes an automatic retry or false published result',async()=>{
 const h=harness({timeout:true});const r=await h.run();assert.equal((await r.json()).status,'uncertain');
 assert.equal(h.calls.filter(x=>x==='push').length,1);assert.equal(h.calls.at(-1)[3],'uncertain');
});
test('a successful deployment with missing live page remains uncertain',async()=>{
 const h=harness();assert.equal((await (await h.run()).json()).status,'uncertain');
 assert.equal(h.calls.at(-1)[3],'uncertain');
});
test('live verification requires release marker, canonical, exact H1, body and links',()=>{
 const r={h1:'Care for a roof',body_markdown:'## Inspect\n\nRead [our guide](https://example.test/guide).',internal_links:[{url:'https://example.test/guide'}]};
 const html=`<link rel="canonical" href="https://example.test/blog/roof"><article data-compass-release="${hash}"><h1>Care for a roof</h1><h2>Inspect</h2><p>Read <a href="https://example.test/guide">our guide</a>.</p></article>`;
 assert.equal(verifyLiveArticle(html,r,hash,'https://example.test/blog/roof'),true);
 assert.equal(verifyLiveArticle(html.replace('</a>.','</a> .'),r,hash,'https://example.test/blog/roof'),false);
 assert.equal(verifyLiveArticle(html.replace('our guide','another guide'),r,hash,'https://example.test/blog/roof'),false);
 assert.equal(verifyLiveArticle(html,r,'sha256:wrong','https://example.test/blog/roof'),false);
});


test('publisher carries the reviewed service and exact site through read and write',async()=>{
 const h=harness(); const seen=[];
 const run=createBlogPublisher({authorized:async()=>true,
  claim:async()=>({id:DRAFT_ID,lease_token:'token',status:'publishing',snapshot:h.r,release_hash:hash,scheduled_at:'2026-10-12T16:00:00Z'}),
  authorize:async()=>{},finish:async()=>{},
  input:async(client,service)=>{assert.equal(service,h.r.service_id);return lucas();},pages:async()=>[],
  sitePush:async(body)=>{seen.push(body);assert.equal(body.site_id,h.r.destination.site_id);
   if(body.read)return Response.json({head:'b'.repeat(40),repo_url:h.r.destination.repo_url,branch:'main',files:[
    {path:'compass-blog.json',content:JSON.stringify({version:1,adapter:'lucas_json',keyword_provenance:true,markdown:true,seo_fields:true})},
    {path:'data/blog-posts.json',content:'[]'}]});
   return Response.json({commit_url:'https://github.com/example/site/commit/'+'c'.repeat(40),vercel:{ready_state:'READY',target:'production'}});
  },fetchLive:async()=>new Response('',{status:404})});
 await run(new Request('https://test/publish',{method:'POST',body:JSON.stringify({publication_id:DRAFT_ID})}));
 assert.equal(seen.length,2);assert.equal(seen[0].site_id,seen[1].site_id);
});

test('live verification checks external body links even when absent from internal-link metadata',()=>{
 const url='https://example.test/blog/roof';
 const r={h1:'Roof guide',body_markdown:'Read [the source](https://source.example.test/research).',internal_links:[]};
 const html=`<link rel="canonical" href="${url}"><article data-compass-release="${hash}"><h1>Roof guide</h1><p>Read <a href="https://source.example.test/research">the source</a>.</p></article>`;
 assert.equal(verifyLiveArticle(html,r,hash,url),true);
 assert.equal(verifyLiveArticle(html.replace('https://source.example.test/research','https://other.example.test'),r,hash,url),false);
});
