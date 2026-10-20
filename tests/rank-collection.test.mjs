import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
test('large rank queues use bounded lookups and surface database failures before consuming tasks',async()=>{
 for(const fail of [false,true]){
  const sizes=[],ready=Array.from({length:448},(_,i)=>({id:`task-${i}`,tag:`00000000-0000-4000-a000-${String(i).padStart(12,'0')}`}));
  let handler,gets=0;
  const supabase={rpc:async()=>({data:'credential'}),from(table){let ids=[];const q={select(){return q},in(key,value){ids=value;return q},eq(){return q},order(){return q},then(resolve){if(table==='keywords'){sizes.push(ids.length);resolve(fail?{error:{code:'DB_ERROR'}}:{data:ids.map(id=>({id,keyword:'fixture',city:null,client_id:'client'}))});}else resolve({data:[]});}};return q;}};
  const context=vm.createContext({console:{log(){}},Response,Request,URL,Date,Map,Set,Promise,Error,btoa,createClient:()=>supabase,Deno:{env:{get:()=>''},serve:fn=>handler=fn},EdgeRuntime:{waitUntil(){throw Error('unexpected background')}},fetch:async url=>{if(String(url).endsWith('/tasks_ready'))return Response.json({tasks:[{result:ready}]});gets++;return Response.json({tasks:[{status_code:50000,status_message:'fixture unavailable'}]});}});
  const source=readFileSync('supabase/functions/rank-sync/index.ts','utf8').replace(/import \{ createClient \} from .*?;\n/,'');
  vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
  const r=await handler(new Request('https://test',{method:'POST',headers:{'x-cron-secret':'credential'},body:JSON.stringify({mode:'collect',wait:true})}));
  assert.equal(r.status,fail?503:200);assert.ok(sizes.every(n=>n<=80));assert.equal(gets,fail?0:448);
  if(!fail)assert.equal((await r.json()).matched,448);
 }
});
// FIXTURE SERPs: invented results for the matching rule only.
async function collectFixture(items,file='supabase/functions/rank-sync/index.ts'){
 let handler,upserted=[];
 const tag='00000000-0000-4000-a000-000000000001';
 const tables={
  keywords:{data:[{id:tag,keyword:'fixture roofer',city:null,client_id:'client'}]},
  clients:{data:[{id:'client',name:'Fixture Roofing',dba:null,city:'Town',state:'MO',website_url:'https://www.fixture-roofer.test',sites:[]}]},
  rank_runs:{data:[{id:'run',client_id:'client',started_at:'2026-10-19T06:00:00Z',checks_count:1}]},
  locations:{data:[{id:'home',city:'Town',lat:1,lng:2}]},
 };
 const supabase={rpc:async()=>({data:'credential'}),from(table){let op='select';const q={select(){return q},in(){return q},eq(){return q},lt(){return q},like(){return q},order(){return q},
  upsert(rows){op='upsert';upserted=rows;return q},update(){op='update';return q},insert(){op='insert';return q},
  then(resolve){resolve(op==='upsert'?{data:upserted.map((_,i)=>({id:i}))}:table==='rank_snapshots'?{count:1}:tables[table]??{data:[]});}};return q;}};
 const context=vm.createContext({console:{log(){}},Response,Request,URL,Date,Map,Set,Promise,Error,btoa,createClient:()=>supabase,Deno:{env:{get:()=>''},serve:fn=>handler=fn},EdgeRuntime:{waitUntil(){throw Error('unexpected background')}},fetch:async url=>{if(String(url).endsWith('/tasks_ready'))return Response.json({tasks:[{result:[{id:'task-1',tag}]}]});return Response.json({tasks:[{status_code:20000,cost:0.0006,data:{location_coordinate:'1,2'},result:[{items}]}]});}});
 const source=readFileSync(file,'utf8').replace(/import \{ createClient \} from .*?;\n/,'');
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 const r=await handler(new Request('https://test',{method:'POST',headers:{'x-cron-secret':'credential'},body:JSON.stringify({mode:'collect',wait:true})}));
 assert.equal(r.status,200);
 return {organic:upserted.find(x=>x.result_type==='organic'),pack:upserted.find(x=>x.result_type==='map_pack')};
}
const thirdParty=[
 {type:'local_pack',title:'Other Roofing Co',domain:'other.test'},
 {type:'local_pack',title:'Fixture Roofing',domain:null},
 {type:'organic',rank_group:1,title:'Fixture Roofing | Facebook',domain:'www.facebook.com',url:'https://www.facebook.com/FixtureRoofing/'},
 {type:'organic',rank_group:2,title:'Fixture Roofing LLC reviews',domain:'www.angi.com',url:'https://www.angi.com/fixture'},
];
test('organic rank is the website host only; the business name still counts in the map pack',async()=>{
 const {organic,pack}=await collectFixture([...thirdParty,{type:'organic',rank_group:3,title:'Roofer in Town',domain:'fixture-roofer.test',url:'https://fixture-roofer.test/services/roofing'}]);
 assert.equal(organic.position,3);assert.equal(organic.url_ranked,'https://fixture-roofer.test/services/roofing');
 assert.equal(pack.position,2);assert.equal(organic.location_id,'home');
});
test('organic is not found when only third-party pages carry the business name',async()=>{
 const {organic,pack}=await collectFixture(thirdParty);
 assert.equal(organic.position,null);assert.equal(organic.url_ranked,null);assert.equal(pack.position,2);
});
