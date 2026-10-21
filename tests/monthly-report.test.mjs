// FIXTURES ONLY: every client, keyword, URL and number below is invented.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildMonthlyReport,monthOfPeriod,reportCutoff,reportPeriods,localDate,REFERENCE_STANDARD} from '../src/lib/monthly-report.ts';
import {resolveScope} from '../src/lib/keyword-report.ts';

const C='client-a', OTHER='client-b', site='example-roofer.test';
const scope=resolveScope({websiteUrl:`https://${site}`,gscProperty:`https://${site}/`,ga4Property:'properties/1',siteUrls:[],brandCount:0,
  gbpBindings:[{publish_account_id:'a'.repeat(24),publish_page_id:'locations/9',external_account_id:'locations/9'}]});
const kw=(id,extra={})=>({id,keyword:`fixture ${id}`,city:null,intent:'commercial',priority:'p2',is_money:false,target_url:null,service:null,segment:null,...extra});
const run=(id,started_at,status='complete')=>({id,status,started_at,completed_at:started_at,checks_count:2,error:'dataforseo · 2/2 answered',triggered_by:'cron'});
const obs=(keyword_id,run_id,recorded_at,position,url,extra={})=>({keyword_id,location_id:'home',result_type:'organic',position,url_ranked:url,recorded_at,run_id,...extra});
const own=p=>`https://${site}/${p}`;
const m=(metric,scope,source,report_period,window_start,window_end,value,sequence,extra={})=>({client_id:C,metric,scope,source,status:'measured',value,report_period,window_start,window_end,sequence,created_at:'2026-10-12T00:00:00Z',...extra});
const GSC='Google Search Console property totals';
const base=(over={})=>({
  client:{id:C,name:'Fixture Roofing',website_url:`https://${site}`},
  brand:{primary:'#123456',tagline:null},
  scope,
  keywords:[kw('k1'),kw('k2'),kw('k3')],
  observations:[],runs:[],grids:[],measurements:[],querySample:[],inquiries:[],
  inquiryCapture:{sources:1,enabled:1},
  work:{blogs:[],social:[],refreshes:[],blogDraftsInReview:0,socialInReview:{facebook:0,gbp:0},socialApprovedUnpublished:0,socialFailed:0,refreshesUnverified:0},
  targets:null,
  ...over,
});

test('Chicago month bounds are half-open and DST-aware', () => {
  assert.deepEqual([monthOfPeriod('2026-10-01').start,monthOfPeriod('2026-10-01').end],['2026-10-01T05:00:00.000Z','2026-11-01T05:00:00.000Z']);
  // DST ends Nov 1 2026: November starts on CDT and ends on CST.
  assert.deepEqual([monthOfPeriod('2026-11').start,monthOfPeriod('2026-11').end],['2026-11-01T05:00:00.000Z','2026-12-01T06:00:00.000Z']);
  // DST starts Mar 8 2026.
  assert.deepEqual([monthOfPeriod('2026-03-01').start,monthOfPeriod('2026-03-01').end],['2026-03-01T06:00:00.000Z','2026-04-01T05:00:00.000Z']);
  assert.equal(monthOfPeriod('2027-01-01').previous,'2026-12-01');
  assert.equal(monthOfPeriod('2026-02-01').lastDay,'2026-02-28');
  // 23:30 on Oct 31 in Chicago is Nov 1 in UTC: still October.
  assert.equal(localDate('2026-11-01T04:30:00Z'),'2026-10-31');
  assert.throws(()=>monthOfPeriod('2026-13-01'));
});

test('cutoff: now inside the month (partial), the month end once it is over', () => {
  assert.equal(reportCutoff('2026-10-01','2026-10-21T20:35:12.345Z'),'2026-10-21T20:35:12.000Z');
  assert.equal(reportCutoff('2026-09-01','2026-10-21T20:35:12Z'),'2026-10-01T05:00:00.000Z');
  assert.throws(()=>reportCutoff('2026-11-01','2026-10-21T20:35:12Z'));
  assert.deepEqual(reportPeriods('2026-11-01T04:30:00Z',3),['2026-10-01','2026-09-01','2026-08-01']);
});

