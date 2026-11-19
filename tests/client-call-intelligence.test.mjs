import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import webhooks from 'twilio/lib/webhooks/webhooks.js';
import {createVoiceWebhook} from '../supabase/functions/client-voice-webhook/handler.ts';
import {createClientPhone} from '../supabase/functions/client-phone/handler.ts';
import {voiceAdmin} from '../supabase/functions/client-phone/voice-admin.ts';
import {createCallWorker,summaryText} from '../supabase/functions/client-call-worker/handler.ts';
import {createEmailWebhook} from '../supabase/functions/client-email-webhook/handler.ts';
import {Webhook} from 'svix';
const cid='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222',iid='33333333-3333-4333-8333-333333333333',id='44444444-4444-4444-8444-444444444444',other='55555555-5555-4555-8555-555555555555';
const ac='AC'+'a'.repeat(32),parent='CA'+'b'.repeat(32),child='CA'+'c'.repeat(32),re='RE'+'d'.repeat(32),ga='GA'+'e'.repeat(32),gt='GT'+'f'.repeat(32),ly='LY'+'a'.repeat(32),base='https://example.test/functions/v1/client-voice-webhook';
function dbFixture(){
 const tables={clients:[{id:cid,status:'active'}],crm_lite_settings:[{client_id:cid,enabled:true,portal_enabled:true}],team_members:[],portal_users:[{client_id:cid,auth_user_id:uid,is_active:true,email:'agent@example.test'}],communication_accounts:[{client_id:cid,provider_account_sid:ac,provider:'twilio',status:'active'}],client_voice_settings:[{client_id:cid,enabled:true,recording_enabled:true,summaries_enabled:true,intelligence_service_sid:ga,summary_operator_sid:ly,retention_days:30}],client_voice_calls:[{id,client_id:cid,inquiry_id:iid,actor_id:uid,provider_sid:parent,direction:'outbound',recording_requested:true,recording_consent:'pending',created_at:new Date().toISOString()}],inquiries:[{id:iid,client_id:cid,phone_e164:'+12025550101'}]};
 const db={tables,auth:{getUser:async()=>({data:{user:{id:uid}}})},rpc:async(name)=>({data:name==='get_secret'?'cron':{auth_token:'token',api_key:'test-key',api_secret:'test-secret'}}),from(t){let filters=[],op=null,values=null,opts={};const q={select(){return q;},eq(k,v){filters.push(r=>r[k]===v);return q;},neq(k,v){filters.push(r=>r[k]!==v);return q;},is(k,v){return q.eq(k,v);},not(k,_,v){return q.neq(k,v);},gt(k,v){filters.push(r=>r[k]>v);return q;},gte(k,v){filters.push(r=>r[k]>=v);return q;},in(k,v){filters.push(r=>v.includes(r[k]));return q;},order(){return q;},limit(){return q;},update(v){op='update';values=v;return q;},insert(v){op='insert';values=v;return q;},upsert(v,o){op='upsert';values=v;opts=o||{};return q;},delete(){op='delete';return q;},maybeSingle:async()=>({data:run()[0]||null}),then(resolve,reject){return Promise.resolve({data:run()}).then(resolve,reject);}};
 function run(){const all=tables[t] ||= [];let rows=all.filter(r=>filters.every(f=>f(r)));if(op==='update')rows.forEach(r=>Object.assign(r,values));if(op==='insert')all.push({...values});if(op==='upsert'){const keys=(opts.onConflict||'client_id').split(',');const existing=all.find(r=>keys.every(k=>r[k]===values[k]));if(!existing)all.push({id:crypto.randomUUID(),...values});else if(!opts.ignoreDuplicates)Object.assign(existing,values);}if(op==='delete')tables[t]=all.filter(r=>!rows.includes(r));op=null;return rows;}return q;}};return db;
}
function signed(route,p){return new Request(base+route,{method:'POST',headers:{'x-twilio-signature':webhooks.getExpectedTwilioSignature('token',base+route,p)},body:new URLSearchParams(p)});}
const validate=(t,s,u,p)=>webhooks.validateRequest(t,s,u,p);

