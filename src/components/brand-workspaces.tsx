import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { saveBrandWorkspace, reviewBrandWorkspace } from '@/app/brand-workspace-actions';
import { WORKSPACE_LIST_FIELDS, WORKSPACE_TEXT_FIELDS, type BrandWorkspace } from '@/lib/brand-workspaces';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card,CardHeader,CardTitle,CardContent } from '@/components/ui/card';

export async function BrandWorkspaces({clientId,workspaces,selected}:{clientId:string;workspaces:BrandWorkspace[];selected?:string}) {
  const b=workspaces.find(x=>x.slug===selected)??workspaces[0];
  const db=await createClient();
  const [services,keywords,claims,assets,sites,accounts]=await Promise.all([
    db.from('services').select('id,name,page_url').eq('client_id',clientId).order('sort_order'),
    db.from('keywords').select('id,keyword,service_id,target_url,intent').eq('client_id',clientId).eq('is_active',true).order('keyword'),
    db.from('claims').select('id,claim,status,source').eq('client_id',clientId),
    db.from('brand_assets').select('id,label,kind').eq('client_id',clientId).order('sort_order'),
    db.from('sites').select('id,url,content_adapter').eq('client_id',clientId),
    db.from('social_accounts').select('id,platform,display_name,publish_enabled').eq('client_id',clientId),
  ]);
  for(const r of [services,keywords,claims,assets,sites,accounts]) if(r.error) throw new Error(r.error.message);
  const ownKeywords=(keywords.data??[]).filter(k=>k.service_id&&b.service_ids.includes(k.service_id));
  const gbp=(accounts.data??[]).find(a=>a.platform==='google_business');
  const fb=(accounts.data??[]).find(a=>a.id===b.facebook_account_id);
  const palette=(Array.isArray(b.palette)?b.palette:[]) as {name:string;hex:string}[];
  const owner=(service:string)=>workspaces.find(w=>w.id!==b.id&&w.service_ids.includes(service));
  return <div className="space-y-6" data-brand-workspaces>
    <div className="rounded-xl border bg-muted/30 p-4 text-sm">
      <strong>One client account, separate brand profiles.</strong> Each service and its keywords select the correct brand for drafting and review.
      <p className="mt-2 text-muted-foreground">GBP uses one shared client calendar. Facebook Pages and blog sites are assigned per brand. Billing and content allowances remain on the existing agreement.</p>
    </div>
    <nav aria-label="Client brands" className="flex flex-wrap gap-3">{workspaces.map(w=><Link key={w.id} aria-current={w.id===b.id?'page':undefined} href={`/clients/${clientId}/brand?brand=${w.slug}`} className={`rounded-xl border px-4 py-3 ${w.id===b.id?'border-blue-500 bg-blue-50 text-blue-950':'bg-card'}`}><span className="font-semibold">{w.name}</span><span className="ml-3 text-xs">{w.status==='approved'?'Approved':'Needs review'}</span></Link>)}</nav>
    <Card><CardHeader><CardTitle>{b.name}</CardTitle></CardHeader><CardContent className="space-y-4">
      <div className="flex flex-wrap items-center gap-3"><Badge variant="outline">{b.status==='approved'?'Approved':'Draft'} · v{b.version}</Badge><a href={`tel:${b.phone.replace(/[^+\d]/g,'')}`}>{b.phone}</a><a href={b.website_url} target="_blank" rel="noreferrer" className="underline">{b.website_url}</a></div>
      <p>{b.positioning}</p>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border p-3"><strong>Blog</strong><p className="text-sm">{b.blog_site_id?'Website assigned; article approval required':'Website publishing connection needed'}</p></div>
        <div className="rounded-lg border p-3"><strong>Facebook</strong><p className="text-sm">{fb?`${fb.display_name??'Page assigned'} · ${fb.publish_enabled?'publishing enabled':'publishing not enabled'}`:'Awaiting this brand’s Facebook Page'}</p></div>
        <div className="rounded-lg border p-3"><strong>Shared GBP</strong><p className="text-sm">{gbp?`${gbp.display_name??'Shared profile'} · ${gbp.publish_enabled?'publishing enabled':'publishing not enabled'}`:'Existing shared profile awaits CRM connection'}</p></div>
      </div>
      <form action={reviewBrandWorkspace.bind(null,clientId,b.id,b.version,b.status!=='approved')}><Button type="submit" variant={b.status==='approved'?'outline':'default'}>{b.status==='approved'?'Reopen this brand':'Approve this brand'}</Button></form>
      <p className="text-xs text-muted-foreground">Brand approval does not approve posts or enable publishing. Saving changes returns this brand to draft.</p>
    </CardContent></Card>
    <Card><CardHeader><CardTitle>Keywords for {b.name}</CardTitle></CardHeader><CardContent>
      {ownKeywords.length?<ul className="grid gap-2 text-sm md:grid-cols-2">{ownKeywords.map(k=><li key={k.id}>{k.keyword} <span className="text-muted-foreground">· {k.intent??'Intent needed'}{k.target_url?'':' · Owner page needed'}</span></li>)}</ul>:<p className="text-sm text-muted-foreground">Assign this brand’s services below, then complete their keyword and owner-page mappings. Another brand’s keywords are not used as a fallback.</p>}
      <Link href={`/clients/${clientId}/planner`} className="mt-4 inline-block underline text-sm">Open the client content calendar</Link>
    </CardContent></Card>
    <form key={`${b.id}:${b.version}`} action={saveBrandWorkspace.bind(null,clientId,b.id,b.version)} className="space-y-6">
      <Card><CardHeader><CardTitle>Brand identity and guidance</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
        {(['name','phone','website_url'] as const).map(k=><label key={k} className="space-y-1 text-sm"><span>{k==='website_url'?'Website':k==='phone'?'Phone':'Brand name'}</span><input className="field w-full" name={k} defaultValue={b[k]} required /></label>)}
        {WORKSPACE_TEXT_FIELDS.map(([k,label])=><label key={k} className="space-y-1 text-sm"><span>{label}</span><textarea className="field w-full min-h-24" name={k} defaultValue={b[k]}/></label>)}
        {WORKSPACE_LIST_FIELDS.map(([k,label])=><label key={k} className="space-y-1 text-sm"><span>{label} (one per line)</span><textarea className="field w-full min-h-24" name={k} defaultValue={b[k].join('\n')}/></label>)}
        <label className="space-y-1 text-sm"><span>Brand colors (Color name | #rrggbb, one per line)</span><textarea className="field w-full min-h-24" name="palette" defaultValue={palette.map(c=>`${c.name} | ${c.hex}`).join('\n')}/></label>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Services, evidence and images</CardTitle></CardHeader><CardContent className="grid gap-6 lg:grid-cols-3">
        <fieldset><legend className="mb-3 font-medium">Services and their keywords</legend>{(services.data??[]).map(s=><label key={s.id} className="mb-3 flex gap-2 text-sm"><input type="checkbox" name="service_ids" value={s.id} defaultChecked={b.service_ids.includes(s.id)} disabled={!!owner(s.id)}/><span>{s.name}{owner(s.id)&&<small className="block text-muted-foreground">Assigned to {owner(s.id)!.name}</small>}</span></label>)}</fieldset>
        <fieldset><legend className="mb-3 font-medium">Claims this brand may use</legend>{(claims.data??[]).map(c=><label key={c.id} className="mb-3 flex gap-2 text-sm"><input type="checkbox" name="claim_ids" value={c.id} defaultChecked={b.claim_ids.includes(c.id)}/><span>{c.claim}<small className="block text-muted-foreground">{c.status}{c.source?` · ${c.source}`:''}</small></span></label>)}</fieldset>
        <fieldset><legend className="mb-3 font-medium">Approved source selection</legend><p className="mb-3 text-xs text-muted-foreground">Assign only this brand’s logos and imagery. Existing creative-use review still applies.</p>{(assets.data??[]).map(a=><label key={a.id} className="mb-3 flex gap-2 text-sm"><input type="checkbox" name="asset_ids" value={a.id} defaultChecked={b.asset_ids.includes(a.id)}/><span>{a.label??a.kind}<small className="block text-muted-foreground">{a.kind}</small></span></label>)}</fieldset>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Publishing destinations</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1 text-sm"><span>Blog website</span><select name="blog_site_id" className="field w-full" defaultValue={b.blog_site_id??''}><option value="">Awaiting website connection</option>{(sites.data??[]).map(s=><option key={s.id} value={s.id}>{s.url??'Website without a live URL'} · {s.content_adapter??'Adapter needed'}</option>)}</select></label>
        <label className="space-y-1 text-sm"><span>Facebook Page</span><select name="facebook_account_id" className="field w-full" defaultValue={b.facebook_account_id??''}><option value="">Awaiting Facebook connection</option>{(accounts.data??[]).filter(a=>a.platform==='facebook').map(a=><option key={a.id} value={a.id}>{a.display_name??a.id}</option>)}</select></label>
        <p className="text-sm text-muted-foreground md:col-span-2">All brands share the existing client GBP connection. Assigning a destination here does not connect an account or enable automatic publishing.</p>
      </CardContent></Card>
      <Button type="submit">Save {b.name}</Button>
    </form>
  </div>;
}
