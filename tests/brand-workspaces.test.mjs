import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceGate, workspaceAccounts } from '../supabase/functions/post-drafter/workspace.ts';
import { buildBrief } from '../supabase/functions/post-drafter/brief.ts';
import { buildBlogBrief, blogBriefHash } from '../supabase/functions/content-drafter/brief.ts';
import { lucas, TARGET } from './fixtures/drafter-lucas.mjs';
import { draftRow } from './fixtures/blog-lucas.mjs';
test('legacy briefs and account selection are unchanged; brand version binds both draft types',async()=>{
 const i=lucas(), accounts=[{id:'safety'},{id:'forklift'}];
 assert.deepEqual(workspaceGate(i),{});assert.deepEqual(workspaceAccounts(i,accounts),accounts);
 const old=buildBlogBrief(i,draftRow()); assert.equal(old.ok,true);
 i.workspace={id:'brand-safety',version:3,facebook_account_id:'safety'};
 const blog=buildBlogBrief(i,draftRow());assert.equal(blog.ok,true);
 assert.equal(blog.brief.gate.brand_workspace_id,'brand-safety');
 assert.equal(blog.brief.gate.brand_workspace_version,'3');
 assert.notEqual(await blogBriefHash(old.brief),await blogBriefHash(blog.brief));
 const post=buildBrief(i,TARGET);assert.equal(post.ok,true);
 assert.equal(post.brief.gate.brand_workspace_id,'brand-safety');
 assert.deepEqual(workspaceAccounts(i,accounts),[{id:'safety'}]);
 i.workspace.facebook_account_id=null;assert.deepEqual(workspaceAccounts(i,accounts),[]);
});
test('a keyword from a sibling brand is refused even when the client account is shared',()=>{
 const i=lucas(); i.workspace={id:'forklift',version:1,facebook_account_id:null};i.keywords=[];
 assert.equal(buildBrief(i,TARGET).ok,false);
 assert.equal(buildBlogBrief(i,draftRow()).ok,false);
});
