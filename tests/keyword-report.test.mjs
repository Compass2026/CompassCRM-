// FIXTURES ONLY: every keyword, URL and number below is invented for edge cases.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keywordReport,organicState,organicMovement,nextWeekly,gscMonths,ga4Months,gbpMonths,gbpTotals,compareMonths,inquirySummary,samePage,trackerRuns,resolveScope,trackerHealth,scanComparability,baselineRun} from '../src/lib/keyword-report.ts';
import {readAll} from '../src/lib/keyword-report-data.ts';

const site='example-roofer.test';
const kw=(id,extra={})=>({id,keyword:`fixture ${id}`,city:null,intent:'commercial',priority:'p2',is_money:false,target_url:`https://${site}/services/${id}`,service:'Fixture service',segment:null,...extra});
const run=(id,started_at,status='complete',triggered_by='cron')=>({id,status,started_at,completed_at:started_at,checks_count:2,error:`dataforseo · 2/2 answered`,triggered_by});
const obs=(keyword_id,run_id,recorded_at,position,url_ranked,extra={})=>({keyword_id,location_id:'home',result_type:'organic',position,url_ranked,recorded_at,run_id,...extra});
const NOW='2026-10-20T12:00:00Z';

test('only the website host counts as organic rank; names on other hosts are third-party, null is not found',()=>{
 assert.equal(organicState({position:3,url_ranked:`https://www.${site}/x`},site),'ranked');
 assert.equal(organicState({position:3,url_ranked:`https://blog.${site}/x`},site),'ranked');
 assert.equal(organicState({position:1,url_ranked:'https://www.facebook.com/FixtureRoofing/'},site),'third_party');
 assert.equal(organicState({position:1,url_ranked:`https://${site}.evil.test/`},site),'third_party');
 assert.equal(organicState({position:null,url_ranked:null},site),'not_found');
 assert.equal(organicState({position:2,url_ranked:`https://${site}/`},null),'third_party');
});

test('movement never turns not-found or third-party into a number',()=>{
 const a=(state,position,d='2026-09-14')=>({state,position,location_id:'home',recorded_at:d});
 assert.deepEqual(organicMovement(a('ranked',9),a('ranked',2,'2026-10-19')),{kind:'up',change:7,label:'Up 7'});
 assert.equal(organicMovement(a('ranked',2),a('ranked',9,'2026-10-19')).label,'Down 7');
 assert.equal(organicMovement(a('not_found',null),a('ranked',12,'2026-10-19')).label,'Entered the top 100 at #12');
 assert.equal(organicMovement(a('ranked',4),a('not_found',null,'2026-10-19')).kind,'dropped');
 assert.equal(organicMovement(a('ranked',4),a('third_party',1,'2026-10-19')).kind,'not_comparable');
 assert.equal(organicMovement(a('ranked',4),{...a('ranked',3,'2026-10-19'),location_id:'other'}).kind,'not_comparable');
 assert.equal(organicMovement(a('ranked',4),a('ranked',3)).kind,'awaiting');
 assert.equal(organicMovement(null,null).kind,'awaiting');
});

