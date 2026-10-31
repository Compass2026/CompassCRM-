import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import webhooks from 'twilio/lib/webhooks/webhooks.js';
import {voiceIdentity} from '../supabase/functions/client-phone/identity.ts';
import {createClientPhone} from '../supabase/functions/client-phone/handler.ts';
import {createVoiceWebhook} from '../supabase/functions/client-voice-webhook/handler.ts';
const cid='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222',iid='33333333-3333-4333-8333-333333333333',rid='44444444-4444-4444-8444-444444444444',other='55555555-5555-4555-8555-555555555555';
function fakeDB(active=true){let writes=0;const tables={clients:[{id:cid,status:'active'}],crm_lite_settings:[{client_id:cid,enabled:true,portal_enabled:true}],portal_users:active?[{client_id:cid,auth_user_id:uid,is_active:true}]:[],team_members:[],communication_accounts:[{client_id:cid,provider_account_sid:'AC'+'a'.repeat(32),provider:'twilio',status:'active'}]};return {tables,get writes(){return writes;},auth:{getUser:async(jwt)=>jwt==='valid'?{data:{user:{id:uid}}}:{error:true}},rpc:async()=>({data:{auth_token:'fake-token'}}),from(t){let f=[],change=null;const q={select(){return q;},eq(k,v){f.push([k,v]);return q;},is(k,v){f.push([k,v]);return q;},then(resolve){const rows=(tables[t]||[]).filter(v=>f.every(([k,x])=>v[k]===x));if(change)rows.forEach(r=>Object.assign(r,change));return Promise.resolve({data:rows}).then(resolve);},maybeSingle:async()=>({data:(tables[t]||[]).find(v=>f.every(([k,x])=>v[k]===x))||null}),insert(){writes++;return q;},update(v){writes++;change=v;return q;},upsert(){writes++;return q;}};return q;}};}
test('phone endpoint denies inactive and cross-client actors before provider or writes',async()=>{
 for(const [active,client]of [[false,cid],[true,other]]){const db=fakeDB(active);const fn=createClientPhone(db,'https://example.test',()=>{throw Error('must not mint');},()=>{throw Error('must not send');});const r=await fn(new Request('https://example.test',{method:'POST',headers:{authorization:'Bearer valid'},body:JSON.stringify({client_id:client,mode:'voice_token'})}));assert.equal(r.status,403);assert.equal(db.writes,0);}
});
test('voice webhook authenticates actual public URL and refuses arbitrary dial destinations',async()=>{
 const db=fakeDB(),base='https://example.test/functions/v1/client-voice-webhook';
 const fn=createVoiceWebhook(db,base,(t,s,u,p)=>webhooks.validateRequest(t,s,u,p));
 const params={AccountSid:'AC'+'a'.repeat(32),CallSid:'CA'+'b'.repeat(32),To:'+12025550100'};
 const request=(signature)=>new Request(base+'/outbound',{method:'POST',headers:{'x-twilio-signature':signature},body:new URLSearchParams(params)});
 assert.equal((await fn(request('forged'))).status,403);
 const signed=webhooks.getExpectedTwilioSignature('fake-token',base+'/outbound',params);
 const r=await fn(request(signed));assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/<Dial/);assert.equal(db.writes,0);
});
test('SMS reservation requires active own-client portal actor, approval and consent, and deduplicates saved revisions',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table clients(id uuid primary key,status text);create table team_members(id uuid primary key,auth_user_id uuid);create table portal_users(client_id uuid,auth_user_id uuid,is_active boolean);create table crm_lite_settings(client_id uuid,enabled boolean,portal_enabled boolean);create table contacts(id uuid,client_id uuid,phone_e164 text);create table inquiries(id uuid,client_id uuid,contact_id uuid,unique(id,client_id));
 create function communication_caller() returns text language sql as $$select 'service'::text$$;
 create table client_communication_settings(client_id uuid,enabled boolean,outbound_enabled boolean);
 create table communication_accounts(id uuid,client_id uuid,provider_account_sid text);
 create table communication_messaging_services(id uuid,provider_service_sid text,status text);
 create table communication_numbers(id uuid,client_id uuid,communication_account_id uuid,messaging_service_id uuid,is_primary boolean,status text,sms_enabled boolean,phone_number_e164 text);
 create table communication_compliance_profiles(client_id uuid,profile_type text,status text);
 create table communication_consents(client_id uuid,phone_e164 text,consent_type text,status text);
 create table communication_conversations(id uuid primary key default gen_random_uuid(),client_id uuid,contact_id uuid,communication_number_id uuid,channel text,status text,last_message_at timestamptz,last_message_preview text,last_direction text,unread_count int,unique(client_id,contact_id,communication_number_id,channel));
 create table communication_messages(id uuid primary key default gen_random_uuid(),client_id uuid,conversation_id uuid,provider text,request_id uuid unique,direction text,from_e164 text,to_e164 text,body text,provider_status text,sent_by uuid,status_updated_at timestamptz,provider_message_sid text);
 `);
 await db.exec(await readFile(new URL('../supabase/migrations/20261031161048_client_phone_workspace.sql',import.meta.url),'utf8'));
 await db.exec(`insert into clients values('${cid}','active');insert into auth.users values('${uid}');insert into crm_lite_settings values('${cid}',true,true);insert into portal_users values('${cid}','${uid}',true);insert into contacts values('${iid}','${cid}','+12025550101');insert into inquiries values('${iid}','${cid}','${iid}');insert into client_communication_settings values('${cid}',true,true);insert into client_phone_drafts(client_id,inquiry_id,actor_id,body,revision)values('${cid}','${iid}','${uid}','Saved reply','${rid}');`);
 const reserve=(actor=uid)=>db.query('select client_phone_begin_sms($1::jsonb) v',[JSON.stringify({client_id:cid,inquiry_id:iid,actor_id:actor,request_id:rid,body:'Injected replacement'})]);
 await assert.rejects(reserve(other),/forbidden/);await assert.rejects(reserve(),/verification_required/);
 await db.exec(`insert into communication_compliance_profiles values('${cid}','toll_free_verification','approved');insert into communication_accounts values('${cid}','${cid}','ACfixture');insert into communication_messaging_services values('${cid}','MGfixture','active');insert into communication_numbers values('${cid}','${cid}','${cid}','${cid}',true,'active',true,'+18005550101');`);
 await assert.rejects(reserve(),/no_consent/);
 await db.exec(`insert into communication_consents values('${cid}','+12025550101','sms_customer_care','granted');`);
 const first=(await reserve()).rows[0].v;assert.equal(first.duplicate,false);assert.equal(first.body,'Saved reply');
 const second=(await reserve()).rows[0].v;assert.equal(second.duplicate,true);assert.equal(second.message_id,first.message_id);
 await db.exec(`update portal_users set is_active=false`);await assert.rejects(reserve(),/forbidden/);
 await db.exec('set role authenticated');await assert.rejects(reserve(),/permission denied/);
 for(const t of ['client_phone_drafts','client_voice_settings','client_voice_calls'])await assert.rejects(db.query('select * from '+t),/permission denied/);
 }finally{await db.close();}
});

test('voice intents bind actor and stored lead destination and can be claimed only once',async()=>{
 const db=fakeDB(),base='https://example.test/functions/v1/client-voice-webhook';
 db.tables.client_voice_settings=[{client_id:cid,enabled:true}];
 db.tables.inquiries=[{id:iid,client_id:cid,phone_e164:'+12025550101'}];
 db.tables.client_voice_calls=[{id:rid,client_id:cid,inquiry_id:iid,actor_id:uid,direction:'outbound',from_number:'+18005550101',to_number:'+12025550101',expires_at:new Date(Date.now()+60000).toISOString(),status:'prepared',provider_sid:null}];
 const fn=createVoiceWebhook(db,base,(t,s,u,p)=>webhooks.validateRequest(t,s,u,p));
 const params={AccountSid:'AC'+'a'.repeat(32),CallSid:'CA'+'b'.repeat(32),From:'client:'+voiceIdentity(cid,uid),Intent:rid,To:'+12025550999'};
 const request=p=>new Request(base+'/outbound',{method:'POST',headers:{'x-twilio-signature':webhooks.getExpectedTwilioSignature('fake-token',base+'/outbound',p)},body:new URLSearchParams(p)});
 assert.match(voiceIdentity(cid,uid),/^[a-z0-9_]+$/);
 assert.doesNotMatch(await (await fn(request({...params,From:'client:'+voiceIdentity(cid,other)}))).text(),/<Dial/);
 const first=await (await fn(request(params))).text();assert.match(first,/<Dial/);assert.match(first,/>\+12025550101<\/Number>/);assert.ok(!first.includes('+12025550999'));
 assert.doesNotMatch(await (await fn(request(params))).text(),/<Dial/);
});
