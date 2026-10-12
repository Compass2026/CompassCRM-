"use client";
import { useActionState, useState } from "react";
import { queueBlogAction, cancelBlogPublicationAction } from "@/app/draft-actions";
import type { BlogPublicationSummary } from "@/lib/blog-publications";
export function BlogPublicationControls({draftId,clientId,version,approved,publications}:{
 draftId:string;clientId:string;version:number;approved:boolean;publications:BlogPublicationSummary[];
}) {
 const [queue,queueAction,queuing]=useActionState(queueBlogAction,{});
 const [cancel,cancelAction,cancelling]=useActionState(cancelBlogPublicationAction,{});
 const [time,setTime]=useState("");
 const current=publications.find((p)=>p.draft_version===version && p.status!=="cancelled");
 return <section className="surface space-y-3 p-4 text-sm" data-blog-publication>
   <h3 className="font-semibold">Website publication</h3>
   <p className="text-muted-foreground">This pilot requires team approval. Approval and website publication are separate steps.</p>
   {approved && (!current || current.status==="blocked") && <form action={queueAction} className="flex flex-wrap items-end gap-3">
     <input type="hidden" name="draft_id" value={draftId}/><input type="hidden" name="client_id" value={clientId}/><input type="hidden" name="version" value={version}/>
     <label className="grid gap-1">Publish time (your local time, blank for now)
       <input type="datetime-local" value={time} onChange={(e)=>setTime(e.target.value)} className="rounded border p-2"/>
     </label>
     <input type="hidden" name="scheduled_at" value={time && Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : ""}/>
     <button disabled={queuing} className="rounded border px-3 py-2 font-medium">{queuing?"Queuing…":current?.status==="blocked"?"Retry approved article":"Queue approved article"}</button>
   </form>}
   {!approved && !current && <p>Approve the current article before queuing publication.</p>}
   {(queue.error || cancel.error) && <p role="alert" className="text-red-700">{queue.error || cancel.error}</p>}
   {(queue.text || cancel.text) && <p role="status">{queue.text || cancel.text}</p>}
   {publications.map((p)=><div key={p.id} className="space-y-1 border-t pt-3">
     <p>Version {p.draft_version}: <strong>{p.status}</strong></p>
     <p className="text-xs">Scheduled: {new Date(p.scheduled_at).toLocaleString("en-US",{timeZone:"America/Chicago"})} Central</p>
     {p.last_error && <p className="text-amber-800">{p.last_error}</p>}
     {p.published_url && <a href={p.published_url} target="_blank" rel="noreferrer" className="underline">View verified live article</a>}
     {p.status==="queued" && <form action={cancelAction}><input type="hidden" name="publication_id" value={p.id}/><button disabled={cancelling} className="underline">Cancel queued publication</button></form>}
   </div>)}
 </section>;
}