test('stable cohort excludes third-party and missing keywords and discloses them; top counts use verified site results only',()=>{
 const keywords=[kw('a'),kw('b'),kw('c'),kw('d'),kw('e')];
 const runs=[run('r1','2026-09-14T06:00:00Z'),run('r2','2026-10-19T06:00:00Z'),{...run('r0','2026-09-21T06:00:00Z','failed'),error:'dataforseo · results never arrived (3 h)'},{id:'bl',status:'complete',started_at:'2026-10-01T07:00:00Z',completed_at:null,checks_count:531,error:''}];
 const observations=[
  obs('a','r1','2026-09-14T06:00:00Z',9,`https://${site}/services/a`), obs('a','r2','2026-10-19T06:00:00Z',2,`https://${site}/services/a`),
  obs('b','r1','2026-09-14T06:00:00Z',3,`https://${site}/`), obs('b','r2','2026-10-19T06:00:00Z',1,'https://www.mapquest.com/fixture'),
  obs('c','r1','2026-09-14T06:00:00Z',null,null), obs('c','r2','2026-10-19T06:00:00Z',15,`https://${site}/services/c`),
  obs('d','r1','2026-09-14T06:00:00Z',5,`https://${site}/services/d`),
  obs('e','r1','2026-09-14T06:00:00Z',null,null), obs('e','r2','2026-10-19T06:00:00Z',null,null),
  // Another client's keyword is ignored even if handed in by mistake.
  obs('zz','r2','2026-10-19T06:00:00Z',1,`https://${site}/`),
 ];
 const r=keywordReport({keywords,observations,runs,siteHost:site,now:NOW});
 assert.deepEqual(r.perRun.map(p=>[p.run.id,p.keywords,p.thirdParty,p.notFound,p.top3,p.top10,p.top20]),[['r1',5,0,2,1,3,3],['r2',4,1,1,1,1,2]]);
 const c=r.cohort;
 assert.equal(c.size,3);assert.equal(c.excludedThirdParty,1);assert.equal(c.excludedMissing,1);
 assert.equal(c.improved,1);assert.equal(c.entered,1);assert.equal(c.absentBoth,1);assert.equal(c.declined,0);
 assert.equal(c.top10Before,1);assert.equal(c.top10After,1);
 assert.equal(r.lastFailure.id,'r0');assert.equal(r.lastSuccess.id,'r2');
 const row=Object.fromEntries(r.rows.map(x=>[x.id,x]));
 assert.equal(row.b.latest.state,'third_party');assert.equal(row.b.movement.kind,'not_comparable');
 assert.equal(row.d.status,'stale','a keyword missing from the latest complete run is stale');
 assert.equal(row.a.status,'current');assert.equal(row.c.pageMismatch,false);
 assert.ok(!trackerRuns(runs,observations).some(x=>x.id==='bl'),'BrightLocal runs are not DataForSEO checks');
});

test('wrong ranking page is flagged for review, not remapped; duplicates and future rows are ignored',()=>{
 const r=keywordReport({keywords:[kw('a',{target_url:`https://${site}/services/roof-repair/`})],runs:[run('r1','2026-10-19T06:00:00Z')],siteHost:site,now:NOW,observations:[
  obs('a','r1','2026-10-19T06:00:00Z',4,`https://${site}/blog/post`), obs('a','r1','2026-10-19T06:00:00Z',4,`https://${site}/blog/post`),
  obs('a','r1','2026-11-19T06:00:00Z',1,`https://${site}/services/roof-repair`)]});
 assert.equal(r.duplicates,1);assert.equal(r.rows[0].pageMismatch,true);assert.equal(r.rows[0].latest.url_ranked,`https://${site}/blog/post`);
 assert.equal(samePage(`https://${site}/a/`,`https://${site}/a`),true);
});

test('no checks are pending while a run is open and not-checked otherwise; old results are stale',()=>{
 const pending=keywordReport({keywords:[kw('a')],observations:[],runs:[{...run('r1','2026-10-20T06:00:00Z','running'),error:'dataforseo · posted 1/1'}],siteHost:site,now:NOW});
 assert.equal(pending.rows[0].status,'pending');assert.equal(pending.running.id,'r1');
 assert.equal(keywordReport({keywords:[kw('a')],observations:[],runs:[],siteHost:site,now:NOW}).rows[0].status,'not_checked');
 const old=keywordReport({keywords:[kw('a')],observations:[obs('a','r1','2026-09-01T06:00:00Z',3,`https://${site}/`)],runs:[run('r1','2026-09-01T06:00:00Z')],siteHost:site,now:NOW});
 assert.equal(old.rows[0].status,'stale');
});

test('next weekly slot is computed in UTC and never returns the current instant',()=>{
 assert.equal(nextWeekly(4,14,'2026-10-20T19:00:00Z'),'2026-10-22T14:00:00.000Z');
 assert.equal(nextWeekly(1,6,'2026-10-19T06:00:00Z'),'2026-10-26T06:00:00.000Z');
 assert.equal(nextWeekly(1,6,'2026-10-19T05:59:00Z'),'2026-10-19T06:00:00.000Z');
});

