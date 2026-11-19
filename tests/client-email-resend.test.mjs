import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {Webhook} from 'svix';
import {createEmailWebhook} from '../supabase/functions/client-email-webhook/handler.ts';
const cid='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222',iid='33333333-3333-4333-8333-333333333333',revision='44444444-4444-4444-8444-444444444444';
const secret='whsec_'+Buffer.from('fixture-signing-key-not-a-production-secret').toString('base64');
function req(event,tamper=false){const payload=JSON.stringify(event),id='msg_fixture',date=new Date();return new Request('https://example.test/webhook',{method:'POST',headers:{'svix-id':id,'svix-timestamp':String(Math.floor(date.getTime()/1000)),'svix-signature':new Webhook(secret).sign(id,date,payload)},body:tamper?payload+' ':payload});}
test('Resend rejects forged payloads and ignores unrelated account messages',async()=>{
 let writes=0;const db={rpc:async(name)=>{if(name==='get_secret')return{data:secret};writes++;return {data:null};}};
 const handler=createEmailWebhook(db,(r,h,s)=>new Webhook(s).verify(r,h));
 const event={type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:revision,from:'Business <owner@example.test>',to:['lead@example.test'],tags:{crm_message_id:iid}}};
 assert.equal((await handler(req(event,true))).status,403);assert.equal(writes,0);
 assert.equal((await handler(req({...event,data:{...event.data,tags:{other:'project'}}}))).status,200);assert.equal(writes,0);
 assert.equal((await handler(req(event))).status,200);assert.equal(writes,1);
});
test('Resend migration enforces readiness, idempotent callbacks, delivery order and suppression',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create table clients(id uuid primary key);create table inquiries(id uuid,client_id uuid,unique(id,client_id));`);
 for(const name of ['20261031151105_client_mailbox.sql','20261031160538_client_resend_email.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 await db.exec(`insert into clients values('${cid}');insert into auth.users values('${uid}');insert into inquiries values('${iid}','${cid}');insert into client_mailboxes(client_id,expected_email,connected_email,provider,reply_domain,api_key_secret)values('${cid}','owner@example.test','owner@example.test','resend','reply.example.test','PRIVATE_KEY');insert into client_email_threads(client_id,inquiry_id,recipient,subject)values('${cid}','${iid}','lead@example.test','Hello');insert into client_email_drafts(client_id,inquiry_id,actor_id,body,revision)values('${cid}','${iid}','${uid}','Hello','${revision}');`);
 const claim=`select client_mailbox_claim_send('${cid}','${iid}','${uid}','${revision}') as v`;
 await assert.rejects(db.query(claim),/email_not_ready/);
 await db.exec(`update client_mailboxes set resend_ready=true`);
 const m=(await db.query(claim)).rows[0].v.message;
 const event={event_id:'delivery',type:'email.delivered',provider_id:revision,message_id:m.id,sender:m.sender,recipient:m.recipient,delivery:'delivered',at:new Date().toISOString()};
 const save=p=>db.query('select client_email_record_event($1::jsonb)',[JSON.stringify(p)]);
 await save(event);await save(event);await save({...event,event_id:'late-sent',type:'email.sent',delivery:'sent'});
 let row=(await db.query('select * from client_email_messages')).rows[0];assert.equal(row.delivery_status,'delivered');assert.equal(row.status,'accepted');
 await save({...event,event_id:'bounce',type:'email.bounced',delivery:'bounced'});await save({...event,event_id:'later-delivery'});
 row=(await db.query('select * from client_email_messages')).rows[0];assert.equal(row.delivery_status,'bounced');
 await db.exec(`insert into client_email_drafts(client_id,inquiry_id,actor_id,body,revision)values('${cid}','${iid}','${uid}','Do not send','${iid}');`);
 await assert.rejects(db.query(`select client_mailbox_claim_send('${cid}','${iid}','${uid}','${iid}')`),/recipient_suppressed/);
 const thread=(await db.query('select * from client_email_threads')).rows[0];
 const received={event_id:'inbound',type:'email.received',provider_id:iid,reply_token:thread.reply_token,sender:'lead@example.test',recipient:`r.${thread.reply_token}@reply.example.test`,rfc_id:'<inbound@example.test>',subject:'Reply',body:'User text <script>no execution</script>',at:new Date().toISOString()};
 await save({...received,event_id:'wrong-domain',recipient:`r.${thread.reply_token}@wrong.example.test`});
 assert.equal((await db.query('select count(*)::int n from client_email_messages')).rows[0].n,1);
 await save(received);await save(received);
 assert.equal((await db.query('select count(*)::int n from client_email_messages')).rows[0].n,2);
 await db.exec('set role authenticated');
 for(const table of ['client_email_webhook_events','client_email_suppressions'])await assert.rejects(db.query('select * from '+table),/permission denied/);
 await assert.rejects(save({...event,event_id:'browser'}),/permission denied/);
 }finally{await db.close();}
});
