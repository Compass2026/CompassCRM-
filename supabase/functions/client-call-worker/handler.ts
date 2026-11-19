import type { DB } from "../client-mailbox/handler.ts";
import { voiceProvider, sid } from "../client-phone/voice-provider.ts";
import { voiceRecipients } from "../client-phone/voice-admin.ts";

export function summaryText(value: unknown): string | null {
  if (typeof value === "string") return value.trim().slice(0,20000) || null;
  if (value && typeof value === "object") {
    const v=value as Record<string,unknown>;
    for(const k of ["result","text","summary"]) if(typeof v[k]==="string") return summaryText(v[k]);
  }
  return null;
}

export function createCallWorker(db: DB, request: typeof fetch = fetch) {
  async function checked(q: DB) { const r=await q; if(r.error) throw Error("database_unavailable"); return r.data; }
  async function one(t: string,f: DB) { let q=db.from(t).select("*"); for(const [k,v] of Object.entries(f)) q=q.eq(k,v); return checked(q.maybeSingle()); }
  async function secret(name: string) { return checked(db.rpc("get_secret",{secret_name:name})); }
  async function patch(r: DB, v: DB) { await checked(db.from("client_voice_recordings").update({lease_until:null,...v}).eq("id",r.id).eq("lease_until",r.lease_until)); }
  async function recipients(r: DB, config: DB) {
    if(!config.email_summaries) return;
    const mailbox=await one("client_mailboxes",{client_id:r.client_id});
    if(!mailbox?.enabled || mailbox.provider!=="resend" || !mailbox.resend_ready) throw Error("email_not_ready");
    const users=await voiceRecipients(db,r.client_id);
    const call=await one("client_voice_calls",{id:r.call_id,client_id:r.client_id});
    const lead=call?.inquiry_id ? await one("inquiries",{id:call.inquiry_id,client_id:r.client_id}):null;
    const label=lead?.name || "Incoming caller";
    for(const user of users.filter(u=>(config.summary_user_ids || []).includes(u.id)))
      await checked(db.from("client_voice_summary_emails").upsert({client_id:r.client_id,recording_id:r.id,user_id:user.id,
        recipient:user.email,sender:mailbox.expected_email,
        body:`AI call summary: ${label}\nCall started: ${call?.created_at || r.created_at}\n\n${r.summary}\n\nCheck the recording and transcript in your Compass workspace before acting on this summary.`,
      },{onConflict:"recording_id,user_id",ignoreDuplicates:true}));
  }
  async function processRecording(r: DB) {
    const provider=await voiceProvider(db,r.account_sid,request);
    if(Date.parse(r.expires_at)<=Date.now()) {
      // Purge both provider artifacts and local text. 404 also means deletion succeeded.
      if(r.transcript_sid) await provider.call(`/Transcripts/${r.transcript_sid}`,"DELETE",undefined,true);
      else if(r.submitted_at && r.service_sid) {
        const found=await provider.call(`/Transcripts?SourceSid=${r.recording_sid}&ServiceSid=${r.service_sid}&PageSize=100`,"GET",undefined,true);
        for(const t of found.transcripts || []) if(sid(t.sid,"GT") && t.account_sid===r.account_sid && t.service_sid===r.service_sid)
          await provider.call(`/Transcripts/${t.sid}`,"DELETE",undefined,true);
      }
      await provider.call(`/Recordings/${r.recording_sid}.json`,"DELETE");
      await checked(db.from("client_voice_summary_emails").update({body:"",status:"suppressed"}).eq("recording_id",r.id).eq("status","pending"));
      await checked(db.from("client_voice_summary_emails").update({body:""}).eq("recording_id",r.id));
      await patch(r,{state:"deleted",transcript:null,summary:null,error_code:null}); return;
    }
    const config=await one("client_voice_settings",{client_id:r.client_id});
    const client=await one("clients",{id:r.client_id});
    if(!config?.summaries_enabled || ["paused","offboarded"].includes(client?.status)) {
      await patch(r,{state:"recorded",error_code:"processing_disabled"}); return;
    }
    if(!r.transcript_sid) {
      // Recovery by immutable recording source, before every paid create.
      const existing=await provider.call(`/Transcripts?SourceSid=${r.recording_sid}&ServiceSid=${r.service_sid}&PageSize=100`,"GET",undefined,true);
      let transcript=(existing.transcripts || []).find((t: DB)=>t.service_sid===r.service_sid && t.account_sid===r.account_sid);
      if(!transcript && r.submitted_at) {
        await patch(r,{state: Date.now()-Date.parse(r.submitted_at)>900000?"uncertain":"queued",error_code:"submission_unconfirmed",next_attempt_at:new Date(Date.now()+60000).toISOString()}); return;
      }
      if(!transcript) {
        await checked(db.from("client_voice_recordings").update({submitted_at:new Date().toISOString()}).eq("id",r.id).eq("lease_until",r.lease_until));
        transcript=await provider.call("/Transcripts","POST",{ServiceSid:r.service_sid,
          Channel:JSON.stringify({media_properties:{source_sid:r.recording_sid}}),CustomerKey:r.id},true);
      }
      if(!sid(transcript.sid,"GT") || transcript.account_sid!==r.account_sid || transcript.service_sid!==r.service_sid) throw Error("provider_scope_mismatch");
      await patch(r,{transcript_sid:transcript.sid,state:"submitted",next_attempt_at:new Date(Date.now()+60000).toISOString(),error_code:null}); return;
    }
    const t=await provider.call(`/Transcripts/${r.transcript_sid}`,"GET",undefined,true);
    if(t.account_sid!==r.account_sid || t.service_sid!==r.service_sid) throw Error("provider_scope_mismatch");
    if(["failed","canceled","error"].includes(t.status)) { await patch(r,{state:"failed",error_code:"transcription_failed"});return; }
    if(t.status!=="completed") { await patch(r,{next_attempt_at:new Date(Date.now()+60000).toISOString()});return; }
    const result=await provider.call(`/Transcripts/${r.transcript_sid}/OperatorResults/${r.operator_sid}`,"GET",undefined,true);
    const summary=summaryText(result.text_generation_results);
    if(!summary) throw Error("summary_pending");
    let path=`/Transcripts/${r.transcript_sid}/Sentences?PageSize=1000`,text="",pages=0;
    while(path) {
      if(++pages>20) throw Error("transcript_too_large");
      const page=await provider.call(path,"GET",undefined,true);
      for(const sentence of page.sentences || []) {
        if(typeof sentence.transcript!=="string") throw Error("transcript_invalid");
        text+=`Speaker ${sentence.media_channel ?? "?"}: ${sentence.transcript}\n`;
      }
      if(text.length>500000) throw Error("transcript_too_large");
      const next=page.meta?.next_page_url;
      if(!next) break;
      const url=new URL(next,"https://intelligence.twilio.com");
      if(url.origin!=="https://intelligence.twilio.com" || url.pathname!==`/v2/Transcripts/${r.transcript_sid}/Sentences`) throw Error("provider_scope_mismatch");
      path=url.pathname.slice(3)+url.search;
    }
    if(!text.trim()) throw Error("empty_transcript");
    // Persist text first, then queue mail. Retries upsert the same recipient rows.
    await checked(db.from("client_voice_recordings").update({summary,transcript:text}).eq("id",r.id).eq("lease_until",r.lease_until));
    await recipients({...r,summary},config);
    await patch(r,{state:"ready",error_code:null});
  }
  async function processEmail(e: DB) {
    const save=(v: DB)=>checked(db.from("client_voice_summary_emails").update({lease_until:null,...v}).eq("id",e.id).eq("lease_until",e.lease_until));
    if(Date.now()-Date.parse(e.first_attempt_at)>23*3600000) { await save({status:"uncertain"});return; }
    const [r,config,client,mailbox,users]=await Promise.all([
      one("client_voice_recordings",{id:e.recording_id,client_id:e.client_id}),one("client_voice_settings",{client_id:e.client_id}),
      one("clients",{id:e.client_id}),one("client_mailboxes",{client_id:e.client_id}),voiceRecipients(db,e.client_id),
    ]);
    if(!r || Date.parse(r.expires_at)<=Date.now() || r.state==="deleted" || !config?.email_summaries ||
      ["paused","offboarded"].includes(client?.status) || !(config.summary_user_ids || []).includes(e.user_id) ||
      !users.some(u=>u.id===e.user_id && u.email===e.recipient)) {await save({status:"suppressed"});return;}
    if(!mailbox?.enabled || !mailbox.resend_ready || mailbox.provider!=="resend" || mailbox.expected_email!==e.sender) throw Error("email_not_ready");
    if(await one("client_email_suppressions",{client_id:e.client_id,email:e.recipient.toLowerCase()})) {await save({status:"suppressed"});return;}
    const key=await secret(mailbox.api_key_secret || "CLIENT_RESEND_API_KEY");
    if(!key) throw Error("email_not_ready");
    const response=await request("https://api.resend.com/emails",{method:"POST",headers:{Authorization:`Bearer ${key}`,
      "Content-Type":"application/json","Idempotency-Key":`call-summary-${e.id}`},
      body:JSON.stringify({from:e.sender,to:[e.recipient],subject:"Your Compass call summary",text:e.body,tags:[{name:"crm_call_summary_id",value:e.id}]}),signal:AbortSignal.timeout(15000),redirect:"error"});
    if(!response.ok) { if(response.status<500 && response.status!==429) {await save({status:"failed"});return;} throw Error("email_retry"); }
    const sent=await response.json(); if(typeof sent.id!=="string") throw Error("email_retry");
    await save({status:"accepted",provider_id:sent.id});
  }
  return async(req: Request)=>{
    if(req.method!=="POST") return new Response("Method not allowed",{status:405});
    try {
      const cron=await secret("SYNC_CRON_SECRET");
      if(!cron || req.headers.get("x-cron-secret")!==cron) return new Response("Forbidden",{status:403});
      let recordings=0,emails=0;
      for(let n=0;n<1;n++) {
        const r=(await checked(db.rpc("client_voice_claim_recording")))?.[0]; if(!r) break;
        try {await processRecording(r);} catch(e) {
          const code=e instanceof Error && /^[a-z_0-9]+$/.test(e.message) ? e.message:"processing_failed";
          await patch(r,{...(r.attempts>=20 && Date.parse(r.expires_at)>Date.now()?{state:"failed"}:{}),error_code:code,
            next_attempt_at:new Date(Date.now()+Math.min(3600000,60000*2**Math.min(r.attempts,6))).toISOString()});
        } recordings++;
      }
      for(let n=0;n<2;n++) {
        const e=(await checked(db.rpc("client_voice_claim_email")))?.[0]; if(!e) break;
        try {await processEmail(e);} catch {
          await checked(db.from("client_voice_summary_emails").update({lease_until:null,next_attempt_at:new Date(Date.now()+Math.min(3600000,60000*2**Math.min(e.attempts,6))).toISOString()})
            .eq("id",e.id).eq("lease_until",e.lease_until));
        } emails++;
      }
      return Response.json({recordings,emails});
    } catch { return Response.json({error:"worker_unavailable"},{status:503}); }
  };
}
