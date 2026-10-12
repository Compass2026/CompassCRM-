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
