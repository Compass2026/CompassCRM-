// Browser acceptance with synthetic API data. Database isolation is verified
// separately by client_growth.test.sql against the full migration chain.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
const clientId='00000000-0000-4000-8000-000000000001',teamId='00000000-0000-4000-8000-000000000011',portalId='00000000-0000-4000-8000-000000000012',keywordId='00000000-0000-4000-8000-000000000021';
const user=id=>({id,email:id===teamId?'team@example.test':'client@example.test',aud:'authenticated',role:'authenticated'});
const client={id:clientId,name:'Fictional growth client',status:'active',dba:null,website_url:'https://client.example.test'};
const fixture={client_id:clientId,scope:'Verified property export',source:'Fixture GA4',platform:'none',channel:'none',context:'existing_client',status:'measured',created_at:'2026-08-01T00:00:00Z'};
const measurements=['organic_sessions','forms','referring_domains','pages_live'].flatMap((metric,i)=>[
 {...fixture,id:`${i}a`,metric,sequence:i*2+1,window_start:['organic_sessions','forms'].includes(metric)?'2026-08-01':'2026-08-31',window_end:'2026-08-31',report_period:null,value:10},
 {...fixture,id:`${i}b`,metric,sequence:i*2+2,window_start:['organic_sessions','forms'].includes(metric)?'2026-09-01':'2026-09-30',window_end:'2026-09-30',report_period:'2026-09-01',value:20},
]);
const ranking={client_id:clientId,keyword_id:keywordId,keyword:'roof repair',keyword_city:'Springfield',location_id:'home',location_name:'Springfield',result_type:'organic',first_position:18,first_checked_at:'2026-08-01T00:00:00Z',position:2,checked_at:'2026-09-28T00:00:00Z',previous_position:5,previous_checked_at:'2026-09-21T00:00:00Z'};
const rankingRows=[ranking,{...ranking,result_type:'map_pack',position:1},{...ranking,keyword_id:'second',keyword:'roof replacement',position:null},{...ranking,keyword_id:'third',keyword:'new keyword',result_type:null,first_position:null,first_checked_at:null,position:null,checked_at:null},
 // Latest organic result was a directory page carrying the business name: excluded, not a rank and not "not found".
 {...ranking,keyword_id:'fourth',keyword:'fictional brand roofing',first_position:3,first_state:'website',position:null,state:'third_party',previous_position:3,previous_state:'website'}];
