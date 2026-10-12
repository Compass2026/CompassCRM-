import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summaryMetrics,historyMetrics} from '../supabase/functions/backlink-performance/metrics.ts';
import {createBacklinkPerformance} from '../supabase/functions/backlink-performance/handler.ts';
const id='00000000-0000-4000-a000-000000000001';
const response=(kind,result)=>({status_code:20000,tasks:[{id,status_code:20000,data:{target:'example.test',function:kind},cost:0.02,result:[{target:'example.test',...result}]}]});
test('backlink provider identity, missing counts and incomplete history fail closed',()=>{
 const summary=response('summary',{backlinks:10,referring_domains:8});assert.equal(summaryMetrics(summary,'example.test').values.backlinks_total,10);
 assert.throws(()=>summaryMetrics(summary,'foreign.test'));
 for(const bad of [null,-1,1.5,11]){const r=structuredClone(summary);r.tasks[0].result[0].referring_domains=bad;assert.throws(()=>summaryMetrics(r,'example.test'));}
 const history=response('timeseries_new_lost_summary',{date_from:'2026-09-01',date_to:'2026-09-30',group_range:'month',items_count:1,items:[{date:'2026-09-30 00:00:00 +00:00',new_backlinks:2,lost_backlinks:1}]});
 assert.equal(historyMetrics(history,'example.test','2026-09-01','2026-09-30').months[0].values.links_new,2);
 history.tasks[0].result[0].items[0].date='2026-09-29';assert.throws(()=>historyMetrics(history,'example.test','2026-09-01','2026-09-30'));
});
test('weekly claim bounds provider charges; missing auth and failed claims make no requests',async()=>{
 for(const mode of ['claimed','denied','unauthorized']){
  let calls=0;
  const supabase={auth:{getUser:async()=>({data:{user:null}})},rpc:async(name)=>name==='get_secret'?{data:'secret'}:mode==='denied'?{error:{}}:{data:{status:'already_claimed'}},from(name){const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:{id,status:'active',website_url:'https://example.test'}}),then(resolve){resolve({data:name==='client_brand_workspaces'?[{website_url:'https://example.test'}]:[]})}};return q;}};
  const run=createBacklinkPerformance({supabase,fetch:async()=>{calls++;throw Error('unexpected')}});
  const r=await run(new Request('https://test',{method:'POST',headers:mode==='unauthorized'?{}:{'x-cron-secret':'secret'},body:JSON.stringify({client_id:id})}));
  assert.equal(calls,0);assert.equal(r.status,mode==='unauthorized'?401:200);
 }
});
