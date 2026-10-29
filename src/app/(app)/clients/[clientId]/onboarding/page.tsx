import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/tasks";
import { agencyToday } from "@/lib/reporting";
import { SECTIONS, STATUSES, isDone, signalText, summarize, waitingOn, type OnboardingRow, type OnboardingStatus, type Section } from "@/lib/client-onboarding";
import { EnrollButton, ItemForm } from "@/components/onboarding/onboarding-forms";

export const dynamic = "force-dynamic";

const pill = "inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap";
const STATUS_STYLE: Record<OnboardingStatus, string> = {
  not_started: "bg-slate-100 text-slate-700", requested: "bg-blue-50 text-blue-800", in_progress: "bg-blue-50 text-blue-800",
  submitted: "bg-sky-50 text-sky-800", claimed: "bg-sky-50 text-sky-800", connected: "bg-sky-50 text-sky-800",
  verified: "bg-emerald-50 text-emerald-800", needs_correction: "bg-red-50 text-red-800", inaccessible: "bg-amber-50 text-amber-800",
  blocked: "bg-red-50 text-red-800", not_applicable: "bg-slate-50 text-slate-500",
};
const TASK_HREF: Record<string, string> = { citation: "citations", gsc: "growth", ga4: "growth", gbp_binding: "social", facebook_binding: "social", access: "", site: "foundation", website_pipeline: "pipelines", location_identity: "citations" };

