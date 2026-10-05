import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { previewReader } from "@/lib/creative-preview";
import { plan, type Plan } from "../../../../../../../supabase/functions/creative-engine/govern.ts";
import { findTemplate, FAMILY_NAMES } from "../../../../../../../supabase/functions/creative-engine/registry.ts";
import { LUCAS_PREVIEW_ORDER, lucasPreviewRefs } from "../../../../../../../supabase/functions/creative-engine/previews.ts";
import { KITS } from "../../../../../../../supabase/functions/creative-engine/kits.ts";
import { specHash } from "../../../../../../../supabase/functions/creative-engine/spec.ts";
import { CopyRefusal } from "../../../../../../../supabase/functions/creative-engine/text.ts";
import { RENDERER_ID } from "../../../../../../../supabase/functions/creative-engine/render.ts";
import { Badge } from "@/components/ui/badge";
import { ChannelPolicyForm, RecordPreviewButton, TemplateDecisionButtons } from "@/components/creative/template-approval-forms";
import { isCreativePolicy } from "@/lib/creative-post";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// Creative previews: the cleared template families rendered from this
// client's governed record — approved own-work photos, the approved wordmark,
// governed words only. Rendering here stores nothing. Below each preview, a
// registered template version can be recorded for this client (the
// creative-engine function's preview mode, which proposes it) and then
// approved or revoked by a teammate; only approved versions render posts.
// Nothing here publishes.
const CHANNEL_LABEL: Record<string, string> = {
  google_business: "Business Profile · 1200×900",
  facebook: "Facebook / Instagram · 1080×1350",
  instagram: "Instagram · 1080×1350",
};
const STATUS_STYLE: Record<string, string> = {
  proposed: "border-amber-200 bg-amber-100 text-amber-900",
  approved: "border-green-200 bg-green-100 text-green-800",
  revoked: "border-red-200 bg-red-100 text-red-800",
};
const POLICY_CHANNELS = [
  ["google_business", "Business Profile"],
  ["facebook", "Facebook"],
  ["instagram", "Instagram"],
] as const;

const BLOCKED = [
  ["Review Spotlight", "Needs a governed review record (exact text, reviewer, platform, date, permission). None exists."],
  ["Team & Community", "Needs a governed consent / usage record for the people in a photo. None exists; team photos stay out."],
  ["Seasonal — Offer mode", "Needs a confirmed, current offer. Lucas has none (\"Free quote\" is unverified)."],
];

