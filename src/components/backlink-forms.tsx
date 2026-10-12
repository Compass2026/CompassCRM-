"use client";
import { useActionState, useState } from "react";
import { addBacklinkAction, updateBacklinkAction, recordBacklinkCheckAction, type BacklinkActionState } from "@/app/backlink-actions";
import { BACKLINK_KINDS, BACKLINK_STAGES, type BacklinkOpportunity } from "@/lib/backlinks";
import { agencyToday } from "@/lib/reporting";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export type BacklinkKeyword={id:string;keyword:string;target_url:string|null;service_id:string|null};
export type BacklinkBrand={id:string;name:string;website_url:string;service_ids:string[]};
// Keep entered values when an action returns a validation or save error.
// Successful create/check forms are replaced; progress forms remount on updated_at.
function Outcome({state}:{state:BacklinkActionState}) {return <>{state.error&&<p role="alert" className="text-sm text-red-700">{state.error}</p>}{state.savedId&&<p role="status" className="text-sm text-emerald-700">Saved successfully.</p>}</>;}
export function AddBacklinkForm({clientId,keywords,brands,websiteUrl}:{clientId:string;keywords:BacklinkKeyword[];brands:BacklinkBrand[];websiteUrl:string|null}) {
  const [entry,setEntry]=useState<string|null>(null);
  return <details className="surface p-5"><summary className="cursor-pointer font-semibold">Add a backlink opportunity</summary>
    <p className="mt-3 text-sm text-muted-foreground">Choose a keyword first. Research a relevant website, then track outreach and placement here.</p>
    {!entry?<Button className="mt-4" onClick={()=>setEntry(crypto.randomUUID())} disabled={!keywords.length}>Start an opportunity</Button>:<CreateForm key={entry} id={entry} clientId={clientId} keywords={keywords} brands={brands} websiteUrl={websiteUrl} another={()=>setEntry(crypto.randomUUID())}/>}
    {!keywords.length&&<p className="mt-2 text-sm">Add an active keyword before creating opportunities.</p>}
  </details>;
}
function CreateForm({id,clientId,keywords,brands,websiteUrl,another}:{id:string;clientId:string;keywords:BacklinkKeyword[];brands:BacklinkBrand[];websiteUrl:string|null;another:()=>void}) {
  const [state,action,pending]=useActionState(addBacklinkAction.bind(null,clientId),{});
  const [keywordId,setKeywordId]=useState("");
  const keyword=keywords.find(k=>k.id===keywordId),brand=brands.find(b=>keyword?.service_id&&b.service_ids.includes(keyword.service_id));
  const [target,setTarget]=useState("");
  function choose(id:string) {
    setKeywordId(id);
    const k=keywords.find(k=>k.id===id),b=brands.find(b=>k?.service_id&&b.service_ids.includes(k.service_id));
    try{setTarget(k?.target_url?new URL(k.target_url,b?.website_url??websiteUrl??undefined).href:"");}catch{setTarget("");}
  }
  if(state.savedId) return <div className="mt-4 space-y-3"><Outcome state={state}/><Button variant="outline" onClick={another}>Add another opportunity</Button></div>;
  return <form onReset={event=>event.preventDefault()} action={action} className="mt-4 space-y-4">
    <input type="hidden" name="id" value={id}/><input type="hidden" name="brand_workspace_id" value={brand?.id??""}/>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm">Target keyword<select name="keyword_id" required className="field-sm block w-full" value={keywordId} onChange={e=>choose(e.target.value)}><option value="">Choose a keyword</option>{keywords.map(k=><option key={k.id} value={k.id}>{k.keyword}</option>)}</select></label>
      <label className="space-y-1 text-sm">Target page<Input name="target_url" type="url" required maxLength={2000} value={target} onChange={e=>setTarget(e.target.value)} placeholder="https://client.com/service"/></label>
      <label className="space-y-1 text-sm">Client-facing title<Input name="title" required maxLength={200} placeholder="Local association member listing"/></label>
      <label className="space-y-1 text-sm">Source page URL<Input name="source_url" type="url" required maxLength={2000} placeholder="https://association.com/members/client"/></label>
      <label className="space-y-1 text-sm">Opportunity type<select name="kind" className="field-sm block w-full">{Object.entries(BACKLINK_KINDS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label className="space-y-1 text-sm">Next action due<Input name="due_on" type="date"/></label>
    </div>
    {brands.length>0&&<p className="text-sm">Brand: {brand?.name??"Choose a keyword assigned to a brand's service."}</p>}
    <label className="block space-y-1 text-sm">Next action<Input name="next_action" maxLength={1000} placeholder="Check listing requirements and editorial fit"/></label>
    <label className="block space-y-1 text-sm">Internal notes<Textarea name="notes" maxLength={4000} placeholder="Relevance, contact research, placement requirements"/></label>
    <p className="text-xs text-muted-foreground">The source page and target are fixed after saving to preserve verification history. Record a new opportunity if either URL changes. Saving does not send outreach.</p>
    <Outcome state={state}/><Button disabled={pending||brands.length>0&&!brand}>{pending?"Saving…":"Save opportunity"}</Button>
  </form>;
}
export function BacklinkProgressForm({opportunity:o}:{opportunity:BacklinkOpportunity}) {
  const [state,action,pending]=useActionState(updateBacklinkAction.bind(null,o.client_id,o.id),{});
  return <form onReset={event=>event.preventDefault()} action={action} className="space-y-3"><input name="updated_at" type="hidden" value={o.updated_at}/><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm">Stage<select name="stage" className="field-sm block w-full" defaultValue={o.stage}>{Object.entries(BACKLINK_STAGES).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label className="space-y-1 text-sm">Due date<Input name="due_on" type="date" defaultValue={o.due_on??""}/></label></div><label className="block space-y-1 text-sm">Next action<Input name="next_action" maxLength={1000} defaultValue={o.next_action}/></label><label className="block space-y-1 text-sm">Internal notes<Textarea name="notes" maxLength={4000} defaultValue={o.notes}/></label><Outcome state={state}/><Button size="sm" variant="outline" disabled={pending}>{pending?"Saving…":"Save progress"}</Button></form>;
}
export function BacklinkCheckForm({clientId,id}:{clientId:string;id:string}) {
  const [entry,setEntry]=useState<string|null>(null);
  return entry?<CheckForm key={entry} entry={entry} clientId={clientId} id={id} another={()=>setEntry(crypto.randomUUID())}/>:<Button variant="outline" size="sm" onClick={()=>setEntry(crypto.randomUUID())}>Record a link check</Button>;
}
function CheckForm({entry,clientId,id,another}:{entry:string;clientId:string;id:string;another:()=>void}) {
  const [state,action,pending]=useActionState(recordBacklinkCheckAction.bind(null,clientId,id),{});
  if(state.savedId) return <div className="space-y-2"><Outcome state={state}/><Button variant="outline" size="sm" onClick={another}>Record another check</Button></div>;
  return <form onReset={event=>event.preventDefault()} action={action} className="space-y-3"><input type="hidden" name="id" value={entry}/><p className="text-xs text-muted-foreground">Open the source page and confirm the exact target link. Record what you observed; this form does not crawl the page.</p><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm">Checked on<Input name="observed_on" required type="date" defaultValue={agencyToday()} max={agencyToday()}/></label><label className="space-y-1 text-sm">Result<select name="result" className="field-sm block w-full"><option value="live">Target link is live</option><option value="missing">Target link is missing</option><option value="unreachable">Page could not be checked</option></select></label><label className="space-y-1 text-sm">Link attribute<select name="rel" className="field-sm block w-full" defaultValue="unknown">{["unknown","follow","nofollow","sponsored","ugc"].map(r=><option key={r}>{r}</option>)}</select></label><label className="space-y-1 text-sm">Anchor text<Input name="anchor_text" maxLength={500}/></label></div><label className="block space-y-1 text-sm">Evidence<Textarea name="evidence" required maxLength={2000} placeholder="Where the link appears, exact target confirmed, screenshot or audit reference"/></label><Outcome state={state}/><Button size="sm" disabled={pending}>{pending?"Saving…":"Save link check"}</Button></form>;
}
