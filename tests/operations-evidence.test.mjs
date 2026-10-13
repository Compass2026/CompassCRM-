import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildOperationalEvidence} from '../src/lib/operations-evidence.ts';
const now='2026-10-13T03:00:00Z',recent='2026-10-12T12:00:00Z';
const fixture=()=>({clients:[{id:'a',name:'A',website_url:'https://a.test'},{id:'b',name:'B',website_url:'https://b.test'}],keywords:[],rankings:[],rankRuns:[],backlinks:[],backlinkChecks:[],backlinkRuns:[],profileMeasures:[],social:[],socialAccounts:[],notifications:[],billing:[],sites:[],brands:[],services:[],claims:[],authority:[],now});
const card=(f,key)=>buildOperationalEvidence(f).cards.find(c=>c.clientId==='a'&&c.key===key);
test('unavailable source evidence remains unknown, not empty or recorded',()=>{
 for(const [source,key] of [['rankings','rankings'],['backlinkChecks','backlinks'],['social','social'],['notifications','notifications'],['billing','billing'],['sites','websites']]){const f=fixture();f[source]=null;assert.equal(card(f,key).state,'unknown');}
});
test('rank job completion needs actual fresh organic and maps coverage for each tracked keyword',()=>{
 const f=fixture();f.keywords=[{client_id:'a',id:'k',is_active:true,is_tracked:true}];f.rankRuns=[{id:'r',client_id:'a',status:'complete',checks_count:1,started_at:recent,completed_at:recent}];assert.equal(card(f,'rankings').state,'attention');
 f.rankings=['organic','map_pack'].map(result_type=>({client_id:'a',keyword_id:'k',result_type,checked_at:recent}));assert.equal(card(f,'rankings').state,'recorded');
 f.rankings[1].checked_at='2026-09-01';assert.equal(card(f,'rankings').state,'attention');f.rankings[1].checked_at='2027-01-01';assert.equal(card(f,'rankings').state,'attention');
});
test('backlink provider history and exact website evidence cannot hide behind a completed job',()=>{
 const f=fixture();f.backlinkRuns=[{client_id:'a',host:'a.test',created_at:recent,finished_at:recent,status:'completed',results:[{kind:'summary',status:'unchanged'}]}];assert.equal(card(f,'backlinks').state,'attention');
 f.profileMeasures=[{client_id:'a',scope:'a.test | Live external index',source:'DataForSEO (unreviewed index)',metric:'backlinks_total',window_end:'2026-10-12',created_at:recent}];assert.equal(card(f,'backlinks').state,'recorded');
 f.backlinkRuns[0].status='partial';f.backlinkRuns[0].results.push({kind:'history',status:'failed'});assert.equal(card(f,'backlinks').state,'attention');
});
test('backlink placement recovery uses newest check and overdue follow-ups exclude closed work',()=>{
 const f=fixture();f.backlinks=[{id:'p',client_id:'a',stage:'placed',due_on:null},{id:'closed',client_id:'a',stage:'closed',due_on:'2026-01-01'}];
 f.backlinkChecks=[{opportunity_id:'p',result:'missing',observed_on:'2026-10-01',recorded_at:'2026-10-01T12:00Z'},{opportunity_id:'p',result:'live',observed_on:'2026-10-12',recorded_at:recent}];
 const alerts=buildOperationalEvidence(f).alerts;assert.ok(!alerts.some(a=>a.id.endsWith('backlinks-check')||a.id.endsWith('backlinks-due')));
});
test('social reviews and failures link to exact records; future schedules and recovered posts are not failures',()=>{
 const f=fixture();f.social=[{client_id:'a',id:'review',platform:'facebook',review_status:'in_review',publish_status:'not_scheduled'},{client_id:'a',id:'future',platform:'facebook',review_status:'approved',publish_status:'scheduled',scheduled_at:'2026-10-15T10:00Z'},{client_id:'a',id:'recovered',platform:'facebook',review_status:'approved',publish_status:'published',published_at:recent,external_post_id:'provider'}];
 let out=buildOperationalEvidence(f);assert.equal(card(f,'social').state,'recorded');assert.ok(out.alerts.some(a=>a.href==='/clients/a/social/review'));assert.ok(!out.alerts.some(a=>a.id.includes('social-delivery')));
 f.social[1].scheduled_at='2026-10-10T10:00Z';out=buildOperationalEvidence(f);assert.ok(out.alerts.some(a=>a.href==='/clients/a/social/future'&&a.severity==='critical'));
 assert.ok(!out.alerts.some(a=>a.clientId==='b'&&a.id.includes('social')));
});
test('notification acceptance is not delivery and unknown attempts remain actionable',()=>{
 const f=fixture();f.notifications=[{client_id:'a',id:'j',status:'sent',provider_status:'sent',delivered_at:null,created_at:recent}];assert.equal(card(f,'notifications').state,'setup');
 f.notifications[0].provider_status='delivered';f.notifications[0].delivered_at=recent;assert.equal(card(f,'notifications').state,'recorded');
 f.notifications[0].status='unknown';assert.equal(card(f,'notifications').state,'attention');
});
test('only current client-scoped LIVE billing receipts count; later recovery clears historical incidents',()=>{
 const f=fixture();f.billing=[{client_id:'a',status:'healthy',livemode:false,checked_at:recent,attention_reasons:[],warnings:[]}];assert.equal(card(f,'billing').state,'setup');
 f.billing.push({...f.billing[0],livemode:true,status:'failed',checked_at:'2026-10-11T12:00Z'});assert.equal(card(f,'billing').state,'attention');f.billing.push({...f.billing[0],livemode:true});assert.equal(card(f,'billing').state,'recorded');
 assert.equal(buildOperationalEvidence(f).cards.find(c=>c.clientId==='b'&&c.key==='billing').state,'setup');
});
test('brand onboarding requires approved scoped services, confirmed claims, mapped keywords and exact destination ownership',()=>{
 const f=fixture();f.brands=[{client_id:'a',id:'brand',name:'Brand',service_ids:['s'],claim_ids:['c'],blog_site_id:'site',website_url:'https://a.test'}];f.services=[{client_id:'a',id:'s',status:'approved'}];f.claims=[{client_id:'a',id:'c',status:'confirmed'}];f.keywords=[{client_id:'a',id:'k',is_active:true,is_tracked:true,service_id:'s',intent:'commercial',target_url:'https://a.test/service'}];f.sites=[{client_id:'b',id:'site',url:'https://a.test',controlled_by_compass:true,vercel_project:'project',repo_url:'repo'}];
 const out=buildOperationalEvidence(f);assert.equal(out.checks.a.find(c=>c.key==='services:brand').state,'recorded');assert.equal(out.checks.a.find(c=>c.key==='claims:brand').state,'recorded');assert.equal(out.checks.a.find(c=>c.key==='intent:brand').state,'recorded');assert.equal(out.checks.a.find(c=>c.key==='destination:brand').state,'missing');
 f.claims[0].status='unverified';assert.equal(buildOperationalEvidence(f).checks.a.find(c=>c.key==='claims:brand').state,'waiting');
});

test('social onboarding isolates brand account ownership without requiring publishing enabled',()=>{
 const f=fixture();f.brands=[{client_id:'a',id:'brand',name:'Brand',service_ids:[],claim_ids:[],facebook_account_id:'account',website_url:'https://a.test'}];
 f.socialAccounts=[{client_id:'b',id:'account',platform:'facebook',external_account_id:'external',publish_account_id:'provider'}];
 assert.equal(buildOperationalEvidence(f).checks.a.find(c=>c.key==='social-channel:brand').state,'missing');
 f.socialAccounts[0].client_id='a';assert.equal(buildOperationalEvidence(f).checks.a.find(c=>c.key==='social-channel:brand').state,'recorded');
});