export default async function CreativePreviewPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("id, name").eq("id", clientId).maybeSingle();
  if (!client) notFound();
  const kit = Object.values(KITS).find((k) => k.client_id === clientId);

  const { facts } = previewReader(supabase);
  const f = kit ? await facts(clientId) : null;
  const rows: { key: string; family: string; channel: string; spec: string; plan: Plan | null; refusal: string | null }[] = [];
  if (kit && f) {
    for (const key of LUCAS_PREVIEW_ORDER) {
      const t = findTemplate(key, 1)!;
      const hash = await specHash(t.spec);
      let p: Plan | null = null;
      let refusal: string | null = null;
      try {
        p = await plan(t.spec, f, { template: { key, version: 1, spec_hash: hash }, client_id: clientId, ...lucasPreviewRefs(key)! });
      } catch (e) {
        if (!(e instanceof CopyRefusal)) throw e;
        refusal = `${e.code}: ${e.message}`;
      }
      rows.push({ key, family: FAMILY_NAMES[t.spec.family], channel: t.channel, spec: hash, plan: p, refusal });
    }
  }

  // Registered versions and this client's approvals. The 4:5 social layout is
  // registered for Facebook and Instagram separately, so each needs its own.
  const keys = rows.flatMap((r) => (r.key.endsWith("-facebook") ? [r.key, r.key.replace(/-facebook$/, "-instagram")] : [r.key]));
  const [{ data: registered }, { data: approvals }, { data: settings }] = kit
    ? await Promise.all([
        supabase.from("creative_templates").select("id, key, version, spec_hash, status").in("key", keys).eq("version", 1),
        supabase.from("client_creative_templates").select("id, template_id, status, preview_asset_id, approved_at").eq("client_id", clientId),
        supabase.from("client_creative_settings").select("channel, creative_policy").eq("client_id", clientId),
      ])
    : [{ data: null }, { data: null }, { data: null }];
  const approvalFor = (key: string) => {
    const t = (registered ?? []).find((x) => x.key === key);
    return { t, a: t ? (approvals ?? []).find((x) => x.template_id === t.id) ?? null : null };
  };

  return (
    <div className="space-y-6">
      <div className="surface space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold">Creative previews</h1>
          <Link href={`/clients/${clientId}/brand/creative-use`} className="ml-auto text-xs underline underline-offset-2">Creative use</Link>
        </div>
        <p className="text-sm text-muted-foreground">
          {client.name}&apos;s cleared template families rendered from the governed record — approved own-work photos
          cropped at their reviewed focal points, the approved wordmark, and words taken from the record (services, sourced
          or confirmed claims, the standing CTA, phone and website). Viewing this page stores nothing. To use a template on
          posts, record its preview for this client, look at it, and approve it. Nothing here publishes.
        </p>
        <p className="text-xs text-muted-foreground" data-renderer>
          {RENDERER_ID} · template versions v1 ({(registered ?? []).length > 0 ? `${(registered ?? []).length} registered` : "not registered"})
        </p>
      </div>

      {!kit && <p className="surface p-4 text-sm">No creative templates exist for this client yet.</p>}

      {rows.map((r) => (
        <section key={r.key} className="surface grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]" data-preview={r.key}>
          <div className="min-w-0 space-y-2">
            <h2 className="text-sm font-semibold">{r.family} <span className="font-normal text-muted-foreground">· {CHANNEL_LABEL[r.channel]}</span></h2>
            {r.refusal ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900" data-refusal>Refused — {r.refusal}</p>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/clients/${clientId}/brand/creative-preview/${r.key}`} alt={`${r.family} preview`} loading="lazy"
                className={`w-full rounded-md border bg-muted ${r.channel === "google_business" ? "max-w-[720px]" : "max-w-[480px]"}`} data-preview-image />
            )}
          </div>
          <div className="min-w-0 space-y-3 text-xs">
            <div>
              <p className="font-medium">Governed lines</p>
              <ul className="mt-1 space-y-0.5">
                {(r.plan ? [...r.plan.lines, ...Object.values(r.plan.lists).flat()] : []).map((l, i) => (
                  <li key={i}><span className="text-muted-foreground">{l.slot} · {l.role.replace(/_/g, " ")}: </span>{l.text}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-medium">Photos (approved own work)</p>
              <ul className="mt-1 space-y-0.5">
                {(r.plan?.photos ?? []).map((p) => (
                  <li key={`${p.slot}${p.index}`} className="break-all">
                    <span className="text-muted-foreground">{p.role} · </span>{p.asset.width}×{p.asset.height} · {p.asset.subjects.join(", ")}
                    <span className="text-muted-foreground"> · crop {Math.round(p.crop.w)}×{Math.round(p.crop.h)} at {Math.round(p.crop.x)},{Math.round(p.crop.y)} ({Math.round(p.crop.scale * 100)}%)</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="break-all text-muted-foreground">{r.key} v1 · spec {r.spec.slice(0, 19)}…{r.plan ? ` · copy ${r.plan.copy_hash.slice(0, 12)}…` : ""}</p>
            <div className="space-y-3 border-t pt-3" data-approvals={r.key}>
              <p className="font-medium">For {client.name}&apos;s posts</p>
              {(r.key.endsWith("-facebook") ? [r.key, r.key.replace(/-facebook$/, "-instagram")] : [r.key]).map((key) => {
                const { t, a } = approvalFor(key);
                const channel = key.endsWith("-gbp") ? "Business Profile" : key.endsWith("-facebook") ? "Facebook" : "Instagram";
                return (
                  <div key={key} className="space-y-1.5" data-approval={key}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{channel}</span>
                      {a && <Badge variant="outline" className={cn("text-[10px]", STATUS_STYLE[a.status])}>{a.status}</Badge>}
                    </div>
                    {!t ? (
                      <p className="text-muted-foreground">Not registered yet.</p>
                    ) : t.spec_hash !== r.spec ? (
                      <p className="text-amber-900">The registered version differs from this code&apos;s; it cannot be recorded here.</p>
                    ) : (
                      <>
                        {a?.preview_asset_id && (
                          <a href={`/clients/${clientId}/creative/${a.preview_asset_id}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                            Recorded preview
                          </a>
                        )}
                        {a?.status !== "approved" && !r.refusal && <RecordPreviewButton clientId={clientId} templateKey={key} again={!!a} />}
                        {a && a.preview_asset_id && <TemplateDecisionButtons clientId={clientId} rowId={a.id} status={a.status} />}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      ))}

      {kit && (
        <section className="surface space-y-3 p-4" data-channel-policies>
          <h2 className="text-sm font-semibold">Graphic policy for new posts</h2>
          <p className="text-xs text-muted-foreground">
            The starting policy for each new post on a channel. A teammate can change it on any draft. “Required” means a post
            cannot be approved without a rendered graphic.
          </p>
          <div className="flex flex-wrap gap-6">
            {POLICY_CHANNELS.map(([ch, label]) => {
              const v = (settings ?? []).find((x) => x.channel === ch)?.creative_policy;
              return <ChannelPolicyForm key={ch} clientId={clientId} channel={ch} label={label} policy={isCreativePolicy(v) ? v : "none"} />;
            })}
          </div>
        </section>
      )}

      {kit && (
        <section className="surface space-y-2 p-4" data-blocked>
          <h2 className="text-sm font-semibold">Still blocked</h2>
          <ul className="space-y-1 text-xs">
            {BLOCKED.map(([name, why]) => <li key={name}><span className="font-medium">{name}: </span>{why}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