export default async function OnboardingPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!isUuid(clientId)) notFound();
  const db = await createClient();
  const { data, error } = await db.from("client_onboarding_overview").select("*").eq("client_id", clientId)
    .order("sort_order").order("scope_label").order("id").limit(2000);
  const rows = (data ?? []) as OnboardingRow[];
  const today = agencyToday();
  const sum = summarize(rows, today);
  const base = `/clients/${clientId}`;

  return <div className="space-y-6" data-client-onboarding>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-xl font-semibold">New client onboarding</h2>
        <p className="text-sm text-muted-foreground">Standard v1.0. One checklist per client, site and business location; each item links to the pipeline task, listing or import that backs it.</p></div>
      <EnrollButton clientId={clientId} label={sum.enrolled ? "Add missing items" : "Start the checklist"} />
    </div>
    {error && <p role="alert" className="callout">The checklist could not be read. Refresh to retry.</p>}

    {!error && sum.enrolled && <section className="grid gap-3 sm:grid-cols-3" data-onboarding-summary>
      <div className="surface p-4"><p className="text-xs text-muted-foreground">Required items done</p><p className="text-2xl font-semibold tabular-nums">{sum.done} / {sum.total}</p>
        <p className="text-xs text-muted-foreground">Verified, or not applicable with a reason.</p></div>
      <div className="surface p-4 sm:col-span-2"><p className="text-xs text-muted-foreground">By section</p>
        <ul className="mt-1 grid gap-1 text-sm sm:grid-cols-2">{(Object.keys(SECTIONS) as Section[]).map((s) =>
          <li key={s} className="flex justify-between gap-2"><span>{SECTIONS[s]}</span><span className="tabular-nums">{sum.bySection[s].done} / {sum.bySection[s].total}</span></li>)}</ul></div>
    </section>}

    {!error && sum.outstanding.length > 0 && <section className="surface space-y-2 p-5" data-onboarding-blockers>
      <h3 className="font-semibold">Outstanding blockers</h3>
      <ul className="space-y-1 text-sm">{sum.outstanding.map((o) =>
        <li key={o.row.id}><a className="font-medium hover:underline" href={`#item-${o.row.id}`}>{o.row.title}</a>{o.row.scope_label ? ` · ${o.row.scope_label}` : ""}
          <span className="text-muted-foreground"> — {o.kind === "blocked" ? "Blocked" : o.kind === "correction" ? STATUSES[o.row.status] : "Overdue"}: {o.reason}</span></li>)}</ul>
    </section>}

    {!error && !sum.enrolled && <p className="surface p-8 text-center text-sm text-muted-foreground">
      This client has no onboarding checklist yet. Starting it adds rows only; it changes no pipeline, listing, task or client status.</p>}

    {!error && (Object.keys(SECTIONS) as Section[]).map((section) => {
      const items = rows.filter((r) => r.section === section);
      if (!items.length) return null;
      return <section key={section} className="space-y-3" data-onboarding-section={section}>
        <h3 className="font-semibold">{SECTIONS[section]}</h3>
        {section === "citations" && <p className="text-xs text-muted-foreground">Listings live on the <Link className="underline" href={`${base}/citations`}>Citations tab</Link>; an item is claimed only once its listing is recorded there, and verified only by a current accurate check. No listing on record is not proof it does not exist. Never pay for a listing without Tom&apos;s written approval.</p>}
        {section === "website" && <p className="text-xs text-muted-foreground">The Website pipeline stays the record of the build. Detailed Website Builds checklist: to be added from Tom&apos;s notes.</p>}
        <ul className="space-y-2">{items.map((r) => {
          const waits = waitingOn(r, rows);
          const signal = signalText(r);
          return <li key={r.id} id={`item-${r.id}`} className="surface p-4" data-onboarding-item={r.item_key} data-status={r.status}>
            <details>
              <summary className="flex cursor-pointer list-none flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{r.title}{!r.required && <span className="text-xs text-muted-foreground"> · optional</span>}</p>
                  <p className="text-xs text-muted-foreground">{r.scope === "client" ? "Client" : r.scope === "site" ? `Site: ${r.scope_label ?? "—"}` : `Location: ${r.scope_label ?? "—"}${r.location_hide_address ? " (street hidden)" : ""}`}
                    {" · "}{r.owner}{r.due_on ? ` · due ${r.due_on}` : ""}{r.last_verified_at ? ` · verified ${r.last_verified_at.slice(0, 10)}` : ""}</p>
                </div>
                <span className={`${pill} ${STATUS_STYLE[r.status]}`}>{STATUSES[r.status]}</span>
              </summary>
              <div className="mt-2 space-y-1 text-sm">
                {r.guidance && <p className="text-muted-foreground">{r.guidance}</p>}
                {signal && <p data-onboarding-signal><span className="font-medium">On record:</span> {signal}{r.evidence_source && TASK_HREF[r.evidence_source] !== undefined && <> <Link className="underline" href={`${base}/${TASK_HREF[r.evidence_source]}`}>Open</Link></>}</p>}
                {r.pipeline_task_key && <p><span className="font-medium">Pipeline task:</span> {r.pipeline_task_id ? <Link className="underline" href={`/tasks/${r.pipeline_task_id}`}>{r.pipeline_task_title}</Link> : "none on this client yet"}{r.pipeline_task_status ? ` · ${r.pipeline_task_status}` : ""}</p>}
                {!isDone(r) && waits.length > 0 && <p className="text-amber-800">Waiting on: {waits.map((w) => w.title + (w.scope_label && w.scope !== "client" ? ` (${w.scope_label})` : "")).join("; ")}</p>}
                {r.evidence_url && <p className="break-all"><span className="font-medium">Evidence:</span> <a className="underline" href={r.evidence_url} target="_blank" rel="noreferrer">{r.evidence_url}</a></p>}
                {r.evidence_note && <p><span className="font-medium">Note:</span> {r.evidence_note}</p>}
                {r.blocking_reason && <p className="text-red-800"><span className="font-medium">Blocked:</span> {r.blocking_reason}</p>}
                {r.next_action && <p><span className="font-medium">Next:</span> {r.next_action}</p>}
              </div>
              <ItemForm clientId={clientId} row={r} />
            </details>
          </li>;
        })}</ul>
      </section>;
    })}
  </div>;
}
