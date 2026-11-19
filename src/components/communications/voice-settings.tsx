"use client";
import { useEffect, useState } from "react";

type Settings={enabled:boolean;recording_enabled:boolean;summaries_enabled:boolean;email_summaries:boolean;retention_days:number;summary_user_ids:string[];application_sid?:string;intelligence_service_sid?:string;summary_operator_sid?:string};
type Setup={settings:Settings|null;recipients:{id:string;email:string}[];number:string|null;account_ready:boolean;number_ready:boolean;email_ready:boolean;inbound_webhook:string};
const defaults:Settings={enabled:false,recording_enabled:false,summaries_enabled:false,email_summaries:false,retention_days:30,summary_user_ids:[]};
export function VoiceSettings({clientId}:{clientId:string}) {
  const [setup,setSetup]=useState<Setup|null>(null),[settings,setSettings]=useState<Settings>(defaults),[busy,setBusy]=useState(""),[message,setMessage]=useState("");
  async function api(mode:string,rest:Record<string,unknown>={}) {
    const r=await fetch("/api/client-phone",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_id:clientId,mode,...rest})});
    const data=await r.json();if(!r.ok) throw Error(data.error?.replaceAll("_"," ") || "Setup unavailable");return data;
  }
  useEffect(()=>{
    let live=true;
    fetch("/api/client-phone",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_id:clientId,mode:"voice_setup"})})
      .then(async r=>{if(!r.ok)throw Error("Calling setup could not be loaded.");return r.json();})
      .then(d=>{if(live){setSetup(d);setSettings(d.settings || defaults);}}).catch(e=>{if(live)setMessage(e.message);});
    return()=>{live=false;};
  },[clientId]);
  async function act(mode:string) {
    setBusy(mode);setMessage("");
    try{await api(mode,mode==="save_voice_settings"?{settings}:{});const d=await api("voice_setup");setSetup(d);setSettings(d.settings || defaults);setMessage(mode==="route_inbound"?"Incoming calls now route to this workspace.":"Saved. Make a controlled test call before rolling out to your client.");}
    catch(e){setMessage(e instanceof Error?e.message:"Setup failed.");}finally{setBusy("");}
  }
  return <section className="rounded-xl border bg-white p-5 lg:col-span-2" aria-label="Client calling setup">
    <h2 className="text-lg font-semibold">Calling, recordings, and summaries</h2>
    <p className="mt-1 text-sm text-slate-600">Configure this client independently. Provider usage is billed to your Twilio and Resend accounts.</p>
    {setup && <>
      <div className="my-4 grid gap-3 text-sm sm:grid-cols-3">
        <p>Business number: <strong>{setup.number || "Not configured"}</strong></p>
        <p>Calling setup: <strong>{setup.number_ready && settings.application_sid?"Configured":"Incomplete"}</strong></p>
        <p>Summary email: <strong>{setup.email_ready?"Ready":"Mailbox setup required"}</strong></p>
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <button disabled={!!busy || !setup.account_ready} onClick={()=>act("provision_voice")} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40">Set up browser calling</button>
        <button disabled={!!busy || !setup.account_ready} onClick={()=>act("provision_summaries")} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-40">Set up Twilio summaries</button>
      </div>
      <fieldset disabled={!!busy} className="grid gap-4 sm:grid-cols-2">
        {([['enabled','Enable browser calling'],['recording_enabled','Offer call recording'],['summaries_enabled','Create transcripts and AI summaries'],['email_summaries','Email summaries to selected users']] as const).map(([key,label])=><label className="flex items-center gap-2 text-sm" key={key}><input type="checkbox" checked={settings[key]} onChange={e=>setSettings({...settings,[key]:e.target.checked})}/>{label}</label>)}
        <label className="text-sm">Recording and transcript retention
          <select value={settings.retention_days} onChange={e=>setSettings({...settings,retention_days:Number(e.target.value)})} className="ml-3 rounded-lg border p-2">{[7,30,60,90,180,365].map(n=><option key={n} value={n}>{n} days</option>)}</select>
        </label>
        <div className="text-sm"><p className="mb-2 font-medium">Summary recipients</p>{setup.recipients.map(u=><label key={u.id} className="mb-2 flex items-center gap-2 break-all"><input type="checkbox" checked={settings.summary_user_ids.includes(u.id)} onChange={e=>setSettings({...settings,summary_user_ids:e.target.checked?[...settings.summary_user_ids,u.id]:settings.summary_user_ids.filter(id=>id!==u.id)})}/>{u.email}</label>)}</div>
      </fieldset>
      <p className="mt-4 text-xs text-slate-600">Callers press 1 to agree to recording and transcription. Declining or making no selection continues without recording. Retention applies to new recordings; copies already emailed remain in recipients’ inboxes. Summaries are AI-generated and require review.</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button disabled={!!busy} onClick={()=>act("save_voice_settings")} className="rounded-lg bg-navy-900 px-4 py-2 text-sm text-white disabled:opacity-40">{busy?"Working…":"Save calling settings"}</button>
        <button disabled={!!busy || !setup.settings?.enabled} onClick={()=>act("route_inbound")} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-40">Route incoming calls to workspace</button>
      </div>
      <p className="mt-2 text-xs text-slate-500">Test outbound audio and caller ID first. Routing incoming calls changes where this number rings; the existing supported forwarding route is retained as a fallback.</p>
    </>}
    {message && <p role="status" className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">{message}</p>}
  </section>;
}