test('recording starts only after affirmative consent; refusal/timeout connects unrecorded',async()=>{
 for(const digit of ['1','2','']){
  const db=dbFixture(),requests=[];const fn=createVoiceWebhook(db,base,validate,async(url,init)=>{requests.push({url,init});return Response.json(url.endsWith('/Recordings.json')?{sid:re}:{parent_call_sid:parent});});
  const p={AccountSid:ac,CallSid:child,Digits:digit};
  const prompt=await fn(signed('/consent?call='+id,p));assert.match(await prompt.text(),/Press 1/);assert.equal(requests.filter(r=>r.init.method==='POST').length,0);
  const response=await fn(signed('/consent-result?call='+id,p));assert.equal(response.status,200);
  assert.equal(requests.filter(r=>r.init.method==='POST').length,digit==='1'?1:0);
  assert.equal(db.tables.client_voice_calls[0].recording_consent,digit==='1'?'accepted':'declined');
  await fn(signed('/consent-result?call='+id,p));assert.equal(requests.filter(r=>r.init.method==='POST').length,digit==='1'?1:0);
 }
});
test('child-call ownership is checked before accepting recording consent',async()=>{
 const db=dbFixture(),fn=createVoiceWebhook(db,base,validate,async()=>Response.json({parent_call_sid:'CA'+'0'.repeat(32)}));
 assert.equal((await fn(signed('/consent-result?call='+id,{AccountSid:ac,CallSid:child,Digits:'1'}))).status,403);
 assert.equal(db.tables.client_voice_calls[0].recording_consent,'pending');
});
test('signed recording callbacks deduplicate and still finish after calling disabled',async()=>{
 const db=dbFixture();Object.assign(db.tables.client_voice_calls[0],{recording_consent:'accepted',consent_child_sid:child});db.tables.client_voice_settings[0].enabled=false;
 const fn=createVoiceWebhook(db,base,validate),p={AccountSid:ac,CallSid:child,RecordingSid:re,RecordingStatus:'completed',RecordingDuration:'25'};
 assert.equal((await fn(signed('/recording?call='+id,p))).status,200);assert.equal((await fn(signed('/recording?call='+id,p))).status,200);
 assert.equal(db.tables.client_voice_recordings.length,1);assert.equal(db.tables.client_voice_recordings[0].state,'queued');
 assert.equal(db.tables.client_voice_recordings[0].duration,25);
 assert.equal((await fn(signed('/recording?call='+id,{...p,CallSid:'CA'+'0'.repeat(32)}))).status,403);
 assert.equal((await fn(new Request(base+'/recording?call='+id,{method:'POST',body:new URLSearchParams(p)}))).status,403);
});
test('recording callbacks without consent or from another client never store audio',async()=>{
 for(const mutate of [db=>{},db=>{db.tables.client_voice_calls[0].client_id=other;}]){
 const db=dbFixture();mutate(db);const fn=createVoiceWebhook(db,base,validate);
 assert.equal((await fn(signed('/recording?call='+id,{AccountSid:ac,CallSid:parent,RecordingSid:re,RecordingStatus:'completed',RecordingDuration:'25'}))).status,403);
 assert.equal(db.tables.client_voice_recordings,undefined);
 }
});
test('portal users cannot provision or reconfigure Twilio; recipients cannot cross client boundary',async()=>{
 const db=dbFixture(),request=()=>{throw Error('must not call provider');};
 await assert.rejects(voiceAdmin(db,cid,uid,{mode:'provision_voice'},base,request),/forbidden/);
 db.tables.team_members=[{auth_user_id:uid,role:'admin',email:'admin@example.test'}];
 await assert.rejects(voiceAdmin(db,cid,uid,{mode:'save_voice_settings',settings:{enabled:false,recording_enabled:false,summaries_enabled:false,email_summaries:false,retention_days:30,summary_user_ids:[other]}},base,request),/invalid_settings/);
});
test('recording playback checks lead ownership and expiry before fetching media',async()=>{
 const db=dbFixture();db.tables.client_voice_recordings=[{id,client_id:cid,call_id:id,state:'ready',expires_at:new Date(Date.now()-1000).toISOString(),account_sid:ac,recording_sid:re}];
 let requests=0;const fn=createClientPhone(db,base,()=>'',async()=>{requests++;return new Response('audio');});
 const req=()=>new Request(base,{method:'POST',headers:{authorization:'Bearer test'},body:JSON.stringify({mode:'recording',client_id:cid,inquiry_id:iid,recording_id:id})});
 assert.equal((await fn(req())).status,409);assert.equal(requests,0);
 db.tables.client_voice_recordings[0].expires_at=new Date(Date.now()+60000).toISOString();db.tables.client_voice_calls[0].inquiry_id=other;
 assert.equal((await fn(req())).status,409);assert.equal(requests,0);
 db.tables.client_voice_calls[0].inquiry_id=iid;assert.equal((await fn(req())).headers.get('cache-control'),'private, no-store');assert.equal(requests,1);
});
test('worker rejects unsigned invocations and does not repeat uncertain transcription submissions',async()=>{
 const db=dbFixture();let claims=0,requests=[];const r={id,client_id:cid,call_id:id,account_sid:ac,recording_sid:re,service_sid:ga,operator_sid:ly,state:'queued',submitted_at:new Date().toISOString(),expires_at:new Date(Date.now()+86400000).toISOString(),lease_until:'lease',attempts:1};db.tables.client_voice_recordings=[r];
 const old=db.rpc;db.rpc=async(name)=>name==='client_voice_claim_recording'?{data:claims++===0?[{...r}]:[]}:name==='client_voice_claim_email'?{data:[]}:old(name);
 const fn=createCallWorker(db,async(url,init)=>{requests.push({url,init});return Response.json({transcripts:[]});});
 assert.equal((await fn(new Request(base,{method:'POST'}))).status,403);assert.equal(claims,0);
 assert.equal((await fn(new Request(base,{method:'POST',headers:{'x-cron-secret':'cron'}}))).status,200);
 assert.equal(requests.length,1);assert.equal(requests[0].init.method,'GET');assert.equal(r.error_code,'submission_unconfirmed');
});
test('expired recordings purge both provider resources and stored text',async()=>{
 const db=dbFixture(),r={id,client_id:cid,account_sid:ac,recording_sid:re,transcript_sid:gt,state:'ready',summary:'private',transcript:'private',expires_at:new Date(Date.now()-1000).toISOString(),lease_until:'lease',attempts:1};db.tables.client_voice_recordings=[r];db.tables.client_voice_summary_emails=[{recording_id:id,body:'private',status:'pending'}];let claims=0;const old=db.rpc;db.rpc=async n=>n==='client_voice_claim_recording'?{data:claims++===0?[{...r}]:[]}:n==='client_voice_claim_email'?{data:[]}:old(n);const requests=[];
 const fn=createCallWorker(db,async(url,init)=>{requests.push({url,init});return new Response(null,{status:204});});
 await fn(new Request(base,{method:'POST',headers:{'x-cron-secret':'cron'}}));
 assert.equal(requests.length,2);assert.ok(requests.every(r=>r.init.method==='DELETE'));assert.equal(r.state,'deleted');assert.equal(r.transcript,null);assert.equal(r.summary,null);assert.equal(db.tables.client_voice_summary_emails[0].body,'');
});
test('summary parsing accepts text and known result objects but never invents missing results',()=>{
 assert.equal(summaryText({result:'Next step: return the call.'}),'Next step: return the call.');assert.equal(summaryText({unknown:true}),null);
});
test('summary mail is suppressed after recipient revocation and never retried beyond the provider idempotency window',async()=>{
 for(const expired of [false,true]){
 const db=dbFixture();db.tables.portal_users=[];
 const e={id,recording_id:id,client_id:cid,user_id:uid,recipient:'agent@example.test',sender:'calls@example.test',body:'summary',status:'pending',first_attempt_at:new Date(Date.now()-(expired?24:0)*3600000).toISOString(),lease_until:'lease',attempts:2};db.tables.client_voice_summary_emails=[e];
 db.tables.client_voice_recordings=[{id,client_id:cid,state:'ready',expires_at:new Date(Date.now()+60000).toISOString()}];Object.assign(db.tables.client_voice_settings[0],{email_summaries:true,summary_user_ids:[uid]});
 let claims=0;const old=db.rpc;db.rpc=async name=>name==='client_voice_claim_recording'?{data:[]}:name==='client_voice_claim_email'?{data:claims++===0?[{...e}]:[]}:old(name);
 const fn=createCallWorker(db,()=>{throw Error('must not send');});
 await fn(new Request(base,{method:'POST',headers:{'x-cron-secret':'cron'}}));assert.equal(e.status,expired?'uncertain':'suppressed');
 }
});
test('one completed transcript saves a lead summary and sends one idempotent email to each selected user',async()=>{
 const db=dbFixture(),r={id,client_id:cid,call_id:id,account_sid:ac,recording_sid:re,service_sid:ga,operator_sid:ly,transcript_sid:gt,state:'submitted',expires_at:new Date(Date.now()+86400000).toISOString(),lease_until:'lease',attempts:1};
 db.tables.client_voice_recordings=[r];db.tables.team_members=[{auth_user_id:other,email:'owner@example.test'}];db.tables.inquiries[0].name='Test Lead';
 Object.assign(db.tables.client_voice_settings[0],{email_summaries:true,summary_user_ids:[uid,other]});db.tables.client_mailboxes=[{client_id:cid,enabled:true,provider:'resend',resend_ready:true,expected_email:'calls@example.test'}];
 let recordClaims=0;const old=db.rpc;db.rpc=async(name)=>{
 if(name==='client_voice_claim_recording')return{data:recordClaims++===0?[{...r}]:[]};
 if(name==='client_voice_claim_email'){const e=(db.tables.client_voice_summary_emails||[]).find(v=>!v.status);if(!e)return{data:[]};Object.assign(e,{status:'pending',lease_until:'email-lease',attempts:1,first_attempt_at:new Date().toISOString()});return{data:[{...e}]};}return old(name);};
 const sends=[];const fn=createCallWorker(db,async(url,init)=>{
 if(url==='https://api.resend.com/emails'){sends.push({headers:init.headers,body:JSON.parse(init.body)});return Response.json({id:crypto.randomUUID()});}
 if(url.includes('/OperatorResults/'))return Response.json({text_generation_results:{result:'The lead needs a quote.'}});
 if(url.includes('/Sentences?'))return Response.json({sentences:[{media_channel:1,transcript:'Please send a quote.'}],meta:{next_page_url:null}});
 return Response.json({account_sid:ac,service_sid:ga,status:'completed'});
 });
 await fn(new Request(base,{method:'POST',headers:{'x-cron-secret':'cron'}}));
 assert.equal(r.state,'ready');assert.match(r.transcript,/Please send a quote/);assert.equal(sends.length,2);
 assert.deepEqual(sends.map(s=>s.body.to[0]).sort(),['agent@example.test','owner@example.test']);assert.ok(sends.every(s=>s.body.text.includes('Test Lead')));
 assert.equal(new Set(sends.map(s=>s.headers['Idempotency-Key'])).size,2);assert.ok(db.tables.client_voice_summary_emails.every(e=>e.status==='accepted'));
 await fn(new Request(base,{method:'POST',headers:{'x-cron-secret':'cron'}}));assert.equal(sends.length,2);
});
test('inbound consent timeout continues without recording and accepted consent records only after connection',async()=>{
 for(const digit of ['','1']){
 const db=dbFixture();db.tables.client_voice_calls=[];db.tables.communication_numbers=[{client_id:cid,phone_number_e164:'+18005550101',status:'active',voice_enabled:true}];
 const fn=createVoiceWebhook(db,base,validate),p={AccountSid:ac,CallSid:parent,From:'+12025550101',To:'+18005550101'};
 assert.match(await (await fn(signed('/inbound',p))).text(),/Press 1/);
 const twiml=await (await fn(signed('/inbound-consent',{...p,Digits:digit}))).text();assert.match(twiml,/<Dial/);
 if(digit==='1')assert.match(twiml,/record="record-from-answer-dual"/);else assert.doesNotMatch(twiml,/record="/);
 }
});
test('schema defaults off, enforces dependencies, protects data, and leases work once',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table clients(id uuid primary key);create table client_voice_settings(client_id uuid primary key,enabled boolean default false,application_sid text,fallback_url text);create table client_voice_calls(id uuid primary key,client_id uuid);insert into clients values('${cid}');insert into client_voice_settings(client_id)values('${cid}');insert into client_voice_calls values('${id}','${cid}');`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261102231538_client_call_intelligence.sql',import.meta.url),'utf8'));
 const s=(await db.query('select * from client_voice_settings')).rows[0];assert.equal(s.recording_enabled,false);assert.equal(s.email_summaries,false);assert.equal(s.retention_days,30);
 await assert.rejects(db.exec('update client_voice_settings set summaries_enabled=true'),/voice_summary_requires_recording/);
 await assert.rejects(db.exec('update client_voice_settings set retention_days=0'),/check/);
  // Exercise the real admin save against PostgreSQL constraints, not only an
  // in-memory upsert. INSERT validates the candidate before conflict handling.
  await db.exec(`insert into auth.users values('${other}');update client_voice_settings set application_sid='AP${'1'.repeat(32)}',intelligence_service_sid='${ga}',summary_operator_sid='${ly}' where client_id='${cid}';`);
  const admin=dbFixture(),fallback=admin.from.bind(admin);
  admin.tables.team_members=[{auth_user_id:other,role:'admin',email:'owner@example.test'}];
  admin.tables.communication_numbers=[{client_id:cid,is_primary:true,status:'active',voice_enabled:true}];
  admin.from=table=>{
   if(table!=='client_voice_settings')return fallback(table);
   let values=null,operation='select',filter=null;
   const run=async()=>{try{
    if(operation==='select')return{data:(await db.query('select * from client_voice_settings where client_id=$1',[filter])).rows};
    const keys=Object.keys(values),columns=keys.map(k=>'"'+k+'"');
    const typed='jsonb_populate_record(null::client_voice_settings,$1::jsonb) as input';
    const sql=operation==='update'?`update client_voice_settings as target set ${columns.map(k=>k+'=input.'+k).join(',')} from ${typed} where target.client_id=$2`:
     `insert into client_voice_settings (${columns.join(',')}) select ${columns.join(',')} from ${typed} on conflict(client_id) do update set ${columns.map(k=>k+'=excluded.'+k).join(',')}`;
    await db.query(sql,operation==='update'?[JSON.stringify(values),filter]:[JSON.stringify(values)]);return{data:[]};
   }catch(error){return{data:null,error};}};
   const q={select(){return q;},eq(_,v){filter=v;return q;},update(v){operation='update';values=v;return q;},upsert(v){operation='upsert';values=v;return q;},insert(v){operation='insert';values=v;return q;},async maybeSingle(){const r=await run();return{...r,data:r.data?.[0]||null};},then(resolve,reject){return run().then(resolve,reject);}};return q;
  };
  await voiceAdmin(admin,cid,other,{mode:'save_voice_settings',settings:{enabled:true,recording_enabled:true,summaries_enabled:true,email_summaries:false,retention_days:30,summary_user_ids:[other]}},base,()=>{throw Error('must not call provider');});
  const saved=(await db.query('select * from client_voice_settings')).rows[0];assert.equal(saved.summaries_enabled,true);assert.equal(saved.intelligence_service_sid,ga);assert.equal(saved.summary_operator_sid,ly);
 await db.exec(`insert into client_voice_recordings(client_id,call_id,account_sid,recording_sid,duration,state,expires_at)values('${cid}','${id}','${ac}','${re}',20,'queued',now()+interval '1 day')`);
 assert.equal((await db.query('select * from client_voice_claim_recording()')).rows.length,1);assert.equal((await db.query('select * from client_voice_claim_recording()')).rows.length,0);
 await db.exec(`create table client_email_webhook_events(id text primary key,event_type text);create table client_email_suppressions(client_id uuid,email text,reason text,primary key(client_id,email));insert into auth.users values('${uid}');insert into client_voice_summary_emails(id,client_id,recording_id,user_id,recipient,sender,body)select '${id}','${cid}',id,'${uid}','agent@example.test','calls@example.test','summary' from client_voice_recordings;`);
 const event={event_id:'delivered',type:'email.delivered',message_id:id,provider_id:other,sender:'calls@example.test',recipient:'agent@example.test',delivery:'delivered',at:new Date().toISOString()};
 const save=p=>db.query('select client_voice_summary_email_event($1::jsonb)',[JSON.stringify(p)]);
 await save({...event,sender:null});assert.equal((await db.query('select delivery_status from client_voice_summary_emails')).rows[0].delivery_status,null);
 await save(event);await save({...event,event_id:'sent',delivery:'sent'});assert.equal((await db.query('select delivery_status from client_voice_summary_emails')).rows[0].delivery_status,'delivered');
 await save({...event,event_id:'bounce',delivery:'bounced'});await save({...event,event_id:'late-delivery'});assert.equal((await db.query('select delivery_status from client_voice_summary_emails')).rows[0].delivery_status,'bounced');assert.equal((await db.query('select count(*)::int n from client_email_suppressions')).rows[0].n,1);
 for(const role of ['anon','authenticated']){await db.exec('set role '+role);for(const table of ['client_voice_recordings','client_voice_summary_emails'])await assert.rejects(db.query('select * from '+table),/permission denied/);await assert.rejects(db.query('select * from client_voice_claim_recording()'),/permission denied/);await db.exec('reset role');}
 }finally{await db.close();}
});

test('signed summary email callbacks use their own ledger and reject forged signatures',async()=>{
 const secret='whsec_'+Buffer.from('fictional-summary-signing-key').toString('base64'),writes=[];
 const db={rpc:async(name,input)=>name==='get_secret'?{data:secret}:(writes.push({name,input}),{data:null})};
 const fn=createEmailWebhook(db,(raw,headers,key)=>new Webhook(key).verify(raw,headers));
 const payload=JSON.stringify({type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:other,from:'sender@example.test',to:['agent@example.test'],tags:[{name:'crm_call_summary_id',value:id}]}});
 const date=new Date(),event='msg_summary',headers={'svix-id':event,'svix-timestamp':String(Math.floor(date.getTime()/1000)),'svix-signature':new Webhook(secret).sign(event,date,payload)};
 assert.equal((await fn(new Request(base,{method:'POST',headers,body:payload+' '}))).status,403);
 assert.equal(writes.length,0);
 assert.equal((await fn(new Request(base,{method:'POST',headers,body:payload}))).status,200);
 assert.equal(writes[0].name,'client_voice_summary_email_event');assert.equal(writes[0].input.p.message_id,id);
});
