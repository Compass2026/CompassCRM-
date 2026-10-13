import Link from 'next/link';
import {ArrowRight,ClipboardCheck} from 'lucide-react';
import type {OperationalCard} from '@/lib/operations-evidence';
const labels={recorded:'Evidence recorded',attention:'Needs attention',setup:'Setup / awaiting evidence',unknown:'Unavailable'};
const tones={recorded:'bg-emerald-50 text-emerald-800',attention:'bg-orange-50 text-orange-900',setup:'bg-blue-50 text-blue-800',unknown:'bg-slate-100 text-slate-700'};
const stamp=(s:string|null)=>s?new Date(s).toLocaleString('en-US',{timeZone:'America/Chicago',dateStyle:'medium',timeStyle:'short'})+' CT':'Not recorded';
export function OperationalEvidencePanel({cards,clients}:{cards:OperationalCard[];clients:{id:string;name:string}[]}){
 return <section className="space-y-4" aria-label="Operational delivery and work">
  <div className="rounded-2xl border border-slate-200 bg-white p-5"><h3 className="flex items-center gap-2 font-semibold text-navy-900"><ClipboardCheck className="size-5 text-blue-700"/>Operational delivery & work</h3><p className="mt-2 text-xs leading-5 text-slate-600">Rankings, backlinks, social, websites, inquiry notifications and billing. Each card states what the recorded evidence proves. Configuration, a queued job and provider delivery are separate facts.</p></div>
  {clients.map(client=><section key={client.id} className="space-y-3" data-operational-client={client.id}><h4 className="text-sm font-semibold text-navy-900">{client.name}</h4><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
   {cards.filter(c=>c.clientId===client.id).map(card=><article key={card.key} data-operational-system={card.key} className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-sm font-semibold text-navy-900">{card.label}</h5><span className={'rounded-full px-2 py-1 text-[10px] font-semibold '+tones[card.state]}>{labels[card.state]}</span></div><p className="mt-3 break-words text-xs leading-5 text-slate-600">{card.evidence}</p><dl className="mt-3 space-y-2 text-xs"><div><dt className="text-slate-500">Last recorded attempt</dt><dd className="text-slate-800">{stamp(card.lastAttempt)}</dd></div><div><dt className="text-slate-500">Latest supporting evidence</dt><dd className="text-slate-800">{stamp(card.lastEvidence)}</dd></div></dl><Link href={card.href} className="mt-3 flex items-start gap-2 rounded-lg bg-blue-50 p-3 text-xs font-medium leading-5 text-blue-900"><ArrowRight className="mt-0.5 size-4 shrink-0"/>{card.nextAction}</Link></article>)}
  </div></section>)}
 </section>;
}