test('month-end ranks use only fresh checks; a stale September check is not substituted', () => {
  const r=buildMonthlyReport(base({
    runs:[run('b','2026-09-14T06:00:00Z'),run('o1','2026-10-05T06:00:00Z'),run('o2','2026-10-19T06:00:00Z')],
    observations:[
      obs('k1','b','2026-09-14T06:10:00Z',12,own('a')),obs('k2','b','2026-09-14T06:10:00Z',null,null),obs('k3','b','2026-09-14T06:10:00Z',4,'https://www.yelp.com/biz/x'),
      obs('k1','o2','2026-10-19T06:10:00Z',7,own('a')),obs('k2','o2','2026-10-19T06:10:00Z',18,own('b')),obs('k3','o2','2026-10-19T06:10:00Z',3,own('c')),
    ],
  }),'2026-10-01','2026-10-21T20:00:00Z');
  const o=r.report.rankings.organic;
  // Sep 14 is 16.9 days before the Oct 1 05:00Z month end: outside 14 days.
  assert.equal(o.anchors[1].eligible,0);
  assert.match(o.vsPrevious.unavailable,/No end of september 2026 check within 14 days/i);
  assert.equal(o.anchors[2].top10,2); assert.equal(o.anchors[2].top20,3);
  // vs baseline: k3 baseline was a third-party page → excluded, never a rank.
  assert.equal(o.vsBaseline.comparable,2); assert.equal(o.vsBaseline.excludedThirdParty,1);
  assert.equal(o.vsBaseline.improved,1); assert.equal(o.vsBaseline.entered,1);
  assert.deepEqual(o.vsBaseline.top10,[0,1]);
  assert.equal(r.partial,true); assert.equal(r.completeness,'incomplete');
});

test('the month-end boundary is half-open, and checks after the cutoff are ignored', () => {
  const r=buildMonthlyReport(base({
    keywords:[kw('k1')],
    runs:[run('a','2026-09-28T06:00:00Z'),run('z','2026-10-01T05:00:00Z')],
    observations:[obs('k1','a','2026-09-28T06:10:00Z',9,own('a')),obs('k1','z','2026-10-01T05:00:00Z',2,own('a'))],
  }),'2026-09-01','2026-10-21T00:00:00Z');
  // The Oct 1 05:00Z check is October's; September ends with #9.
  assert.equal(r.report.rankings.organic.anchors[2].ranked,1);
  assert.equal(r.report.rankings.organic.anchors[2].top3,0);
  assert.deepEqual(r.report.rankings.organic.anchors[2].checkedOn,['2026-09-28']);
  // Same rule for inquiries, posts and dated blog posts at the month's edge.
  const edge=buildMonthlyReport(base({
    inquiries:[{client_id:C,submitted_at:'2026-10-01T05:00:00Z',service_type:null,page_url:null,source:null}],
    work:{...base().work,blogs:[{id:'b',client_id:C,title:'Oct 1',url:null,date:'2026-10-01',service:null,segment:null}],
      social:[{id:'s',client_id:C,platform:'facebook',title:'s',url:null,date:'2026-10-01T05:00:00Z',service:null,segment:null}]},
  }),'2026-09-01','2026-10-21T00:00:00Z');
  assert.equal(edge.report.inquiries.total,0);
  assert.ok(edge.report.work.rows.every(x=>x.completed===0));
});

test('a keyword checked from a different location is not comparable', () => {
  const r=buildMonthlyReport(base({
    keywords:[kw('k1')],
    runs:[run('b','2026-10-02T06:00:00Z'),run('c','2026-10-09T06:00:00Z')],
    observations:[obs('k1','b','2026-10-02T06:10:00Z',5,own('a')),obs('k1','c','2026-10-09T06:10:00Z',2,own('a'),{location_id:'other'})],
  }),'2026-10-01','2026-10-12T00:00:00Z');
  assert.equal(r.report.rankings.organic.vsBaseline.excludedLocation,1);
  assert.equal(r.report.rankings.organic.vsBaseline.comparable,0);
});

