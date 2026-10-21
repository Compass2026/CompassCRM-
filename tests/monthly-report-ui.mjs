// Browser acceptance for the monthly report workflow against a stub API with
// FICTIONAL data: generate → edit → review → approve the exact version →
// record the outcome; print and the unsaved preview. Database rules (hashes,
// immutability, corrections, isolation) are verified by
// monthly_reports.test.sql against the full migration chain; this stub only
// mirrors the function contracts the pages call.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,existsSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {monthOfPeriod,reportPeriods} from '../src/lib/monthly-report.ts';

const clientId='00000000-0000-4000-8000-000000000001',brandClientId='00000000-0000-4000-8000-000000000002',teamId='00000000-0000-4000-8000-000000000011';
const site='https://fixture-roofer.example.test',host='fixture-roofer.example.test';
const now=new Date().toISOString();
const [cur,prev]=reportPeriods(now,2);
const P=monthOfPeriod(prev),PP=monthOfPeriod(P.previous);
const at=(month,days,hours=12)=>new Date(Date.parse(month.start)+days*86400000+hours*3600000).toISOString();
const user=id=>({id,email:'team@example.test',aud:'authenticated',role:'authenticated'});
const client={id:clientId,name:'Fictional Roofing Co',dba:null,status:'launching',service_scope:'full',website_url:site,city:'Town',state:'MO',gsc_property:`${site}/`,ga4_property:'properties/1'};
const kw=i=>({id:`00000000-0000-4000-8000-0000000001${String(i).padStart(2,'0')}`,keyword:`fixture keyword ${i}`,city:null,intent:'commercial',priority:'p2',is_money:i===1,target_url:null,service_id:i===3?'svc-light':'svc-roof'});
const keywords=[1,2,3].map(kw);
const run=(id,d)=>({id,status:'complete',started_at:d,completed_at:d,checks_count:3,error:'dataforseo · 3/3 answered',triggered_by:'cron'});
const o=(k,r,d,type,position,url)=>({keyword_id:k.id,location_id:'loc-home',result_type:type,position,url_ranked:url,recorded_at:d,run_id:r});
const dBase=at(PP,26,6),dEnd=at(P,25,6);
const data={
 sites:[{url:site}],social_accounts:[{publish_account_id:'0123456789abcdef01234567',publish_page_id:'locations/1',external_account_id:'locations/1'}],
 services:[{id:'svc-roof',name:'Roof replacement',segment:'Roofing'},{id:'svc-light',name:'Holiday lighting',segment:'Lighting'}],
 brand_colors:[{hex:'#0f766e',role:'primary'}],client_brands:{tagline:'Fixture tagline'},
 keywords,
 rank_snapshots:[
  o(keywords[0],'rb',dBase,'organic',14,`${site}/roofs`),o(keywords[0],'re',dEnd,'organic',6,`${site}/roofs`),
  o(keywords[1],'rb',dBase,'organic',4,'https://www.facebook.com/fixture'),o(keywords[1],'re',dEnd,'organic',2,`${site}/`),
  o(keywords[2],'rb',dBase,'organic',null,null),o(keywords[2],'re',dEnd,'organic',18,`${site}/lights`),
  ...keywords.flatMap(k=>[o(k,'rb',dBase,'map_pack',3,null),o(k,'re',dEnd,'map_pack',2,null)]),
 ],
 rank_runs:[run('rb',dBase),run('re',dEnd)],
 report_measurements:[
  ...[['search_clicks',140],['search_impressions',5100]].map(([metric,value],i)=>({client_id:clientId,metric,scope:`Search Console ${site}/ | web search | complete calendar months`,source:'Google Search Console property totals',status:'measured',value,report_period:prev,window_start:prev,window_end:P.lastDay,sequence:10+i,created_at:at(P,32)})),
  ...[['website_sessions',300],['website_users',210],['website_pageviews',900]].map(([metric,value],i)=>({client_id:clientId,metric,scope:`GA4 properties/1 | ${host} | America/Chicago | complete_month`,source:'Google Analytics 4',status:'measured',value,report_period:prev,window_start:prev,window_end:P.lastDay,sequence:20+i,created_at:at(P,32)})),
  ...[['gbp_views',600],['gbp_call_clicks',12],['gbp_clicks',30],['gbp_directions',9]].map(([metric,value],i)=>({client_id:clientId,metric,scope:'Google Business Profile locations/1 | complete calendar months',source:'Google Business Profile via Zernio',status:'measured',value,report_period:prev,window_start:prev,window_end:P.lastDay,sequence:30+i,created_at:at(P,32)})),
 ],
 inquiries:[{client_id:clientId,submitted_at:at(P,3),service_type:'Roof quote',page_url:`${site}/contact`,inquiry_sources:{label:'Fixture website'}},{client_id:clientId,submitted_at:at(P,9),service_type:'Lighting quote',page_url:`${site}/lights`,inquiry_sources:null}],
 inquiry_sources:[{id:'src',enabled:true}],
 content_posts:[{id:'blog-1',client_id:clientId,title:'Fixture roof guide',url:`${site}/blog/roof-guide`,published_at:P.period.slice(0,8)+'07',keyword_id:keywords[0].id}],
 social_published:[{id:'fb-1',client_id:clientId,platform:'facebook',copy:'Fixture Facebook post about roofs',published_url:'https://facebook.example.test/p/1',published_at:at(P,4),service_id:'svc-roof',review_status:'approved',publish_status:'published',created_at:at(P,2)},
  {id:'gbp-1',client_id:clientId,platform:'google_business',copy:'Fixture lighting update',published_url:'https://local.example.test/p/2',published_at:at(P,10),service_id:'svc-light',review_status:'approved',publish_status:'published',created_at:at(P,8)}],
 social_queue:[{id:'fb-q',client_id:clientId,platform:'facebook',copy:'Queued',published_url:null,published_at:null,service_id:null,review_status:'in_review',publish_status:'not_scheduled',created_at:at(P,12)}],
 change_log:[],content_drafts:[{deliverable:'blog',status:'in_review'},{deliverable:'blog',status:'in_review'}],
 map_grid_profiles:[{id:'profile-1',label:'Fixture grid',weekly_enabled:true,enabled:true}],
 map_grid_runs:[{id:'grid-1',profile_id:'profile-1',started_at:at(P,14),completed_at:at(P,14,13),status:'complete',config:{target_place_id:'p',points:[{lat:1,lng:1},{lat:2,lng:2}],keywords:[{id:keywords[0].id,keyword:keywords[0].keyword}],zoom:13,search_this_area:false,geometry:{version:'local-multiscale-v1',default_radius_miles:5,point_count:2}}}],
 map_grid_checks:[{run_id:'grid-1',state:'complete',position:2},{run_id:'grid-1',state:'complete',position:null}],
 gsc_snapshots:[{client_id:clientId,query:'fixture roofer',clicks:9,impressions:200,period_start:at(P,-12).slice(0,10),period_end:at(P,15).slice(0,10)}],
 portal_users:[],client_contacts:[{email:'owner@fixture.example.test'}],
};
// In-memory monthly_reports / deliveries with the function contracts.
const reports=[],deliveries=[],calls=[];
const sha=v=>'sha256:'+createHash('sha256').update(v).digest('hex');
const rehash=r=>{r.content_hash=sha(r.snapshot_hash+'|'+JSON.stringify(r.editorial));};
function rpc(name,a){
 calls.push({name,args:a});
 if(name==='delivery_targets')return [200,[]];
 const err=(code,message)=>[400,{code,message}];
 if(name==='monthly_report_save'){
  if(a.p_snapshot.client_id!==a.p_client_id||a.p_snapshot.period!==a.p_period||a.p_snapshot.cutoff!==a.p_cutoff)return err('23514','The snapshot is not for this client, brand, period, cutoff and calculation');
  const same=reports.find(r=>r.client_id===a.p_client_id&&r.request_key===a.p_request_key);if(same)return [200,{report_id:same.id,version:same.version,reused:true}];
  const mine=reports.filter(r=>r.client_id===a.p_client_id&&r.period===a.p_period);
  const approved=mine.find(r=>r.status==='approved');
  if(approved&&!a.p_correction_reason)return err('22023',`Version ${approved.version} is approved; a new version is a correction and needs a reason`);
  for(const r of mine)if(r.status==='draft'||r.status==='in_review')r.status='discarded';
  const latest=mine.at(-1),m=monthOfPeriod(a.p_period);
  const r={id:randomUUID(),client_id:a.p_client_id,brand_workspace_id:null,unit_key:'00000000-0000-0000-0000-000000000000',period:a.p_period,version:(latest?.version??0)+1,status:'draft',cutoff:a.p_cutoff,period_start:m.start,period_end:m.end,
   is_partial:Date.parse(a.p_cutoff)<Date.parse(m.end),completeness:a.p_snapshot.completeness,calculation_version:a.p_calculation_version,snapshot:a.p_snapshot,snapshot_hash:sha(JSON.stringify(a.p_snapshot)),editorial:a.p_editorial??latest?.editorial??{},edit_version:1,
   supersedes_id:latest?.id??null,correction_reason:approved?a.p_correction_reason:null,request_key:a.p_request_key,generated_at:new Date().toISOString(),approved_at:null,approved_hash:null,approved_destination:null,approved_recipients:null};
  rehash(r);reports.push(r);return [200,{report_id:r.id,version:r.version,reused:false}];
 }
 const r=reports.find(x=>x.id===a.p_report_id);if(!r)return err('P0002','No such report');
 if(name==='monthly_report_edit'){if(!['draft','in_review'].includes(r.status))return err('23514','correct it with a new version');if(r.edit_version!==a.p_edit_version)return err('40001','The report changed since you opened it');r.editorial=a.p_editorial;r.edit_version++;r.status='draft';rehash(r);return [200,{}];}
 if(name==='monthly_report_submit'){if(r.status!=='draft'||r.edit_version!==a.p_edit_version)return err('40001','stale');r.status='in_review';return [200,{}];}
 if(name==='monthly_report_approve'){
  if(r.status!=='in_review')return err('23514','not in review');if(r.content_hash!==a.p_content_hash)return err('40001','The report changed since you reviewed it');
  if(r.is_partial)return err('23514','partial preview');if(r.completeness==='incomplete'&&!a.p_accept_incomplete)return err('23514','missing sources');
  const rec=[...new Set(a.p_recipients.map(x=>x.toLowerCase()))].sort();if(!rec.every(x=>data.client_contacts.some(c=>c.email===x)))return err('23514','Not a contact of this client');
  Object.assign(r,{status:'approved',approved_at:new Date().toISOString(),approved_hash:r.content_hash,approved_destination:a.p_destination,approved_recipients:rec});return [200,{}];
 }
 if(name==='monthly_report_record_delivery'){
  if(r.status!=='approved'||a.p_destination!==r.approved_destination||JSON.stringify(a.p_recipients)!==JSON.stringify(r.approved_recipients))return err('23514','outside the approval');
  if(deliveries.some(d=>d.request_key===a.p_request_key))return [200,{reused:true}];
  if(a.p_outcome==='sent'&&deliveries.some(d=>d.report_id===r.id&&d.outcome==='sent'))return err('23505','already sent');
  deliveries.push({id:randomUUID(),report_id:r.id,client_id:r.client_id,destination:a.p_destination,recipients:a.p_recipients,outcome:a.p_outcome,detail:a.p_detail,request_key:a.p_request_key,recorded_at:new Date().toISOString()});return [200,{}];
 }
 return err('42883',`unexpected rpc ${name}`);
}
const requests=[],unexpected=[];
const upstream=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 let body='';for await(const c of req)body+=c;
 requests.push(`${req.method} ${url.pathname}?${url.searchParams}`);
 const one=(req.headers.accept??'').includes('vnd.pgrst.object');
 const eq=k=>url.searchParams.get(k)?.replace(/^eq\./,'');
 const reply=(rows,status=200)=>{
  if(!Array.isArray(rows)){res.writeHead(status,{'content-type':'application/json'});return res.end(JSON.stringify(rows));}
  const from=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??rows.length),page=rows.slice(from,from+limit);
  res.writeHead(status,{'content-type':'application/json','content-range':`${page.length?`${from}-${from+page.length-1}`:'*'}/${rows.length}`});
  res.end(req.method==='HEAD'?undefined:JSON.stringify(one?page[0]??null:page));
 };
 const t=url.pathname.replace('/rest/v1/','');
 const forBrand=[eq('client_id'),eq('id')].includes(brandClientId);
 if(url.pathname==='/auth/v1/user')return reply(user(teamId));
 if(t==='rpc/is_team')return reply(true);
 if(t.startsWith('rpc/')){const [s,b]=rpc(t.slice(4),body?JSON.parse(body):{});return reply(b,s);}
 if(t==='team_members')return reply([{id:teamId}]);
 if(t==='clients')return reply([forBrand?{...client,id:brandClientId,name:'Fictional Brand Group'}:client]);
 if(t==='client_brand_workspaces')return reply(forBrand?[{id:'b1'},{id:'b2'}]:[]);
 if(t==='client_brands')return reply(data.client_brands);
 if(t==='rank_snapshots'){const ids=(url.searchParams.get('keyword_id')??'').replace(/^in\.\(|\)$/g,'').split(',');return reply(data.rank_snapshots.filter(s=>ids.includes(s.keyword_id)));}
 if(t==='social_posts')return reply(url.searchParams.get('publish_status')==='eq.published'?data.social_published:data.social_queue);
 if(t==='map_grid_runs')return reply(data.map_grid_runs.filter(r=>r.profile_id===eq('profile_id')));
 if(t==='map_grid_checks')return reply(data.map_grid_checks.filter(c=>c.run_id===eq('run_id')));
 if(t==='gsc_snapshots')return reply(url.searchParams.get('select')==='period_end'?data.gsc_snapshots.map(s=>({period_end:s.period_end})):data.gsc_snapshots);
 if(t==='monthly_reports')return reply(reports.filter(r=>(!eq('id')||r.id===eq('id'))&&(!eq('client_id')||r.client_id===eq('client_id'))&&(!eq('period')||r.period===eq('period'))).toSorted((a,b)=>b.period.localeCompare(a.period)||a.version-b.version));
 if(t==='monthly_report_deliveries')return reply(deliveries.filter(d=>(!eq('report_id')||d.report_id===eq('report_id'))&&(!eq('client_id')||d.client_id===eq('client_id'))));
 if(t in data)return reply(data[t]);
 unexpected.push(`${req.method} ${url.pathname}`);res.writeHead(500);res.end('{}');
});
// A production build, as in client-growth-ui: NEXT_PUBLIC_* is inlined at
// build time, hence the fixed stub port.
const stubPort=Number(process.env.MONTHLY_STUB_PORT??54339);
await new Promise(resolve=>upstream.listen(stubPort,'127.0.0.1',resolve));
const port=Number(process.env.MONTHLY_UI_PORT??3442);
const appEnv={...process.env,NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${stubPort}`,NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-test-key',NEXT_TELEMETRY_DISABLED:'1'};
if(!process.env.SKIP_BUILD){
 const built=spawnSync(process.execPath,['node_modules/next/dist/bin/next','build'],{env:appEnv,stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:64*1024*1024});
 if(built.status!==0){upstream.close();throw new Error(`next build failed\n${built.stdout.slice(-4000)}\n${built.stderr.slice(-4000)}`);}
}
const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:appEnv,stdio:['ignore','pipe','pipe']});
let logs='';app.stdout.on('data',c=>logs=(logs+c).slice(-9000));app.stderr.on('data',c=>logs=(logs+c).slice(-9000));
const shots='docs/screenshots/monthly-report';mkdirSync(shots,{recursive:true});
let browser;
try{
 for(let i=0;i<120;i++){if(app.exitCode!==null)throw new Error(logs);try{await fetch(`http://127.0.0.1:${port}/login`);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 const executable=process.env.CHROME_PATH??['/usr/bin/google-chrome','/usr/bin/chromium','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
 browser=await chromium.launch({headless:true,...(executable?{executablePath:executable}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
 const part=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const expiry=Math.floor(Date.now()/1000)+3600;
 await ctx.addCookies([{name:'sb-127-auth-token',value:`base64-${part({access_token:`${part({alg:'HS256',typ:'JWT'})}.${part({sub:teamId,exp:expiry})}.fixture`,refresh_token:'fixture',expires_at:expiry,expires_in:3600,token_type:'bearer',user:user(teamId)})}`,domain:'127.0.0.1',path:'/'}]);
 const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base=`http://127.0.0.1:${port}/clients/${clientId}/reports/monthly`;

 // 1. Generate last month: a complete draft, version 1.
 await page.goto(base,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:'Monthly reports',exact:true}).waitFor({timeout:60000});
 await page.getByLabel('Month').selectOption(prev);
 await page.getByRole('button',{name:'Generate draft'}).click();
 await page.getByRole('heading',{name:/^Version 1 · Draft$/}).waitFor({timeout:60000});
 assert.equal(reports.length,1);
 const v1=reports[0];
 assert.equal(v1.is_partial,false); assert.equal(v1.snapshot.client_id,clientId);
 assert.equal(v1.snapshot.audit.foreignRowsDropped,0);
 for(const h of ['What the month shows',"Rankings on the website's own pages",'Map pack and local grid','Search Console, Analytics and Business Profile','Website inquiries','Published this month','Source health'])
  await page.getByRole('heading',{name:h,exact:true}).waitFor();
 // Third-party page at the baseline: excluded, never counted as the website.
 await page.getByText(/1 matched a third-party page at one date/).first().waitFor();
 await page.getByText('Analytics counts visits from every channel. An organic-only figure is not available.').waitFor();
 await page.getByText(/Query sample: a rolling window, not the calendar month/).waitFor();
 await page.getByRole('link',{name:'Fixture roof guide'}).waitFor();
 await page.getByText(/Roofing 1/).first().waitFor();
 await page.getByText(/2 blog drafts in review/).waitFor();
 await page.getByText(/no cause is claimed/).waitFor();
 await page.screenshot({path:`${shots}/draft-desktop.png`,fullPage:true});

 // 2. Edit the text, submit, and approve the exact version.
 await page.getByLabel(/Possible causes/).fill('Possibly the new roof guide page.');
 await page.getByRole('button',{name:'Save text'}).click();
 await page.getByText('Possibly the new roof guide page.').first().waitFor();
 assert.equal(v1.edit_version,2);
 await page.getByRole('button',{name:'Submit for review'}).click();
 await page.getByRole('heading',{name:/^Version 1 · In review$/}).waitFor();
 const reviewedHash=v1.content_hash;
 // No delivery standard recorded → incomplete: refused unless approved as such.
 await page.getByLabel(/^Recipients/).fill('Owner@Fixture.example.test');
 await page.getByRole('button',{name:'Approve version 1'}).click();
 await page.getByRole('alert').filter({hasText:/missing sources/}).waitFor();
 await page.getByLabel(/^Recipients/).fill('Owner@Fixture.example.test');
 await page.getByLabel(/Approve as an incomplete report/).check();
 await page.getByRole('button',{name:'Approve version 1'}).click();
 await page.getByRole('heading',{name:/^Version 1 · Approved$/}).waitFor();
 const approve=calls.filter(c=>c.name==='monthly_report_approve').at(-1);
 assert.equal(approve.args.p_content_hash,reviewedHash,'approval names the hash Tom reviewed');
 assert.equal(v1.approved_destination,'email'); assert.deepEqual(v1.approved_recipients,['owner@fixture.example.test']);
 // Approved: no edit form; an email draft to copy, nothing sent.
 assert.equal(await page.getByRole('button',{name:'Save text'}).count(),0);
 await page.getByText('Email draft (copy into your mail)').waitFor();

 // 3. Record the outcome: uncertain is not delivered; sent is.
 await page.getByLabel('Outcome').selectOption('uncertain');
 await page.getByRole('button',{name:'Record'}).click();
 await page.getByText(/· email · uncertain/).waitFor();
 assert.equal(await page.getByRole('heading',{name:/delivered/}).count(),0);
 await page.getByLabel('Outcome').selectOption('sent');
 await page.getByLabel('Detail').fill('Sent from Gmail');
 await page.getByRole('button',{name:'Record'}).click();
 await page.getByRole('heading',{name:/^Version 1 · Approved · delivered$/}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Record'}).count(),0,'one sent delivery per version');

 // 4. Print: the frozen version, no "not approved" banner once approved.
 await page.goto(`${base}/${v1.id}/print`,{waitUntil:'networkidle'});
 await page.getByRole('heading',{name:`Fictional Roofing Co · ${P.label}`}).waitFor();
 assert.equal(await page.getByText(/Not approved/).count(),0);
 await page.screenshot({path:`${shots}/print-approved.png`,fullPage:true});

 // 5. Regenerating an approved month needs a correction reason.
 await page.goto(base,{waitUntil:'networkidle'});
 await page.getByLabel('Month').selectOption(prev);
 await page.getByRole('button',{name:'Generate draft'}).click();
 await page.getByRole('alert').filter({hasText:/needs a reason/}).waitFor();
 await page.getByLabel('Month').selectOption(prev);
 await page.getByLabel(/Correction reason/).fill('Fixture correction');
 await page.getByRole('button',{name:'Generate draft'}).click();
 await page.getByRole('heading',{name:/^Version 2 · Draft$/}).waitFor();
 assert.equal(reports[1].supersedes_id,v1.id); assert.equal(reports[1].correction_reason,'Fixture correction');
 assert.equal(v1.status,'approved','the approved version stays until the correction is approved');
 assert.deepEqual(reports[1].editorial.causes,['Possibly the new roof guide page.'],'text carries forward');

 // 6. This month: a partial preview that can be reviewed but never approved.
 await page.goto(base,{waitUntil:'networkidle'});
 await page.getByLabel('Month').selectOption(cur);
 await page.getByRole('button',{name:'Generate draft'}).click();
 await page.getByText(/Partial month: figures run from/).waitFor({timeout:60000});
 await page.getByRole('button',{name:'Submit for review'}).click();
 await page.getByText(/A month in progress cannot be approved/).waitFor();
 assert.equal(await page.getByRole('button',{name:/Approve version/}).count(),0);
 const partial=reports.at(-1);
 await page.goto(`${base}/${partial.id}/print`,{waitUntil:'networkidle'});
 await page.getByText(/Partial preview — not the month's report/).waitFor();

 // 7. The unsaved preview, and a multi-brand client refused.
 await page.goto(`${base}/preview?period=${prev}`,{waitUntil:'networkidle'});
 await page.getByText(/Preview, not saved/).waitFor();
 await page.getByRole('heading',{name:'What the month shows'}).waitFor();
 const before=reports.length;
 await page.goto(`http://127.0.0.1:${port}/clients/${brandClientId}/reports/monthly`,{waitUntil:'networkidle'});
 await page.getByLabel('Month').selectOption(prev);
 await page.getByRole('button',{name:'Generate draft'}).click();
 await page.getByRole('alert').filter({hasText:/reports per brand website \(2\)/}).waitFor();
 assert.equal(reports.length,before);

 // Boundaries: reads are scoped to the client, no contact details are
 // requested, and the only writes are the monthly_report_* functions.
 assert.deepEqual(unexpected,[]);
 const writes=requests.filter(r=>!r.startsWith('GET ')&&!r.startsWith('HEAD '));
 assert.ok(writes.every(r=>/^POST \/rest\/v1\/rpc\/(monthly_report_(save|edit|submit|approve|record_delivery)|delivery_targets)\?/.test(r)),writes.join('\n'));
 const inquiryReads=requests.filter(r=>r.includes('/rest/v1/inquiries'));
 assert.ok(inquiryReads.length&&inquiryReads.every(r=>!/select=[^&]*(name|email|phone|message)/.test(decodeURIComponent(r))),inquiryReads.join('\n'));
 for(const t of ['keywords','rank_runs','report_measurements','inquiries','content_posts','social_posts','change_log','content_drafts','map_grid_profiles','gsc_snapshots'])
  assert.ok(requests.filter(r=>r.includes(`/rest/v1/${t}?`)).every(r=>decodeURIComponent(r).includes(`client_id=eq.${clientId}`)||decodeURIComponent(r).includes(`client_id=eq.${brandClientId}`)),`${t} must be scoped to the client`);
 assert.deepEqual(errors,[]);
 await page.setViewportSize({width:390,height:844});
 await page.goto(`${base}/${v1.id}`,{waitUntil:'networkidle'});
 await page.screenshot({path:`${shots}/approved-mobile.png`,fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
 assert.ok(overflow<=1,`no horizontal page scroll on a phone (${overflow}px)`);
 console.log(`monthly report UI: ${reports.length} versions, ${deliveries.length} delivery records, ${writes.length} function calls, fictional data`);
}finally{await browser?.close();app.kill('SIGTERM');upstream.close();}
