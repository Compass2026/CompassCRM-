"use client";
import {useActionState,useState} from "react";
import {recordBacklinkProfileAction} from "@/app/backlink-actions";
import {agencyToday} from "@/lib/reporting";
const fields=[['backlinks_total','Indexed backlinks'],['referring_domains','Referring websites'],['links_new','New links in report period'],['links_lost','Lost links in report period']] as const;
export function BacklinkProfileForm({clientId,sites}:{clientId:string;sites:{name:string;website:string}[]}) {
 const [ids,setIds]=useState<string[]|null>(null);
 return <details className="surface p-5"><summary className="cursor-pointer font-semibold">Record a backlink profile report</summary><p className="mt-3 text-sm text-slate-500">Use a dated provider report or export. Keep the provider and coverage identical between reports. Leave unavailable counts blank. A Search Console sample is not a complete backlink index.</p>{ids?<ProfileEntry key={ids[0]} ids={ids} clientId={clientId} sites={sites} another={()=>setIds(fields.map(()=>crypto.randomUUID()))}/>:<button className="mt-4 rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={!sites.length} onClick={()=>setIds(fields.map(()=>crypto.randomUUID()))}>Add profile measurement</button>}</details>;
}
function ProfileEntry({ids,clientId,sites,another}:{ids:string[];clientId:string;sites:{name:string;website:string}[];another:()=>void}) {
 const [state,action,pending]=useActionState(recordBacklinkProfileAction.bind(null,clientId),{});
 const [values,setValues]=useState<Record<string,string>>({observed_on:agencyToday(),website:sites[0]?.website??''});
 const input=(name:string)=>({name,value:values[name]??'',onChange:(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setValues(v=>({...v,[name]:e.target.value}))});
 if(state.savedId)return <div className="mt-4"><p role="status" className="text-sm text-emerald-700">Profile saved. Its baseline and growth are available in Progress.</p><button onClick={another} className="mt-3 text-sm font-semibold text-blue-700">Record another report</button></div>;
 return <form action={action} className="mt-4 grid gap-4 sm:grid-cols-2" aria-label="Backlink profile report">
 {fields.map(([key],i)=><input type="hidden" key={key} name={`${key}_id`} value={ids[i]}/>)}
 <label className="text-sm">Website / brand<select {...input('website')} className="field-sm mt-1 block w-full">{sites.map(s=><option key={s.website} value={s.website}>{s.name}</option>)}</select></label>
 <label className="text-sm">Provider<input {...input('provider')} required maxLength={100} placeholder="Ahrefs, Semrush, Search Console…" className="field-sm mt-1 block w-full"/></label>
 <label className="text-sm sm:col-span-2">Report coverage<input {...input('coverage')} required maxLength={150} placeholder="Domain including subdomains, live index; or exported sample" className="field-sm mt-1 block w-full"/></label>
 <label className="text-sm">Measured through<input {...input('observed_on')} required type="date" max={agencyToday()} className="field-sm mt-1 block w-full"/></label>
 <label className="text-sm">New/lost report start (if supplied)<input {...input('window_start')} type="date" max={values.observed_on} className="field-sm mt-1 block w-full"/></label>
 {fields.map(([key,label])=><label key={key} className="text-sm">{label}<input {...input(key)} type="number" min="0" max="1000000000000" step="1" placeholder="Not measured" className="field-sm mt-1 block w-full"/></label>)}
 <label className="text-sm sm:col-span-2">Evidence / report reference<textarea {...input('evidence')} required maxLength={1000} placeholder="Report URL or export filename and filters used" className="field-sm mt-1 block w-full"/></label>
 {state.error&&<p role="alert" className="text-sm text-red-700 sm:col-span-2">{state.error}</p>}<button disabled={pending} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white">{pending?'Saving…':'Save measured profile'}</button>
 </form>;
}