test('provider windows: complete months only for Search Console, labelled month to date for Analytics, one identity each', () => {
  const ga4Scope=c=>`GA4 properties/1 | ${site} | America/Chicago | ${c}`;
  const r=buildMonthlyReport(base({measurements:[
    m('search_clicks',`Search Console https://${site}/ | web search | complete calendar months`,GSC,'2026-09-01','2026-09-01','2026-09-30',120,1),
    m('search_impressions',`Search Console https://${site}/ | web search | complete calendar months`,GSC,'2026-09-01','2026-09-01','2026-09-30',4000,2),
    // A rolling 28-day window filed under October is never the October month.
    m('search_clicks',`Search Console https://${site}/ | web search | rolling`,GSC,'2026-10-01','2026-09-15','2026-10-12',999,3),
    // Another property is never read.
    m('search_clicks','Search Console https://other.test/ | web search | complete calendar months',GSC,'2026-10-01','2026-10-01','2026-10-31',555,4),
    m('website_sessions',ga4Scope('month_to_date'),'Google Analytics 4','2026-10-01','2026-10-01','2026-10-10',50,5),
    m('website_sessions',ga4Scope('month_to_date'),'Google Analytics 4','2026-10-01','2026-10-01','2026-10-17',80,6),
    m('website_sessions',ga4Scope('complete_month'),'Google Analytics 4','2026-09-01','2026-09-01','2026-09-30',200,7),
    m('gbp_views','Google Business Profile locations/9 | complete calendar months','Google Business Profile via Zernio','2026-09-01','2026-09-01','2026-09-30',300,8),
  ]}),'2026-10-01','2026-10-21T20:00:00Z');
  const t=r.report.traffic;
  assert.deepEqual(t.gsc.current,{});
  assert.equal(t.gsc.previous.search_clicks.value,120);
  assert.equal(t.ga4.current.coverage,'month_to_date');
  assert.equal(t.ga4.current.values.website_sessions.value,80);
  assert.equal(t.ga4.current.values.website_sessions.window_end,'2026-10-17');
  assert.equal(t.ga4.previous.coverage,'complete_month');
  assert.equal(t.ga4.organicSplit,null);
  assert.deepEqual(t.gbp.current,{}); assert.equal(t.gbp.previous.gbp_views.value,300);
  assert.ok(r.exceptions.some(e=>e.source==='Search Console' && /after the month ends/.test(e.problem)));
  assert.ok(r.exceptions.some(e=>e.source==='Google Analytics' && /2026-10-17/.test(e.problem)));
});

test('client isolation: another client\'s rows never reach the report, and are counted in the audit', () => {
  const r=buildMonthlyReport(base({
    measurements:[m('search_clicks',`Search Console https://${site}/ | web search | complete calendar months`,GSC,'2026-09-01','2026-09-01','2026-09-30',77,1,{client_id:OTHER})],
    inquiries:[{client_id:OTHER,submitted_at:'2026-09-10T15:00:00Z',service_type:'Quote',page_url:null,source:'Form'}],
    work:{...base().work,blogs:[{id:'x',client_id:OTHER,title:'Other',url:null,date:'2026-09-05',service:null,segment:null}]},
  }),'2026-09-01','2026-10-21T00:00:00Z');
  assert.deepEqual(r.report.traffic.gsc.current,{});
  assert.equal(r.report.inquiries.total,0);
  assert.equal(r.report.work.rows[0].completed,0);
  assert.equal(r.audit.foreignRowsDropped,3);
  assert.equal(r.client_id,C);
});

