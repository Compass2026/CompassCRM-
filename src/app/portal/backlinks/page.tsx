import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { loadPortalBacklinks } from "@/lib/growth-data";
import { backlinkStatus } from "@/lib/backlinks";
import { growthDate } from "@/lib/client-growth";

export default async function PortalBacklinksPage() {
  const db=await createClient();
  const {data:client}=await db.from("portal_client").select("id").maybeSingle();
  if(!client?.id) notFound();
  const {rows,error}=await loadPortalBacklinks(db,client.id);
  const live=rows.filter(r=>backlinkStatus(r,true)==="Verified live");
  const domains=new Set(live.map(r=>new URL(r.source_url).hostname.replace(/^www\./,"")));
  return <div className="space-y-5"><div className="rounded-2xl bg-navy-900 p-6 text-white"><p className="text-xs uppercase tracking-wider text-blue-200">Building your authority</p><h1 className="mt-2 text-2xl font-semibold text-white">Your backlink growth</h1><p className="mt-2 text-sm text-blue-100">Relevant websites linking to your pages, with dated verification.</p></div>{error?<p role="alert" className="callout">{error}</p>:<><div className="grid gap-4 sm:grid-cols-3">{[["Verified live links",live.length],["Verified referring websites",domains.size],["Previously verified placements",rows.length]].map(([label,value])=><div key={label} className="surface p-5"><p className="text-3xl font-semibold">{value}</p><p className="mt-1 text-sm text-muted-foreground">{label}</p></div>)}</div><p className="text-xs text-muted-foreground">These are placements tracked by Compass, not a complete inventory of all links on the web. Checks older than 30 days are due for review. A page that could not be reached is not counted as a lost link.</p>{!rows.length?<p className="surface p-8 text-center text-sm text-muted-foreground">Verified placements will appear here as your link-building work progresses.</p>:<div className="grid gap-4 sm:grid-cols-2">{rows.map(r=><article className="surface min-w-0 p-5" key={r.id}><p className="text-xs font-semibold text-blue-700">{backlinkStatus(r,true)}</p><h2 className="mt-2 font-semibold">{r.title}</h2><p className="mt-2 text-sm text-muted-foreground">{r.keyword}{r.brand_name?` · ${r.brand_name}`:""}</p><p className="mt-3 break-all text-sm"><a className="text-blue-700 underline" target="_blank" rel="noreferrer" href={r.source_url}>View referring page</a></p><p className="mt-2 break-all text-xs text-muted-foreground">Links to: <a className="underline" href={r.target_url} target="_blank" rel="noreferrer">{r.target_url}</a></p><p className="mt-3 text-xs text-muted-foreground">First verified {growthDate(r.first_live_on)} · Last checked {growthDate(r.observed_on)} · {r.rel}</p></article>)}</div>}</>}</div>;
}
