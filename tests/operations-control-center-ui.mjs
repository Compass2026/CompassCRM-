// Actual Next.js route against a read-only synthetic PostgREST boundary.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002',team='00000000-0000-4000-8000-000000000011';
const now=new Date(),recent=new Date(now.getTime()-3600000).toISOString(),through=new Date(now.getTime()-5*86400000).toISOString().slice(0,10),period=through.slice(0,7)+'-01';
const clients=[{id:a,name:'Fictional North',status:'active',gsc_property:'sc-domain:north.test',ga4_property:'properties/123'},{id:b,name:'Fictional South',status:'active',gsc_property:null,ga4_property:'properties/456'}];
const receipt={id:'r1',client_id:a,property:'properties/123',period,period_end:through,created_at:recent};
const run={id:'run1',client_id:a,created_at:recent,finished_at:recent,status:'completed',results:[{month:period,status:'imported',receipt_id:'r1'}]};
let ga4Failure=false,truncated=false,rolloutFailure=false;const writes=[],requests=[];
const rows={agency_rollout_reviews:[],client_growth_rankings:[],rank_runs:[],backlink_checks:[],backlink_profile_sync_runs:[],social_posts:[{client_id:a,id:'social-review',platform:'facebook',review_status:'in_review',publish_status:'not_scheduled'}],billing_reconciliation_results:[],services:[],claims:[],authority_latest:[],clients,keywords:[{client_id:a,is_active:true,is_tracked:true}],sites:[],report_measurements:[],content_drafts:[{id:'review1',client_id:a,status:'in_review',title:'Review this fictional article',topic:null,request_task_id:'task',created_at:recent}],blog_publications:[],crm_lite_settings:[],notification_jobs:[],backlink_opportunities:[],social_accounts:[],subscriptions:[],portal_users:[],client_brand_workspaces:[],brand_boards:[],inquiry_sources:[],gsc_performance_imports:[],gbp_performance_imports:[],gsc_performance_sync_runs:[],gbp_performance_sync_runs:[],ga4_performance_imports:[receipt],ga4_performance_sync_runs:[run,{...run,id:'run2',client_id:b,results:[]}]};
const upstream=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');requests.push(url.pathname);
 const reply=(body,status=200,count)=>{res.writeHead(status,{'content-type':'application/json',...(count!==undefined?{'content-range':`0-${Math.max(0,count-1)}/${count}`}:{})});res.end(JSON.stringify(body));};
 if(req.method==='POST'&&url.pathname==='/rest/v1/agency_rollout_reviews'){
  let body='';for await(const chunk of req)body+=chunk;const row=JSON.parse(body);
  writes.push(req.method+' '+url.pathname);rows.agency_rollout_reviews.push({...row,id:'review-'+row.version,reviewed_by:team,reviewed_at:new Date().toISOString()});return reply(null,201);
 }
 if(req.method!=='GET'){writes.push(req.method+' '+url.pathname);return reply({message:'No writes allowed'},405);}
 if(url.pathname==='/auth/v1/user')return reply({id:team,email:'team@example.test',aud:'authenticated',role:'authenticated'});
 if(url.pathname==='/rest/v1/team_members')return reply({id:team});
 const table=url.pathname.split('/').at(-1);
 if(!(table in rows))return reply({message:'Unexpected table '+table},500);
 if(ga4Failure&&table==='ga4_performance_imports')return reply({message:'Simulated unavailable source'},503);
 if(rolloutFailure&&table==='agency_rollout_reviews')return reply({message:'Review ledger unavailable'},503);
 let data=rows[table];
 if(table==='agency_rollout_reviews'){
  if(url.searchParams.get('client_id')?.startsWith('eq.'))data=data.filter(r=>r.client_id===url.searchParams.get('client_id').slice(3));
  if(url.searchParams.get('brand_workspace_id')==='is.null')data=data.filter(r=>r.brand_workspace_id===null);
  data=data.toSorted((a,b)=>b.version-a.version);if(url.searchParams.has('limit'))data=data.slice(0,Number(url.searchParams.get('limit')));
 }
 if(url.searchParams.has('source'))data=data.filter(r=>r.source===url.searchParams.get('source').slice(3));
 return reply(data,200,truncated&&table==='ga4_performance_imports'?1001:data.length);
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const port=3445;
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--webpack','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-test-key',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
let logs='',browser;app.stdout.on('data',c=>logs=(logs+c).slice(-9000));app.stderr.on('data',c=>logs=(logs+c).slice(-9000));
try{
 for(let i=0;i<120;i++){if(app.exitCode!==null)throw Error(logs);try{await fetch(`http://127.0.0.1:${port}/login`);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 const executable=process.env.CHROME_PATH??['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
 browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),part=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),expiry=Math.floor(Date.now()/1000)+3600;
 const user={id:team,email:'team@example.test',aud:'authenticated',role:'authenticated'};
 const session={access_token:`${part({alg:'HS256',typ:'JWT'})}.${part({sub:team,exp:expiry})}.fixture`,refresh_token:'fixture',expires_at:expiry,expires_in:3600,token_type:'bearer',user};
 await context.addCookies([{name:'sb-127-auth-token',value:`base64-${part(session)}`,domain:'127.0.0.1',path:'/'}]);
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/production/health`,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:'From visibility to action'}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'From visibility to action'}).evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)');
 assert.ok(await page.getByText('Reporting gaps',{exact:true}).isVisible());
 assert.equal(await page.getByRole('tab',{name:'Five-layer overview',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await page.locator('[data-overview-layer]').count(),5);
 assert.match(await page.locator('[data-overview-support]').innerText(),/CRM Lite, billing and client portal/);
 assert.equal(await page.locator('[data-layer-next="4"]').getAttribute('href'),`/clients/${a}/social/social-review`);
 await page.getByLabel('Filter Control Center clients').fill('South');
 assert.match(await page.locator('[data-five-layer-overview]').innerText(),/1 selected clients/);
 assert.equal(await page.locator('[data-layer-next="4"]').count(),0);
 await page.getByLabel('Filter Control Center clients').fill('');
 mkdirSync('docs/screenshots/control-center',{recursive:true});
 await page.screenshot({path:'docs/screenshots/control-center/overview-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await page.screenshot({path:'docs/screenshots/control-center/overview-mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('tab',{name:'Action queue',exact:true}).click();
 assert.ok(await page.getByText('Analytics 4 · missing',{exact:true}).isVisible());
 const socialReview=page.locator('[data-action-list] a').filter({hasText:'Social post waiting for approval'});assert.equal(await socialReview.getAttribute('href'),`/clients/${a}/social/social-review`);
 const review=page.locator('[data-action-list] a').filter({hasText:'Article waiting for approval'});assert.match(await review.getAttribute('href'),/drafts\/review1$/);
 await page.getByRole('tab',{name:'Delivery & work',exact:true}).click();
 assert.equal(await page.locator('[data-operational-system]').count(),12);
 assert.match(await page.locator(`[data-operational-client="${a}"] [data-operational-system="notifications"]`).innerText(),/provider-confirmed deliveries/);
 await page.getByRole('tab',{name:'Source freshness',exact:true}).click();
 const ga4=page.locator(`[data-integration-client="${a}"] [data-integration-source="ga4"]`);
 assert.ok(await ga4.getByText('Verified retrieval',{exact:true}).isVisible());
 assert.match(await page.locator(`[data-integration-client="${b}"] [data-integration-source="ga4"]`).innerText(),/No provider results/);
 await page.getByLabel('Filter Control Center clients').fill('North');assert.equal(await page.locator('[data-integration-client]').count(),1);
 mkdirSync('docs/screenshots/control-center',{recursive:true});await page.screenshot({path:'docs/screenshots/control-center/integrations-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await page.screenshot({path:'docs/screenshots/control-center/integrations-mobile.png',fullPage:true});
 await page.getByRole('tab',{name:'Delivery & work'}).click();assert.equal(await page.locator('[data-operational-system]').count(),6);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:'docs/screenshots/control-center/delivery-mobile.png',fullPage:true});
 await page.getByRole('tab',{name:'Client onboarding'}).click();await page.locator('[data-readiness-client] summary').click();assert.ok(await page.getByText('Approved brand foundation',{exact:true}).isVisible());
 await page.getByRole('tab',{name:'Source freshness'}).click();
 // A second brand's processing wait must remain visible beside a verified property.
 rows.client_brand_workspaces=[{id:'brand1',client_id:b,name:'South Safety',website_url:'https://safety.test',ga4_property:'properties/456',gsc_property:null,status:'approved',service_ids:[],claim_ids:[]}, {id:'brand2',client_id:b,name:'South Forklift',website_url:'https://forklift.test',ga4_property:'properties/789',gsc_property:null,status:'approved',service_ids:[],claim_ids:[]}];
 rows.ga4_performance_imports.push({...receipt,id:'south-receipt',client_id:b,property:'properties/456',host:'safety.test'});
 rows.ga4_performance_sync_runs.push({...run,id:'south1',client_id:b,results:[{scope_version:1,brand_workspace_id:'brand1',website_host:'safety.test',property:'properties/456',status:'imported',receipt_id:'south-receipt'}]}, {...run,id:'south2',client_id:b,status:'partial',results:[{scope_version:1,brand_workspace_id:'brand2',website_host:'forklift.test',property:'properties/789',status:'waiting',code:'property_processing_delay'}]});
 await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:'Source freshness'}).click();
 const south=page.locator(`[data-integration-client="${b}"] [data-integration-source="ga4"]`);
 assert.match(await south.innerText(),/1 of 2 website properties verified/);assert.match(await south.innerText(),/South Safety/);assert.match(await south.innerText(),/South Forklift/);assert.match(await south.innerText(),/Awaiting reporting dates/);
 assert.equal(await south.getByText('Verified retrieval',{exact:true}).count(),1);
 ga4Failure=true;await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:'Source freshness'}).click();
 assert.ok(await ga4.getByText('Unverified',{exact:true}).isVisible());assert.equal(await ga4.getByText('Verified retrieval',{exact:true}).count(),0);
 ga4Failure=false;truncated=true;await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:'Source freshness'}).click();assert.ok(await ga4.getByText('Unverified',{exact:true}).isVisible());
 // Internal review flow: safe empty state, save, persistent history and optimistic conflict.
 ga4Failure=false;truncated=false;await page.reload({waitUntil:'networkidle'});
 await page.getByRole('tab',{name:'Agency rollout',exact:true}).click();
 assert.equal(await page.locator('[data-rollout-client]').count(),2);
 const north=page.locator(`[data-rollout-client="${a}"]`);
 await north.locator('[data-rollout-scope="parent"] > summary').click();
 await north.getByText('Record / update review',{exact:true}).click();
 const form=north.locator('[data-rollout-form]');
 await form.getByLabel('Responsible owner / role',{exact:true}).first().fill('Fictional operator');
 await form.getByLabel('Next action',{exact:true}).first().fill('Confirm contracted scope');
 await form.getByLabel('Reason for this review',{exact:true}).fill('Initial portfolio assessment');
 await form.getByRole('button',{name:'Save review',exact:true}).click();
 await north.getByText('Review history (1)',{exact:true}).waitFor();
 assert.equal(rows.agency_rollout_reviews.length,1);assert.equal(rows.agency_rollout_reviews[0].stage,'unassessed');
 assert.equal(rows.agency_rollout_reviews[0].requirements.length,13);
 // Refresh can close native details; open only those currently closed.
 for(const summary of await north.locator('summary').all()){
  if((await summary.innerText())==='Record / update review'&&!(await summary.evaluate(el=>el.parentElement.open)))await summary.click();
 }
 rows.agency_rollout_reviews.push({...rows.agency_rollout_reviews[0],id:'concurrent',version:2});
 await form.getByLabel('Reason for this review',{exact:true}).fill('Stale browser review');
 await form.getByRole('button',{name:'Save review',exact:true}).click();
 assert.match(await form.getByRole('alert').innerText(),/changed/);assert.equal(writes.length,1);
 await page.screenshot({path:'docs/screenshots/control-center/rollout-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await page.screenshot({path:'docs/screenshots/control-center/rollout-mobile.png',fullPage:true});
 rolloutFailure=true;await page.reload({waitUntil:'networkidle'});await page.getByRole('tab',{name:'Agency rollout',exact:true}).click();
 assert.match(await page.locator('[data-agency-rollout]').getByRole('alert').innerText(),/unavailable/);
 assert.equal(await page.getByText('Record / update review',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);assert.deepEqual(writes,['POST /rest/v1/agency_rollout_reviews']);assert.ok(requests.includes('/rest/v1/ga4_performance_sync_runs'));
 console.log('Control Center browser passed: server reads, exact-count failure, provider evidence, linked alerts, client filtering, onboarding, responsive layout, internal review save and conflict refusal; no external writes.');
}catch(e){console.error(logs);throw e;}finally{await browser?.close();app.kill('SIGTERM');upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}