test('inquiries: counts by source and form, nothing personal, tests not excludable', () => {
  // Rows as if a loader had leaked contact fields: none may reach the snapshot.
  const i=(at,source,form)=>({client_id:C,submitted_at:at,service_type:form,page_url:`https://${site}/contact?ref=jane`,source,name:'Jane Fixture',email:'jane@fixture.test',phone:'5550100',message:'Call me'});
  const r=buildMonthlyReport(base({inquiries:[
    i('2026-09-30T12:00:00Z','Website form','Roof quote'),
    i('2026-10-01T04:59:00Z','Website form','Roof quote'), // Sep 30 23:59 Chicago: September
    i('2026-10-02T15:00:00Z',null,'Lighting'),
    i('2026-10-20T15:00:00Z','Website form','Roof quote'),
  ]}),'2026-10-01','2026-10-21T00:00:00Z');
  assert.equal(r.report.inquiries.total,2);
  assert.equal(r.report.inquiries.previousMonth,2);
  assert.deepEqual(r.report.inquiries.bySource,[['Source not recorded',1],['Website form',1]]);
  assert.equal(r.report.inquiries.testClassification,'none');
  const json=JSON.stringify(r);
  for (const v of ['Jane Fixture','jane@fixture.test','5550100','Call me','ref=jane']) assert.ok(!json.includes(v),`snapshot must not carry ${v}`);
  assert.deepEqual(r.report.inquiries.byPage,[['/contact',2]]);
});

test('work: published only, by segment, against the recorded standard or the reference one', () => {
  const s=(id,platform,date,segment)=>({id,client_id:C,platform,title:id,url:`https://social.test/${id}`,date,service:null,segment});
  const input=base({work:{blogs:[{id:'b1',client_id:C,title:'Blog',url:own('blog/1'),date:'2026-10-07',service:null,segment:'Roofing'}],
    social:[s('f1','facebook','2026-10-11T02:46:00Z','Roofing'),s('g1','google_business','2026-10-15T16:00:00Z','Roofing'),s('g2','google_business','2026-10-15T16:35:00Z','Lighting'),
      s('g0','google_business','2026-10-01T04:30:00Z','Lighting')], // Sep 30 in Chicago: not October
    refreshes:[],blogDraftsInReview:8,socialInReview:{facebook:20,gbp:7},socialApprovedUnpublished:3,socialFailed:1,refreshesUnverified:2}});
  const r=buildMonthlyReport(input,'2026-10-01','2026-10-21T20:00:00Z');
  const row=d=>r.report.work.rows.find(x=>x.deliverable===d);
  assert.equal(r.report.work.standard.recorded,false);
  assert.equal(row('blog_posts').target,REFERENCE_STANDARD.blog_posts);
  assert.equal(row('blog_posts').completed,1);
  assert.equal(row('gbp_posts').completed,2);
  assert.deepEqual(row('gbp_posts').bySegment,[['Lighting',1],['Roofing',1]]);
  assert.equal(r.report.work.notCounted.blogDraftsInReview,8);
  assert.ok(r.exceptions.some(e=>e.source==='Delivery standard'));
  assert.equal(r.defaultEditorial.actions.length,3);
  assert.ok(r.defaultEditorial.actions.every(a=>a.action && a.reason && a.owner));
  const recorded=buildMonthlyReport({...input,targets:['blog_posts','facebook_posts','gbp_posts','page_refreshes'].map(d=>({deliverable:d,target:d==='page_refreshes'?2:6,completed:0,planned:0,unverified:0,standard_version:3,unit_kind:'client'}))},'2026-10-01','2026-10-21T20:00:00Z');
  assert.equal(recorded.report.work.standard.recorded,true);
  assert.equal(recorded.report.work.rows.find(x=>x.deliverable==='page_refreshes').target,2);
  assert.ok(!recorded.exceptions.some(e=>e.source==='Delivery standard'));
});

