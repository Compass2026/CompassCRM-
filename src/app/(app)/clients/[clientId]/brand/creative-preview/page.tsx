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

export const dynamic = "force-dynamic";

// Creative previews (read-only): the cleared template families rendered from
// this client's governed record — approved own-work photos, the approved
// wordmark, governed words only. Nothing is stored, approved or published.
const CHANNEL_LABEL: Record<string, string> = {
  google_business: "Business Profile · 1200×900",
  facebook: "Facebook / Instagram · 1080×1350",
  instagram: "Instagram · 1080×1350",
};
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

  return (
    <div className="space-y-6">
      <div className="surface space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold">Creative previews</h1>
          <Link href={`/clients/${clientId}/brand/creative-use`} className="ml-auto text-xs underline underline-offset-2">Creative use</Link>
        </div>
        <p className="text-sm text-muted-foreground">
          Preview only: {client.name}&apos;s cleared template families rendered from the governed record — approved own-work
          photos cropped at their reviewed focal points, the approved wordmark, and words taken from the record (services,
          sourced or confirmed claims, the standing CTA, phone and website). Nothing here is stored, approved, scheduled or
          published, and no post is created.
        </p>
        <p className="text-xs text-muted-foreground" data-renderer>{RENDERER_ID} · template versions v1 (not registered)</p>
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
          </div>
        </section>
      ))}

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
