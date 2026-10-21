import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankingDistribution,interactionMix} from '../src/lib/growth-visuals.ts';

test('ranking pie partitions keywords once using best checked location, including missing and unchecked',()=>{
 const r={keyword_id:'one',result_type:'organic',checked_at:'2026-10-01',position:2};
 const rows=[r,{...r,position:8},{...r,keyword_id:'two',position:6},{...r,keyword_id:'three',position:30},{...r,keyword_id:'four',position:null},{...r,keyword_id:'five',checked_at:null,position:null}];
 const slices=rankingDistribution(rows,'organic');
 assert.deepEqual(slices.map(s=>[s.key,s.value]),[['top3',1],['top10',1],['beyond',1],['missing',1],['excluded',0],['unchecked',1]]);
 assert.equal(slices.reduce((n,s)=>n+s.value,0),5);
 assert.deepEqual(rankingDistribution(rows,'map_pack').map(s=>s.value),[0,0,0,0,0,5]);
});

test('interaction pie requires all three action types from identical scope, source and dates; zero stays zero',()=>{
 const series=['gbp_clicks','gbp_call_clicks','gbp_directions'].map((key,i)=>({metric:{key},definition:{source:'GBP',scope:'location one',platform:'none',channel:'none'},current:{status:'measured',value:i,window_start:'2026-09-01',window_end:'2026-09-30'}}));
 assert.deepEqual(interactionMix(series).items.map(s=>s.value),[0,1,2]);
 assert.equal(interactionMix(series.slice(0,2)),null);
 for(const change of [{definition:{...series[2].definition,scope:'location two'}},{definition:{...series[2].definition,source:'other source'}},{current:{...series[2].current,window_end:'2026-08-31'}},{current:{...series[2].current,status:'unavailable'}},{current:{...series[2].current,value:null}}]) assert.equal(interactionMix([...series.slice(0,2),{...series[2],...change}]),null);
});
