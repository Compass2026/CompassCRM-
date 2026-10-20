// Browser acceptance for /clients/[id]/growth/report against a stub PostgREST.
// Default data is FICTIONAL. KEYWORD_REPORT_DATA=<json> renders a read-only
// export instead (review screenshots only; never committed).
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync} from 'node:fs';
import {chromium} from 'playwright-core';

const teamId='00000000-0000-4000-8000-000000000011';
const fictional=()=>{
 const clientId='00000000-0000-4000-8000-000000000001',site='https://fixture-roofer.example.test';
 const kw=(i,extra={})=>({id:`00000000-0000-4000-8000-0000000001${String(i).padStart(2,'0')}`,keyword:`fixture keyword ${i}`,city:null,intent:'commercial',priority:'p2',is_money:i===1,target_url:`${site}/services/${i}`,services:{name:'Fixture roofing',segment:'Roofing'},...extra});
 const keywords=[kw(1),kw(2),kw(3),kw(4,{services:null,target_url:`${site}/`})];
 const run=(id,d,status='complete',error='dataforseo · 4/4 answered')=>({id,status,started_at:d,completed_at:d,checks_count:4,error});
 const o=(k,r,d,type,position,url)=>({id:`${k.id}-${r}-${type}`,keyword_id:k.id,location_id:'loc-home',result_type:type,position,url_ranked:url,recorded_at:d,run_id:r});
 const d1='2026-09-14T06:00:00Z',d2='2026-10-19T06:00:00Z';
 const snapshots=[
  o(keywords[0],'r1',d1,'organic',12,`${site}/services/1`),o(keywords[0],'r2',d2,'organic',4,`${site}/services/1`),
  o(keywords[1],'r1',d1,'organic',3,`${site}/`),o(keywords[1],'r2',d2,'organic',1,'https://www.facebook.com/FixtureRoofing/'),
  o(keywords[2],'r1',d1,'organic',null,null),o(keywords[2],'r2',d2,'organic',null,null),
  o(keywords[3],'r1',d1,'organic',8,`${site}/blog/post`),o(keywords[3],'r2',d2,'organic',6,`${site}/blog/post`),
  ...keywords.flatMap(k=>[o(k,'r1',d1,'map_pack',2,null),o(k,'r2',d2,'map_pack',1,null)]),
 ];
 const pts=[{lat:38.8,lng:-90.8},{lat:38.81,lng:-90.8},{lat:38.85,lng:-90.8}];
 const geometry={version:'local-multiscale-v1',center:pts[0],tiers:[],radii_miles:[1,2,5],default_radius_miles:5,point_count:3};
 return {
  clientId,
  client:{id:clientId,name:'Fictional Roofing Co',dba:null,status:'launching',service_scope:'full',website_url:site,city:'Town',state:'MO',gsc_property:`${site}/`,ga4_property:'properties/1'},
  sites:[{url:site}],keywords,snapshots,
  rank_runs:[run('r1',d1),{...run('r0','2026-09-21T06:00:00Z','failed','dataforseo · results never arrived (3 h)')},run('r2',d2)],
  locations:[{id:'loc-home',name:'Town, MO',lat:38.8,lng:-90.8}],
  gsc_performance_imports:[{property:`${site}/`,period:'2026-08-01',period_end:'2026-08-31',created_at:'2026-10-12T19:00:00Z',data:{values:{search_clicks:55,search_impressions:1700}}},{property:`${site}/`,period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-12T19:00:00Z',data:{values:{search_clicks:64,search_impressions:1400}}}],
  ga4_performance_imports:[{property:'properties/1',period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-12T20:00:00Z',data:{coverage:'complete_month',host:'fixture-roofer.example.test',values:{website_sessions:113,website_users:77}}},{property:'properties/1',period:'2026-10-01',period_end:'2026-10-16',created_at:'2026-10-20T10:00:00Z',data:{coverage:'month_to_date',values:{website_sessions:79,website_users:71}}}],
  gbp_performance_imports:[{location_id:'locations/1',period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-12T18:00:00Z',data:{daily:{CALL_CLICKS:[{date:'2026-09-01',value:15}],WEBSITE_CLICKS:[{date:'2026-09-01',value:37}],BUSINESS_DIRECTION_REQUESTS:[{date:'2026-09-01',value:45}]}}}],
  inquiries:[{submitted_at:'2026-10-12T16:50:00Z',service_type:'Homepage estimate form',page_url:`${site}/`,inquiry_sources:{label:'Fixture website'}},{submitted_at:'2026-10-13T21:32:00Z',service_type:'Lighting quote',page_url:`${site}/quote`,inquiry_sources:{label:'Fixture website'}}],
  client_growth_work:[{id:'social:1',kind:'gbp',title:'Google Business Profile post',published_on:'2026-10-15',url:'https://local.google.com/fixture'}],
  content_drafts:[{status:'in_review'},{status:'in_review'},{status:'approved'}],
  map_grid_profiles:[{id:'profile-1',label:'Fixture grid',weekly_enabled:true,enabled:true}],
  map_grid_runs:[{id:'grid-2',profile_id:'profile-1',started_at:'2026-10-15T15:05:00Z',completed_at:'2026-10-15T15:09:00Z',status:'complete',error:null,config:{points:pts,keywords:[{id:keywords[0].id,keyword:keywords[0].keyword}],zoom:13,geometry,search_this_area:false}},{id:'grid-1',profile_id:'profile-1',started_at:'2026-10-15T02:08:00Z',completed_at:'2026-10-15T02:15:00Z',status:'complete',error:null,config:{points:pts.slice(0,2),keywords:[],zoom:13,geometry:null}}],
  map_grid_checks:[...pts.map((p,i)=>({run_id:'grid-2',keyword:keywords[0].keyword,...p,state:'complete',position:i+1}))],
  sync_runs:{gsc:[],ga4:[],gbp:[]},social_accounts:[],client_brand_workspaces:[],
 };
};
const real=!!process.env.KEYWORD_REPORT_DATA;
const data=real?JSON.parse(readFileSync(process.env.KEYWORD_REPORT_DATA,'utf8')):fictional();
const clientId=data.clientId;
const user=id=>({id,email:'team@example.test',aud:'authenticated',role:'authenticated'});
const requests=[],unexpected=[];
const upstream=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 for await(const _ of req);
 requests.push(`${req.method} ${url.pathname}?${url.searchParams}`);
 const one=(req.headers.accept??'').includes('vnd.pgrst.object');
 const reply=(body)=>{const rows=Array.isArray(body)?body:[body];res.writeHead(200,{'content-type':'application/json','content-range':`0-${Math.max(rows.length-1,0)}/${rows.length}`});res.end(JSON.stringify(one&&Array.isArray(body)?body[0]??null:body));};
 const eq=k=>url.searchParams.get(k)?.replace(/^eq\./,'');
 const inList=k=>url.searchParams.get(k)?.replace(/^in\.\(|\)$/g,'').split(',').map(s=>s.replace(/"/g,''))??[];
 const page=rows=>Number(url.searchParams.get('offset')??0)>0?[]:rows;
 const t=url.pathname.replace('/rest/v1/','');
 if(url.pathname==='/auth/v1/user')return reply(user(teamId));
 if(t==='rpc/is_team')return reply(true);
 if(t==='team_members')return reply([{id:teamId}]);
 if(t==='clients')return reply(one?data.client:[data.client]);
 if(t==='sites')return reply(data.sites);
 if(t==='keywords')return reply(data.keywords);
 if(t==='rank_snapshots'){const ids=inList('keyword_id');return reply(page(data.snapshots.filter(s=>ids.includes(s.keyword_id))));}
 if(t==='map_grid_runs')return reply(data.map_grid_runs.filter(r=>r.profile_id===eq('profile_id')));
 if(t==='map_grid_checks')return reply(data.map_grid_checks.filter(c=>c.run_id===eq('run_id')));
 if(['gsc_performance_sync_runs','ga4_performance_sync_runs','gbp_performance_sync_runs'].includes(t))return reply(data.sync_runs[t.slice(0,3)]);
 if(t in data)return reply(data[t]);
 unexpected.push(`${req.method} ${url.pathname}`);res.writeHead(500);res.end('{}');
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const port=Number(process.env.REPORT_UI_PORT??3441);
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--webpack','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${upstream.address().port}`,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-test-key',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
let logs='';app.stdout.on('data',c=>logs=(logs+c).slice(-9000));app.stderr.on('data',c=>logs=(logs+c).slice(-9000));
const shots=process.env.REPORT_SHOTS??'docs/screenshots/keyword-report';mkdirSync(shots,{recursive:true});
let browser;
try{
 for(let i=0;i<120;i++){if(app.exitCode!==null)throw new Error(logs);try{await fetch(`http://127.0.0.1:${port}/login`);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 const executable=process.env.CHROME_PATH??['/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
 browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
 const part=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const expiry=Math.floor(Date.now()/1000)+3600;
 await ctx.addCookies([{name:'sb-127-auth-token',value:`base64-${part({access_token:`${part({alg:'HS256',typ:'JWT'})}.${part({sub:teamId,exp:expiry})}.fixture`,refresh_token:'fixture',expires_at:expiry,expires_in:3600,token_type:'bearer',user:user(teamId)})}`,domain:'127.0.0.1',path:'/'}]);
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}/clients/${clientId}/growth/report`,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:/keywords to results/}).waitFor({timeout:60000});
 for(const h of ['Where things stand','What each number is based on','Tracked keywords, check by check','Each tracked keyword','Map rankings (separate from the website)','Search Console, Analytics and Business Profile','Captured website inquiries','Published work'])
  await page.getByRole('heading',{name:h,exact:true}).waitFor();
 if(!real){
  const table=page.getByRole('table',{name:'Tracked keyword ranking detail'});
  const row=n=>table.getByRole('row').filter({has:page.getByRole('rowheader',{name:new RegExp(`^fixture keyword ${n}(?!\\d)`)})});
  await row(1).getByText('Up 8',{exact:true}).waitFor();
  await row(2).getByText(/^Third-party page matched/).waitFor();
  await row(2).getByText('Not comparable: a third-party page was matched').waitFor();
  await row(3).getByText('Not in the top 100 at either check').waitFor();
  await row(4).getByText('Differs from intended page, review').waitFor();
  assert.equal(await page.getByText('Stable comparison group:').locator('..').textContent().then(t=>/3 keywords measured.*1 excluded for a third-party match/.test(t)),true);
  await page.getByText(/earlier scan .* used a different grid, so it is not compared/).waitFor();
  await page.getByText(/Partial \(month to date\)/).first().waitFor();
  await page.getByText('dataforseo · results never arrived (3 h)',{exact:false}).first().waitFor();
 }
 // No provider and no write from a report read; contact details are never requested.
 assert.deepEqual(unexpected,[]);
 assert.ok(requests.every(r=>r.startsWith('GET ')),requests.filter(r=>!r.startsWith('GET ')).join('\n'));
 const inquiryReads=requests.filter(r=>r.includes('/rest/v1/inquiries'));
 assert.ok(inquiryReads.length&&inquiryReads.every(r=>!/select=[^&]*(name|email|phone|message)/.test(decodeURIComponent(r))),inquiryReads.join('\n'));
 for(const t of ['keywords','rank_runs','locations','gsc_performance_imports','ga4_performance_imports','gbp_performance_imports','inquiries','client_growth_work','content_drafts','map_grid_profiles'])
  assert.ok(requests.filter(r=>r.includes(`/rest/v1/${t}?`)).every(r=>[`client_id=eq.${clientId}`,`client_id=in.(${clientId})`].some(scope=>decodeURIComponent(r).includes(scope))),`${t} must be scoped to the client`);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:`${shots}/report-desktop.png`,fullPage:true});
 for(const id of ['plain','health','organic','keywords','maps','traffic','inquiries','work'])await page.locator(`section[aria-labelledby="${id}"]`).screenshot({path:`${shots}/section-${id}.png`});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${shots}/report-mobile.png`,fullPage:true});
 console.log(`keyword report UI: ${real?'export':'fictional'} data rendered, ${requests.length} stub reads, no writes or provider calls`);
}finally{await browser?.close();app.kill('SIGTERM');upstream.close();}
