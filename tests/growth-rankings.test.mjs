import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankingSummary,rankingMovement} from '../src/lib/growth-rankings.ts';
const row={client_id:'a',keyword_id:'1',keyword:'plumber',keyword_city:null,location_id:'home',location_name:'Home',result_type:'organic',position:2,checked_at:'2026-10-01T00:00:00Z',first_position:9,first_checked_at:'2026-09-01T00:00:00Z',previous_position:7,previous_checked_at:'2026-09-20T00:00:00Z'};
test('unique tracked totals include unchecked keywords; location and result types do not inflate counts',()=>{
 const s=rankingSummary([row,{...row,location_id:'nearby',position:5},{...row,result_type:'map_pack',position:1},{...row,keyword_id:'2',position:null},{...row,keyword_id:'3',result_type:null,checked_at:null,position:null}],Date.parse('2026-10-20'));
 assert.equal(s.tracked,3);assert.equal(s.unchecked,1);assert.equal(s.organic.top3,1);assert.equal(s.organic.top10,1);assert.equal(s.organic.average,3.5);assert.equal(s.organic.checked,2);assert.equal(s.organic.rankedChecks,2);assert.equal(s.organic.stale,3);assert.equal(s.maps.average,1);assert.equal(s.maps.checked,1);
});
test('no checks is unavailable; checked but not found is zero top ranks and no average',()=>{
 assert.equal(rankingSummary([]).maps.top3,null);
 const s=rankingSummary([{...row,position:null}]);assert.equal(s.organic.top3,0);assert.equal(s.organic.average,null);assert.equal(s.maps.top10,null);
});
test('movement requires comparable numeric positions and separate dated checks',()=>{
 assert.equal(rankingMovement(9,2,'2026-09-01','2026-10-01'),'Up 7');
 assert.equal(rankingMovement(2,9,'2026-09-01','2026-10-01'),'Down 7');
 assert.equal(rankingMovement(null,2,'2026-09-01','2026-10-01'),'Not comparable');
 assert.equal(rankingMovement(2,2,'2026-10-01','2026-10-01'),'Awaiting another check');
});
import {rankingDistribution} from '../src/lib/growth-visuals.ts';
import {propertySearchTotals} from '../src/lib/search-totals.ts';
test('a third-party or unverified organic result is excluded: not a rank, not "not found", not comparable',()=>{
 const third={...row,keyword_id:'2',position:null,state:'third_party',first_state:'website',first_position:4};
 const unverified={...row,keyword_id:'3',position:null,state:'unverified'};
 const s=rankingSummary([{...row,state:'website',first_state:'website'},third,unverified],Date.parse('2026-10-02'));
 assert.equal(s.organic.checked,1,'excluded keywords are not counted as checked');assert.equal(s.organic.excluded,2);
 assert.equal(s.organic.top10,1);assert.equal(s.organic.top3,1);assert.equal(s.organic.average,2);
 assert.equal(rankingMovement(4,null,'2026-09-01','2026-10-01','website','third_party'),'Not comparable: not the website');
 assert.equal(rankingMovement(9,2,'2026-09-01','2026-10-01','website','website'),'Up 7');
 const d=Object.fromEntries(rankingDistribution([{...row,state:'website'},third,unverified,{...row,keyword_id:'4',position:null,state:'not_found'}],'organic').map(b=>[b.key,b.value]));
 assert.deepEqual(d,{top3:1,top10:0,beyond:0,missing:1,excluded:2,unchecked:0});
});
test('Search Console totals come from one property import, never a query-row sum or a sum of brands',()=>{
 const m=(metric,value,scope='https://site.test/',end='2026-09-30',sequence=1,source='Google Search Console property totals')=>({metric,value,scope,source,status:'measured',window_start:end.slice(0,8)+'01',window_end:end,sequence});
 assert.deepEqual(propertySearchTotals([m('search_clicks',55,undefined,'2026-08-31',1),m('search_impressions',17334,undefined,'2026-08-31',2),m('search_clicks',60,undefined,'2026-09-30',3),m('search_clicks',64,undefined,'2026-09-30',5),m('search_impressions',14280,undefined,'2026-09-30',4)]),
  {state:'ok',scope:'https://site.test/',start:'2026-09-01',end:'2026-09-30',clicks:64,impressions:14280});
 assert.equal(propertySearchTotals([m('search_clicks',5),m('search_impressions',9),m('search_clicks',7,'https://brand-two.test/'),m('search_impressions',8,'https://brand-two.test/')]).state,'several');
 assert.equal(propertySearchTotals([m('search_clicks',5,undefined,undefined,1,'GSC query sample')]).state,'none');
 assert.equal(propertySearchTotals([m('search_clicks',5)]).state,'none','clicks without impressions for the window is not a total');
});