test('maps grid: scans compare only when every setting matches; the map pack stays separate', () => {
  const cfg=(n)=>({target_place_id:'p',points:Array.from({length:n},(_,i)=>({lat:i,lng:i})),keywords:[{id:'k1',keyword:'x'}],zoom:13,search_this_area:false,geometry:{version:'local-multiscale-v1',default_radius_miles:5,point_count:n}});
  const scan=(id,at,n,top)=>({id,profile_id:'pr',started_at:at,completed_at:at,status:'complete',config:cfg(n),checks:Array.from({length:n},(_,i)=>({state:'complete',position:i<top?2:null}))});
  const g=(prev)=>base({grids:[{profile:{id:'pr',label:'Fixture',weekly_enabled:true,enabled:true},attempts:[],current:scan('c','2026-10-15T15:00:00Z',153,40),previous:prev}]});
  const diff=buildMonthlyReport(g(scan('p','2026-10-15T02:00:00Z',41,10)),'2026-10-01','2026-10-21T00:00:00Z').report.maps[0];
  assert.equal(diff.comparable,false);
  assert.ok(diff.notComparable.includes('different grid geometry') && diff.notComparable.includes('different points'));
  assert.equal(diff.current.points,153); assert.equal(diff.current.metrics.top3,40);
  const same=buildMonthlyReport(g(scan('p','2026-10-08T15:00:00Z',153,30)),'2026-10-01','2026-10-21T00:00:00Z').report.maps[0];
  assert.equal(same.comparable,true);
  // A scan from another month is never this month's scan.
  const later=buildMonthlyReport(g(scan('p','2026-10-08T15:00:00Z',153,30)),'2026-09-01','2026-10-21T00:00:00Z');
  assert.equal(later.report.maps[0].current,null);
  assert.ok(later.exceptions.some(e=>e.source==='Maps grid'));
  const none=buildMonthlyReport(base(),'2026-10-01','2026-10-21T00:00:00Z');
  assert.ok(none.exceptions.some(e=>e.source==='Maps grid'));
});

test('a complete month with every source is complete; the snapshot names its client, period and cutoff', () => {
  const ga4Scope=`GA4 properties/1 | ${site} | America/Chicago | complete_month`;
  const r=buildMonthlyReport(base({
    targets:['blog_posts','facebook_posts','gbp_posts','page_refreshes'].map(d=>({deliverable:d,target:1,completed:0,planned:0,unverified:0,standard_version:1,unit_kind:'client'})),
    runs:[run('b','2026-09-28T06:00:00Z')],
    observations:['k1','k2','k3'].map(k=>obs(k,'b','2026-09-28T06:10:00Z',5,own(k))),
    grids:[{profile:{id:'pr',label:'Fixture',weekly_enabled:true,enabled:true},attempts:[],previous:null,current:{id:'c',profile_id:'pr',started_at:'2026-09-15T00:00:00Z',completed_at:'2026-09-15T00:10:00Z',status:'complete',config:{zoom:13},checks:[]}}],
    measurements:[
      m('search_clicks',`Search Console https://${site}/ | web search | complete calendar months`,GSC,'2026-09-01','2026-09-01','2026-09-30',1,1),
      m('website_sessions',ga4Scope,'Google Analytics 4','2026-09-01','2026-09-01','2026-09-30',1,2),
      m('gbp_views','Google Business Profile locations/9 | complete calendar months','Google Business Profile via Zernio','2026-09-01','2026-09-01','2026-09-30',1,3),
    ],
  }),'2026-09-01','2026-10-21T00:00:00Z');
  assert.deepEqual(r.exceptions,[]);
  assert.equal(r.completeness,'complete'); assert.equal(r.partial,false);
  assert.equal(r.period,'2026-09-01'); assert.equal(r.cutoff,'2026-10-01T05:00:00.000Z'); assert.equal(r.client_id,C);
  assert.ok(r.report.observations.length>=3 && r.report.observations.length<=5);
  assert.ok(r.report.observations.every(o=>o.text && o.evidence));
  assert.ok(!/because|due to|caused|thanks to/i.test(JSON.stringify(r.report.observations)));
});