test('monthly sources: complete months only for comparisons, latest receipt per period wins, missing GBP metric is absent not zero',()=>{
 const gsc=gscMonths([
  {property:'p',period:'2026-08-01',period_end:'2026-08-31',created_at:'2026-10-01T00:00:00Z',data:{values:{search_clicks:50,search_impressions:900}}},
  {property:'p',period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-01T00:00:00Z',data:{values:{search_clicks:60,search_impressions:800}}},
  {property:'p',period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-12T00:00:00Z',data:{values:{search_clicks:64,search_impressions:810}}},
 ],'p');
 assert.equal(gsc.length,2);const c=compareMonths(gsc,'search_clicks');assert.equal(c.latest.values.search_clicks,64);assert.equal(c.vsPrevious,14);
 const ga4=ga4Months([
  {property:'g',period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-02T00:00:00Z',data:{host:'site.test',coverage:'complete_month',values:{website_sessions:113}}},
  {property:'g',period:'2026-10-01',period_end:'2026-10-15',created_at:'2026-10-19T00:00:00Z',data:{host:'site.test',coverage:'month_to_date',values:{website_sessions:63}}},
  {property:'g',period:'2026-10-01',period_end:'2026-10-16',created_at:'2026-10-20T00:00:00Z',data:{host:'www.site.test',coverage:'month_to_date',values:{website_sessions:79}}},
 ],'g','site.test');
 assert.deepEqual(ga4.map(p=>[p.period_end,p.complete,p.values.website_sessions]),[['2026-09-30',true,113],['2026-10-16',false,79]]);
 assert.equal(compareMonths(ga4,'website_sessions').latest.period,'2026-09-01','month to date is never compared with a full month');
 assert.deepEqual(gbpTotals({daily:{CALL_CLICKS:[{value:2},{value:0}],WEBSITE_CLICKS:[{value:1}]}}),{calls:2,website:1});
 assert.deepEqual(gbpTotals(null),{});
 assert.equal(gbpMonths([{account_id:'a',location_id:'locations/1',period:'2026-09-01',period_end:'2026-09-30',created_at:'x',data:{daily:{}}}],{accountId:'a',locationId:'locations/1'})[0].values.calls,undefined);
});

test('inquiries are counted by Central month, page and form with no source attribution',()=>{
 const s=inquirySummary([
  {submitted_at:'2026-10-01T03:00:00Z',service_type:'Lighting quote',page_url:`https://${site}/quote`,source:'Website'},
  {submitted_at:'2026-10-12T16:50:00Z',service_type:'Homepage estimate form',page_url:`https://${site}/`,source:'Website'},
  {submitted_at:'2026-10-13T03:28:00Z',service_type:null,page_url:null,source:'Website'},
 ]);
 assert.equal(s.total,3);
 assert.deepEqual(s.byMonth,[['2026-09',1],['2026-10',2]],'00:00-04:59 UTC on the 1st is still the prior month in Central');
 assert.ok(s.byPage.some(([p])=>p==='Page not recorded'));assert.ok(s.byForm.some(([f])=>f==='Form not named'));
 assert.ok(!('keyword' in s)&&!('channel' in s));
});

const SITE='https://www.site.test',acct='0123456789abcdef01234567';
const gbpRow=(loc)=>({publish_account_id:acct,publish_page_id:loc,external_account_id:loc});
test('scope: one website, property, host and location; anything else is unavailable, never a fallback',()=>{
 const ok=resolveScope({websiteUrl:SITE,gscProperty:'sc-domain:site.test',ga4Property:'properties/1',siteUrls:['https://site.test/',null],brandCount:0,gbpBindings:[gbpRow('locations/1')]});
 assert.equal(ok.siteHost,'site.test');assert.equal(ok.gscProperty,'sc-domain:site.test');assert.equal(ok.ga4Property,'properties/1');assert.deepEqual(ok.gbp,{accountId:acct,locationId:'locations/1'});
 assert.deepEqual(Object.values(ok.problems).filter(Boolean),[]);
 const two=resolveScope({websiteUrl:SITE,gscProperty:'p',ga4Property:'g',siteUrls:['https://other.test'],brandCount:0,gbpBindings:[]});
 assert.equal(two.siteHost,null);assert.match(two.problems.site,/2 different websites/);assert.equal(two.ga4Property,null,'no Analytics without one host');
 const brands=resolveScope({websiteUrl:SITE,gscProperty:'p',ga4Property:'g',siteUrls:[],brandCount:3,gbpBindings:[gbpRow('locations/1')]});
 assert.equal(brands.siteHost,null);assert.equal(brands.gscProperty,null);assert.equal(brands.gbp,null);assert.match(brands.problems.brands,/per brand/);
 const locs=resolveScope({websiteUrl:SITE,gscProperty:null,ga4Property:null,siteUrls:[],brandCount:0,gbpBindings:[gbpRow('locations/1'),gbpRow('locations/2'),{publish_account_id:'bad',publish_page_id:'locations/3',external_account_id:'locations/3'}]});
 assert.equal(locs.gbp,null);assert.match(locs.problems.gbp,/2 Business Profile locations/);assert.match(locs.problems.gsc,/No Search Console property/);
});

test('monthly series keep only the resolved property, host and location; two identities in one month never overwrite',()=>{
 const m=(property,clicks,created_at='2026-10-12T00:00:00Z')=>({property,period:'2026-09-01',period_end:'2026-09-30',created_at,data:{values:{search_clicks:clicks}}});
 assert.deepEqual(gscMonths([m('https://site.test/',64),m('sc-domain:other.test',900,'2026-10-13T00:00:00Z')],'https://site.test/').map(p=>p.values.search_clicks),[64],'wrong property excluded even when newer');
 assert.deepEqual(gscMonths([m('a',1)],null),[],'no property, no series');
 const g=(host,sessions)=>({property:'properties/1',period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-02T00:00:00Z',data:{host,coverage:'complete_month',values:{website_sessions:sessions}}});
 assert.deepEqual(ga4Months([g('site.test',113),g('brand-two.test',5000)],'properties/1','site.test').map(p=>p.values.website_sessions),[113],'same property, wrong host excluded');
 assert.deepEqual(ga4Months([{...g('site.test',7),property:'properties/2'}],'properties/1','site.test'),[],'wrong property excluded');
 assert.deepEqual(ga4Months([{...g(undefined,7)}],'properties/1','site.test'),[],'a receipt without a host is not assumed to be this site');
 const b=(account_id,location_id,calls)=>({account_id,location_id,period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-12T00:00:00Z',data:{daily:{CALL_CLICKS:[{value:calls}]}}});
 assert.deepEqual(gbpMonths([b(acct,'locations/1',15),b(acct,'locations/2',99),b('ffffffffffffffffffffffff','locations/1',7)],{accountId:acct,locationId:'locations/1'}).map(p=>p.values.calls),[15]);
});

test('health: a failure newer than the last success is failed (success kept); old success is stale; running and partial are distinct',()=>{
 const a=(at,outcome,detail=null)=>({at,finishedAt:at,outcome,detail});
 const h=trackerHealth({attempts:[a('2026-10-12T06:00:00Z','complete'),a('2026-10-19T06:00:00Z','failed','results never arrived')],configured:true,staleDays:14,now:'2026-10-20T00:00:00Z'});
 assert.equal(h.state,'failed');assert.equal(h.lastSuccess.at,'2026-10-12T06:00:00Z');assert.equal(h.lastProblem.detail,'results never arrived');
 assert.equal(trackerHealth({attempts:[a('2026-09-01T00:00:00Z','complete')],configured:true,staleDays:14,now:'2026-10-20T00:00:00Z'}).state,'stale','old comparable grid is stale, not current');
 assert.equal(trackerHealth({attempts:[a('2026-10-19T00:00:00Z','complete'),a('2026-10-20T00:00:00Z','running')],configured:true,staleDays:14,now:'2026-10-20T01:00:00Z'}).state,'running');
 assert.equal(trackerHealth({attempts:[a('2026-10-19T00:00:00Z','partial')],configured:true,staleDays:14,now:'2026-10-20T00:00:00Z'}).state,'partial');
 assert.equal(trackerHealth({attempts:[],configured:true,staleDays:14,now:'2026-10-20T00:00:00Z'}).state,'missing');
 assert.equal(trackerHealth({attempts:[],configured:false,staleDays:14,now:'2026-10-20T00:00:00Z'}).state,'unconfigured');
 assert.equal(trackerHealth({attempts:[a('2026-10-19T00:00:00Z','failed'),a('2026-10-19T12:00:00Z','complete')],configured:true,staleDays:14,now:'2026-10-20T00:00:00Z'}).state,'current','a success after the failure recovers');
});

test('map scans compare only when business, search mode, zoom, geometry, points and keywords are known and identical',()=>{
 const pts=[{lat:1,lng:1},{lat:1,lng:2}],kws=[{id:'k',keyword:'roofer'}],geometry={version:'local-multiscale-v1',center:pts[0]};
 const cfg={target_place_id:'place',points:pts,keywords:kws,zoom:13,search_this_area:false,geometry};
 assert.deepEqual(scanComparability({profile_id:'p',config:cfg},{profile_id:'p',config:{...cfg}}),{comparable:true,reasons:[]});
 const legacy=scanComparability({config:{...cfg,geometry:null}},{config:{...cfg,geometry:null,points:[pts[0]]}});
 assert.equal(legacy.comparable,false);assert.ok(legacy.reasons.includes('grid geometry unknown for both scans'));assert.ok(legacy.reasons.includes('different points'));
 assert.ok(scanComparability({config:{...cfg,search_this_area:undefined}},{config:cfg}).reasons.includes('search mode unknown for the earlier scan'));
 assert.ok(scanComparability({config:cfg},{config:{...cfg,zoom:null}}).reasons.includes('map zoom unknown for the later scan'));
 assert.ok(scanComparability({config:cfg},{config:{...cfg,zoom:14}}).reasons.includes('different map zoom'));
 assert.ok(scanComparability({profile_id:'p',config:cfg},{profile_id:'q',config:cfg}).reasons.includes('different scan profile'));
});

test('baseline is the first scheduled run; earlier manual runs are shown but not used; late keywords are flagged',()=>{
 const keywords=[kw('a'),kw('late')];
 const runs=[run('m','2026-09-14T01:54:00Z','complete','manual'),run('c1','2026-09-14T06:00:00Z'),run('c2','2026-10-19T06:00:00Z')];
 assert.equal(baselineRun(runs).id,'c1');assert.equal(baselineRun([runs[0]]).id,'m','no scheduled run: first complete');
 const r=keywordReport({keywords,runs,siteHost:site,now:NOW,observations:[
  obs('a','m','2026-09-14T01:54:00Z',30,`https://${site}/services/a`),obs('a','c1','2026-09-14T06:00:00Z',9,`https://${site}/services/a`),obs('a','c2','2026-10-19T06:00:00Z',2,`https://${site}/services/a`),
  obs('late','c2','2026-10-19T06:00:00Z',5,`https://${site}/services/late`)]});
 const row=Object.fromEntries(r.rows.map(x=>[x.id,x]));
 assert.equal(row.a.baseline.run_id,'c1');assert.equal(row.a.movement.label,'Up 7');assert.equal(row.a.baselineLate,false);
 assert.equal(row.late.baselineLate,true);assert.equal(row.late.movement.kind,'awaiting');
 assert.deepEqual(r.perRun.map(p=>[p.run.id,p.beforeBaseline]),[['m',true],['c1',false],['c2',false]]);
 assert.equal(r.cohort.baselineRun.id,'c1');assert.equal(r.cohort.size,1);assert.equal(r.cohort.excludedMissing,1);
 assert.deepEqual(r.attempts.map(a=>a.outcome),['complete','complete','complete']);
});

test('complete reads: every page fetched to the exact count; a short read, a missing count or an over-limit table is an error',async()=>{
 const table=Array.from({length:2345},(_,i)=>i);
 const serve=(rows,{cap=1000,count=rows.length,error=null}={})=>(from,to)=>Promise.resolve(error?{data:null,error,count:null}:{data:rows.slice(from,Math.min(to+1,from+cap)),error:null,count});
 assert.equal((await readAll(serve(table))).rows.length,2345);
 assert.equal((await readAll(serve([]))).rows.length,0);
 assert.equal((await readAll(serve(table,{cap:500}))).error.code,'incomplete_read','a server row cap below the page size is detected, not truncated');
 assert.equal((await readAll(serve(table,{count:null}))).error.code,'count_unavailable');
 assert.equal((await readAll(serve(table),1000)).error.code,'over_limit');
 assert.equal((await readAll(serve(table,{error:{code:'PGRST201',message:'ambiguous'}}))).error.code,'PGRST201');
});