for(const [i,metric] of ['gbp_views','gbp_clicks','gbp_call_clicks','gbp_directions'].entries()) for(const [month,value] of [['08',10+i],['09',[524,37,15,45][i]]]) measurements.push({...fixture,id:`gbp-${i}-${month}`,metric,sequence:20+i*2+(month==='09'?1:0),source:'Google Business Profile via Zernio',window_start:`2026-${month}-01`,window_end:`2026-${month}-${month==='08'?'31':'30'}`,report_period:`2026-${month}-01`,value});
const opportunities=[],checks=[],unexpected=[];let failInsert=true,searchSample=true;
const upstream=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 let actor;try{actor=JSON.parse(Buffer.from((req.headers.authorization??'').split('.')[1]??'','base64url').toString()).sub;}catch{actor=teamId;}
 const reply=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
 let body='';for await(const chunk of req)body+=chunk;
 const input=body?JSON.parse(body):{};
 if(url.pathname==='/auth/v1/user')return reply(user(actor));
 if(url.pathname==='/rest/v1/rpc/is_team')return reply(actor===teamId);
 if(url.pathname==='/rest/v1/rpc/portal_seen')return reply(null);
 if(url.pathname==='/rest/v1/team_members')return reply(actor===teamId?[{id:teamId}]:[]);
 if(url.pathname==='/rest/v1/clients')return reply(client);
 if(url.pathname==='/rest/v1/portal_client')return reply(client);
 if(['/rest/v1/portal_billing_summary','/rest/v1/portal_crm_lite'].includes(url.pathname))return reply(null);
 if(url.pathname==='/rest/v1/portal_growth_measurements'&&(url.searchParams.get('metric')??'').includes('search_clicks'))return reply([
  {metric:'search_clicks',scope:'Search Console https://client.example.test/',source:'Google Search Console property totals',status:'measured',value:64,window_start:'2026-09-01',window_end:'2026-09-30',sequence:41},
  {metric:'search_impressions',scope:'Search Console https://client.example.test/',source:'Google Search Console property totals',status:'measured',value:14280,window_start:'2026-09-01',window_end:'2026-09-30',sequence:42}]);
 if(['/rest/v1/report_measurements','/rest/v1/portal_growth_measurements'].includes(url.pathname)){if(req.method==='POST'){measurements.push(...input.map((r,i)=>({...r,sequence:100+i,created_at:new Date().toISOString()})));return reply(null,201);}return reply(measurements.map(({evidence,meaning,next_action,recorded_by,...r})=>r));}
 if(['/rest/v1/client_growth_search','/rest/v1/portal_growth_search'].includes(url.pathname))return reply([{client_id:clientId,period_start:'2026-08-01',period_end:'2026-08-28',clicks:10,impressions:100,imported_rows:5},{client_id:clientId,period_start:'2026-09-01',period_end:'2026-09-28',clicks:30,impressions:200,imported_rows:8}]);
 if(['/rest/v1/client_growth_rankings','/rest/v1/portal_growth_rankings'].includes(url.pathname))return reply(rankingRows);
 if(['/rest/v1/client_growth_work','/rest/v1/portal_growth_work'].includes(url.pathname))return reply([{id:'publication1',client_id:clientId,kind:'blog',title:'Roof care guide',published_on:'2026-09-05',url:'https://client.example.test/blog/roof'},{id:'publication2',client_id:clientId,kind:'social',title:'Facebook post',published_on:'2026-08-20',url:'javascript:alert(1)'}]);
 if(url.pathname==='/rest/v1/keywords')return reply([{id:keywordId,keyword:'roof repair',target_url:'/roof-repair',service_id:null}]);
 if(url.pathname==='/rest/v1/client_brand_workspaces')return reply([]);
 if(url.pathname==='/rest/v1/backlink_opportunities'){
  if(req.method==='POST'){
   if(failInsert){failInsert=false;return reply({code:'TEST_ERROR',message:'temporary failure'},400);}
   opportunities.push({...input,stage:'research',created_at:new Date().toISOString(),updated_at:new Date().toISOString()});return reply(null,201);
  }
  const id=url.searchParams.get('id')?.replace('eq.','');
  if(req.method==='PATCH'){
   const o=opportunities.find(o=>o.id===id&&o.updated_at===url.searchParams.get('updated_at')?.replace('eq.',''));
   if(!o)return reply(null);
   Object.assign(o,input,{updated_at:new Date().toISOString()});return reply({id:o.id});
  }
  return reply(id?opportunities.find(o=>o.id===id)??null:opportunities);
 }
 if(url.pathname==='/rest/v1/backlink_checks'){
  if(req.method==='POST'){checks.push({...input,recorded_at:new Date().toISOString(),recorded_by:teamId});return reply(null,201);}
  return reply(checks);
 }
 if(url.pathname==='/rest/v1/portal_backlinks')return reply(opportunities.flatMap(o=>{const history=checks.filter(c=>c.opportunity_id===o.id),last=history.at(-1);return last?[{id:o.id,client_id:clientId,title:o.title,source_url:o.source_url,target_url:o.target_url,keyword:'roof repair',brand_name:null,observed_on:last.observed_on,result:last.result,rel:last.rel,anchor_text:last.anchor_text,first_live_on:history[0].observed_on}]:[];}));
 // Portal overview, search and rankings. Search Console headlines must come from the verified property
 // import (portal_growth_measurements); the query-row sample below sums to different, smaller numbers.
 // The property import and the query-sample import are independent; searchSample=false models no sample yet.
 if(url.pathname==='/rest/v1/portal_search_performance')return reply(searchSample?[{client_id:clientId,period_start:'2026-09-15',period_end:'2026-10-12',clicks:27,impressions:13408,avg_position:20.3,queries:935}]:[]);
 if(url.pathname==='/rest/v1/portal_search_queries')return reply([{query:'fictional roof repair',clicks:9,impressions:400,avg_position:3.2}]);
 if(url.pathname==='/rest/v1/portal_rankings')return reply([
  {client_id:clientId,keyword:'roof repair',city:'Springfield',is_money:true,result_type:'organic',position:2,previous_position:5,checked_at:'2026-10-19T06:00:00Z',state:'website',previous_state:'website'},
  {client_id:clientId,keyword:'fictional brand roofing',city:'Springfield',is_money:false,result_type:'organic',position:null,previous_position:3,checked_at:'2026-10-19T06:00:00Z',state:'third_party',previous_state:'website'},
  {client_id:clientId,keyword:'roof replacement',city:'Springfield',is_money:false,result_type:'organic',position:null,previous_position:null,checked_at:'2026-10-19T06:00:00Z',state:'not_found',previous_state:'not_found'}]);
 if(['/rest/v1/portal_progress','/rest/v1/portal_work_log','/rest/v1/portal_reports'].includes(url.pathname))return reply([]);
 if(url.pathname==='/rest/v1/portal_site')return reply(null);
 unexpected.push(`${req.method} ${url.pathname}`);return reply({message:'unexpected fixture request'},500);
});
// The app runs as a production build. next dev recomputes a dynamic route's
// static paths by reading, parsing and rewriting .next/prerender-manifest.json
// with a non-atomic writeFile while a compile can rewrite the same file: on a
// slow runner a request then reads an empty manifest ("Unexpected end of JSON
// input", HTTP 500 on /clients/[clientId]/growth, CI run 39509860696). A build
// compiles once up front, so no request races a compile. NEXT_PUBLIC_* values
// are inlined at build time, hence the fixed fixture API port.
const stubPort=Number(process.env.GROWTH_STUB_PORT??54338);
await new Promise(resolve=>upstream.listen(stubPort,'127.0.0.1',resolve));
const port=Number(process.env.GROWTH_UI_PORT??3438);
const appEnv={...process.env,NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${stubPort}`,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-test-key',NEXT_TELEMETRY_DISABLED:'1'};
const built=spawnSync(process.execPath,['node_modules/next/dist/bin/next','build'],{env:appEnv,stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:64*1024*1024});
if(built.status!==0){upstream.close();throw new Error(`next build failed\n${built.stdout.slice(-4000)}\n${built.stderr.slice(-4000)}`);}
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:appEnv,stdio:['ignore','pipe','pipe']});
let logs='';app.stdout.on('data',c=>logs=(logs+c).slice(-9000));app.stderr.on('data',c=>logs=(logs+c).slice(-9000));
let browser;
const shots='docs/screenshots/client-growth';mkdirSync(shots,{recursive:true});
try{
 for(let i=0;i<120;i++){if(app.exitCode!==null)throw new Error(logs);try{await fetch(`http://127.0.0.1:${port}/login`);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 const executable=process.env.CHROME_PATH??['/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
 browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
 const part=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
 async function context(actor){const c=await browser.newContext({viewport:{width:1440,height:1000}});const expiry=Math.floor(Date.now()/1000)+3600;const session={access_token:`${part({alg:'HS256',typ:'JWT'})}.${part({sub:actor,exp:expiry})}.fixture`,refresh_token:'fixture',expires_at:expiry,expires_in:3600,token_type:'bearer',user:user(actor)};await c.addCookies([{name:'sb-127-auth-token',value:`base64-${part(session)}`,domain:'127.0.0.1',path:'/'}]);return c;}
 const team=await context(teamId),page=await team.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/growth`,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:/Where we started.*How you're growing/}).waitFor();
 assert.equal(await page.getByRole('heading',{name:/Where we started.*How you're growing/}).evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)');
 const work=page.getByRole('region',{name:'Published work',exact:true});
 assert.equal(await work.getByRole('link').count(),1);
 await work.getByRole('button',{name:/Blog posts/}).click();
 assert.equal(await work.getByText('Facebook post',{exact:true}).count(),0);
 await work.getByRole('button',{name:'Show all published work',exact:true}).click();
 await work.getByRole('button',{name:'2026-08: 1 publications',exact:true}).click();
 assert.equal(await work.getByText('Roof care guide',{exact:true}).count(),0);
 await work.getByRole('button',{name:'Show all published work',exact:true}).click();
 const analytics=page.getByRole('region',{name:'Interactive performance analytics',exact:true});
 await analytics.getByRole('button',{name:'Chart Website clicks',exact:true}).click();
 assert.match(await analytics.getByTestId('chart-readout').innerText(),/37 website clicks/);
 await analytics.getByRole('button',{name:'Inspect Aug 31, 2026',exact:true}).focus();
 assert.match(await analytics.getByTestId('chart-readout').innerText(),/10|11/);
 await analytics.getByRole('button',{name:'Bars',exact:true}).click();
 assert.match(await analytics.getByTestId('performance-plot').getAttribute('aria-label'),/Website clicks bar chart/);
 await analytics.getByRole('button',{name:'Last 3',exact:true}).click();
 await analytics.getByRole('button',{name:'Line',exact:true}).click();
 const mix=page.locator('[aria-label="GBP interaction mix"]');
 await mix.getByRole('button',{name:/Website clicks/}).click();
 assert.equal(await mix.getByRole('button',{name:/Website clicks/}).getAttribute('aria-pressed'),'true');
 await mix.getByRole('button',{name:'Show all segments'}).click();
 await page.getByRole('button',{name:'Chart Profile impressions',exact:true}).click();
 assert.match(await page.getByTestId('tracked-keywords').innerText(),/Keywords tracked\s+4/);
 assert.match(await page.getByTestId('maps-rankings').innerText(),/Average position: 1.0/);
 assert.match(await page.getByTestId('organic-rankings').innerText(),/2 of 4 keywords checked/);
 assert.match(await page.getByTestId('organic-rankings-excluded').innerText(),/1 keyword is excluded: the latest result was not confirmed as your website/);
 await page.locator('[aria-label="Ranking distribution"]').getByRole('button',{name:/^Top 3/}).click();
 assert.equal(await page.getByRole('cell',{name:'roof replacement',exact:false}).count(),0);
 await page.locator('[aria-label="Ranking distribution"]').getByRole('button',{name:'Show all segments'}).click();
 await page.getByLabel('Find a keyword',{exact:true}).fill('roof repair');
 assert.equal(await page.getByRole('cell',{name:/new keyword/}).count(),0);
 await page.getByLabel('Find a keyword',{exact:true}).fill('');
 await page.getByRole('cell',{name:'Up 16',exact:true}).waitFor();
 assert.ok(await page.getByText('Not found in checked results',{exact:true}).isVisible());
 await page.getByText('Keyword progress: first check to latest',{exact:true}).click();
 await page.screenshot({path:`${shots}/progress-desktop.png`,fullPage:true});
 await page.getByText('All measurements & sources',{exact:false}).click();
 assert.equal(await page.locator('section[aria-label="Client growth dashboard"] article').count(),9);
 assert.ok(await page.getByText('Automatically imported complete months.',{exact:false}).first().isVisible());
 assert.equal(await page.locator('article').getByText('+10 (+100.0%) since baseline',{exact:true}).count(),4);
 await page.getByText('Reporting dates & filters',{exact:false}).click();
 await page.locator('select[name="range"]').selectOption('month');await page.locator('input[name="month"]').fill('2026-09');await page.getByRole('button',{name:'Update view'}).click();await page.waitForURL(/range=month/);await page.getByText('All measurements & sources',{exact:false}).click();await page.getByText('Result in selected dates').first().waitFor();
 assert.equal(await page.locator('article').getByText('Aug 31, 2026',{exact:true}).count(),8);
 await page.getByText('All measurements & sources',{exact:false}).click();
 for(const [i,metric]of ['website_sessions','website_users','website_pageviews'].entries())for(const [month,value]of [['08',30+i],['09',50+i]])measurements.push({...fixture,id:`traffic-${i}-${month}`,source:'Google Analytics 4',scope:'GA4 properties/123 | client.example.test | America/Chicago | complete_month',metric,sequence:50+i*2+(month==='09'?1:0),window_start:`2026-${month}-01`,window_end:`2026-${month}-${month==='08'?'31':'30'}`,value});
 await page.reload({waitUntil:'networkidle'});
 const traffic=page.getByRole('region',{name:'Website traffic analytics',exact:true});
 await traffic.getByRole('button',{name:'Chart Website visitors',exact:true}).click();
 assert.match(await traffic.getByTestId('chart-readout').innerText(),/51 website visitors/);
 await traffic.getByRole('button',{name:'Bars',exact:true}).click();
 assert.match(await traffic.getByTestId('performance-plot').getAttribute('aria-label'),/Website visitors bar chart/);
 await page.screenshot({path:`${shots}/traffic-desktop.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${shots}/progress-mobile.png`,fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/backlinks`,{waitUntil:'networkidle'});
 await page.getByText('Record a backlink profile report',{exact:true}).click();
 await page.getByRole('button',{name:'Add profile measurement',exact:true}).click();
 const profile=page.getByRole('form',{name:'Backlink profile report'});
 await profile.getByLabel('Provider',{exact:true}).fill('Fixture provider');await profile.getByLabel('Report coverage',{exact:true}).fill('Domain live index');
 await profile.getByLabel('Indexed backlinks',{exact:true}).fill('80');await profile.getByLabel('Referring websites',{exact:true}).fill('20');
 await profile.getByLabel('Evidence / report reference',{exact:true}).fill('PRIVATE provider export');await profile.getByRole('button',{name:'Save measured profile'}).click();
 await page.getByRole('status').filter({hasText:'Profile saved'}).waitFor();
 assert.equal(measurements.filter(r=>r.source==='Fixture provider').length,2);
 await page.getByText('Record a backlink profile report',{exact:true}).click();
 await page.getByText('Add a backlink opportunity',{exact:true}).click();await page.getByRole('button',{name:'Start an opportunity'}).click();
 await page.locator('select[name="keyword_id"]').selectOption(keywordId);assert.equal(await page.locator('input[name="target_url"]').inputValue(),'https://client.example.test/roof-repair');
 await page.locator('input[name="title"]').fill('Regional trade association');await page.locator('input[name="source_url"]').fill('https://association.example.test/member');await page.locator('input[name="next_action"]').fill('Review member directory');await page.locator('textarea[name="notes"]').fill('PRIVATE outreach notes');
 await page.getByRole('button',{name:'Save opportunity',exact:true}).click();await page.getByRole('alert').filter({hasText:'could not be saved'}).waitFor();assert.equal(await page.locator('input[name="title"]').inputValue(),'Regional trade association');
 await page.getByRole('button',{name:'Save opportunity',exact:true}).click();await page.getByRole('heading',{name:'Regional trade association'}).waitFor();assert.equal(opportunities.length,1);
 await page.getByText('Update progress',{exact:true}).click();await page.locator('select[name="stage"]').selectOption('placed');await page.getByRole('button',{name:'Save progress'}).click();await page.getByText('Placement reported',{exact:false}).first().waitFor();
 assert.ok(await page.getByText('Not checked',{exact:true}).isVisible());
 await page.locator('summary').filter({hasText:'Verification & history'}).click();await page.getByRole('button',{name:'Record a link check',exact:true}).click();await page.locator('textarea[name="evidence"]').fill('PRIVATE screenshot evidence confirms exact target');await page.getByRole('button',{name:'Save link check',exact:true}).click();await page.getByText('Verified live',{exact:true}).waitFor();assert.equal(checks.length,1);
 await page.screenshot({path:`${shots}/backlinks-team.png`,fullPage:true});
 const portal=await context(portalId),clientPage=await portal.newPage();clientPage.on('pageerror',e=>errors.push(e.message));
 await clientPage.goto(`http://127.0.0.1:${port}/portal/growth`,{waitUntil:'networkidle'});await clientPage.getByRole('heading',{name:/Where we started.*How you're growing/}).waitFor();assert.equal(await clientPage.getByText('Record measurements & review reports',{exact:true}).count(),0);
 assert.match(await clientPage.getByTestId('tracked-keywords').innerText(),/Keywords tracked\s+4/);
 await clientPage.goto(`http://127.0.0.1:${port}/portal`,{waitUntil:'networkidle'});
 const searchCard=clientPage.locator('div').filter({has:clientPage.getByText('Search traffic',{exact:true})}).filter({hasText:'clicks from Google Search'}).last();
 assert.match(await searchCard.innerText(),/64[\s\S]*clicks from Google Search[\s\S]*14,280[\s\S]*Search Console totals for your website/);
 assert.doesNotMatch(await searchCard.innerText(),/\b27\b|13,408/,'query-row sums are not the website total');
 await clientPage.goto(`http://127.0.0.1:${port}/portal/search`,{waitUntil:'networkidle'});
 assert.match(await clientPage.locator('main').innerText(),/64[\s\S]*clicks from Google Search[\s\S]*14,280/);
 assert.match(await clientPage.locator('main').innerText(),/does not add up to your totals/);
 assert.equal(await clientPage.getByText('average position',{exact:true}).count(),0,'no unweighted average of query rows as a headline');
 // Valid property totals with zero query-sample rows: the totals still render; the sample has its own empty state.
 searchSample=false;
 await clientPage.goto(`http://127.0.0.1:${port}/portal/search`,{waitUntil:'networkidle'});
 assert.match(await clientPage.locator('main').innerText(),/64[\s\S]*clicks from Google Search[\s\S]*14,280/);
 assert.match(await clientPage.locator('main').innerText(),/No search sample yet/);
 assert.equal(await clientPage.getByRole('table').count(),0,'no sample table without sample rows');
 searchSample=true;
 await clientPage.goto(`http://127.0.0.1:${port}/portal/rankings`,{waitUntil:'networkidle'});
 const rankRow=k=>clientPage.getByRole('row').filter({hasText:k});
 assert.match(await rankRow('fictional brand roofing').innerText(),/not available/);
 assert.doesNotMatch(await rankRow('fictional brand roofing').innerText(),/not in top 100|▼|▲/);
 assert.match(await rankRow('roof replacement').innerText(),/not in top 100/);
 assert.match(await rankRow('roof repair').first().innerText(),/2[\s\S]*▲ 3/);
 await clientPage.goto(`http://127.0.0.1:${port}/portal/backlinks`,{waitUntil:'networkidle'});await clientPage.getByRole('heading',{name:'Regional trade association'}).waitFor();assert.doesNotMatch(await clientPage.locator('body').innerText(),/PRIVATE/);assert.equal(await clientPage.getByRole('button',{name:'Save link check'}).count(),0);
 await clientPage.setViewportSize({width:390,height:844});await clientPage.screenshot({path:`${shots}/backlinks-portal-mobile.png`,fullPage:true});assert.equal(await clientPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
 console.log('Growth UI passed: fixed baseline, date filters, mobile layout, retry retention, opportunity save, stage update, evidence check, portal rendering. Synthetic data only.');
}catch(e){console.error(logs);throw e;}finally{await browser?.close();app.kill('SIGTERM');upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}
