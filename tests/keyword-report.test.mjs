// FIXTURES ONLY: every keyword, URL and number below is invented for edge cases.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {keywordReport,organicState,organicMovement,nextWeekly,gscMonths,ga4Months,gbpMonths,gbpTotals,compareMonths,inquirySummary,samePage,trackerRuns} from '../src/lib/keyword-report.ts';

const site='example-roofer.test';
const kw=(id,extra={})=>({id,keyword:`fixture ${id}`,city:null,intent:'commercial',priority:'p2',is_money:false,target_url:`https://${site}/services/${id}`,service:'Fixture service',segment:null,...extra});
const run=(id,started_at,status='complete')=>({id,status,started_at,completed_at:started_at,checks_count:2,error:`dataforseo · 2/2 answered`});
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
  {period:'2026-08-01',period_end:'2026-08-31',created_at:'2026-10-01T00:00:00Z',data:{values:{search_clicks:50,search_impressions:900}}},
  {period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-01T00:00:00Z',data:{values:{search_clicks:60,search_impressions:800}}},
  {period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-12T00:00:00Z',data:{values:{search_clicks:64,search_impressions:810}}},
 ]);
 assert.equal(gsc.length,2);const c=compareMonths(gsc,'search_clicks');assert.equal(c.latest.values.search_clicks,64);assert.equal(c.vsPrevious,14);
 const ga4=ga4Months([
  {period:'2026-09-01',period_end:'2026-09-30',created_at:'2026-10-02T00:00:00Z',data:{coverage:'complete_month',values:{website_sessions:113}}},
  {period:'2026-10-01',period_end:'2026-10-15',created_at:'2026-10-19T00:00:00Z',data:{coverage:'month_to_date',values:{website_sessions:63}}},
  {period:'2026-10-01',period_end:'2026-10-16',created_at:'2026-10-20T00:00:00Z',data:{coverage:'month_to_date',values:{website_sessions:79}}},
 ]);
 assert.deepEqual(ga4.map(p=>[p.period_end,p.complete,p.values.website_sessions]),[['2026-09-30',true,113],['2026-10-16',false,79]]);
 assert.equal(compareMonths(ga4,'website_sessions').latest.period,'2026-09-01','month to date is never compared with a full month');
 assert.deepEqual(gbpTotals({daily:{CALL_CLICKS:[{value:2},{value:0}],WEBSITE_CLICKS:[{value:1}]}}),{calls:2,website:1});
 assert.deepEqual(gbpTotals(null),{});
 assert.equal(gbpMonths([{period:'2026-09-01',period_end:'2026-09-30',created_at:'x',data:{daily:{}}}])[0].values.calls,undefined);
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
