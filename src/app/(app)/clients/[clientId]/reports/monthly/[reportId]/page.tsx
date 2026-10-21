import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MonthlyReportView } from "@/components/monthly-report";
import type { Editorial, MonthlyReportSnapshot } from "@/lib/monthly-report";
import { approveMonthlyReportAction, editMonthlyReportAction, recordMonthlyReportDeliveryAction, submitMonthlyReportAction } from "@/app/monthly-report-actions";

const TZ = "America/Chicago";
const stamp = (s: string | null) => s ? new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ, timeZoneName: "short" }) : "—";
const statusText: Record<string, string> = { draft: "Draft", in_review: "In review", approved: "Approved", superseded: "Superseded", discarded: "Discarded" };

// The exact version Tom reviews is the one he approves: the approval names
// its content hash, and any edit sends it back to draft.
// Action errors arrive as ?error= and are shown by the app's ActionFeedback.
export default async function MonthlyReportPage({ params }: { params: Promise<{ clientId: string; reportId: string }> }) {
  const { clientId, reportId } = await params;
  const db = await createClient();
  const { data: r } = await db.from("monthly_reports").select("*").eq("id", reportId).eq("client_id", clientId).maybeSingle();
  if (!r) notFound();
  const [{ data: deliveries }, { data: others }, { data: portalUsers }, { data: contacts }] = await Promise.all([
    db.from("monthly_report_deliveries").select("id,destination,recipients,outcome,detail,recorded_at").eq("report_id", r.id).order("recorded_at"),
    db.from("monthly_reports").select("id,version,status").eq("client_id", clientId).eq("unit_key", r.unit_key).eq("period", r.period).order("version"),
    db.from("portal_users").select("email").eq("client_id", clientId).eq("is_active", true),
    db.from("client_contacts").select("email").eq("client_id", clientId),
  ]);
  const snapshot = r.snapshot as unknown as MonthlyReportSnapshot;
  const editorial = (r.editorial ?? {}) as Editorial;
  const actions = [0, 1, 2].map(i => editorial.actions?.[i] ?? { action: "", reason: "", owner: "" });
  const sentTo = (deliveries ?? []).find(d => d.outcome === "sent");
  const open = r.status === "draft" || r.status === "in_review";
  const emailDraft = `Subject: ${snapshot.report.client.name} — ${snapshot.report.period_label} report\n\nHi,\n\nYour ${snapshot.report.period_label} report is attached (or in your client portal).\n\n${snapshot.report.observations.map(o => `• ${o.text}`).join("\n")}\n\nNext:\n${(editorial.actions ?? []).map(a => `• ${a.action}`).join("\n")}\n\nThanks,\nCompass Marketing Advisors`;

  return <div className="space-y-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2 print:hidden">
      <div>
        <p className="text-xs text-muted-foreground"><Link className="underline" href={`/clients/${clientId}/reports/monthly`}>Monthly reports</Link> / {snapshot.report.period_label}</p>
        <h2 className="text-lg font-semibold">Version {r.version} · {statusText[r.status] ?? r.status}{sentTo ? " · delivered" : ""}</h2>
        <p className="text-sm text-muted-foreground">
          Versions: {(others ?? []).map((o, i) => <span key={o.id}>{i ? " · " : ""}{o.id === r.id ? <strong>v{o.version}</strong> : <Link className="underline" href={`/clients/${clientId}/reports/monthly/${o.id}`}>v{o.version}</Link>} ({statusText[o.status]})</span>)}
          {r.correction_reason ? ` · Correction: ${r.correction_reason}` : ""}
        </p>
      </div>
      <Link className="text-sm underline" href={`/clients/${clientId}/reports/monthly/${r.id}/print`} target="_blank">Print / save as PDF</Link>
    </div>

    <MonthlyReportView report={snapshot} editorial={editorial} version={r.version} status={r.status} contentHash={r.content_hash}/>

    <div className="space-y-4 print:hidden">
      {open && <form action={editMonthlyReportAction.bind(null, clientId, r.id)} className="surface space-y-3 p-4" aria-labelledby="edit-h">
        <h3 id="edit-h" className="font-semibold">Edit the summary</h3>
        <p className="text-xs text-muted-foreground">The figures are frozen in this version. Editing the text {r.status === "in_review" ? "sends the report back to draft for a fresh review" : "keeps it a draft"}.</p>
        <input type="hidden" name="edit_version" value={r.edit_version}/>
        <div className="space-y-1"><Label htmlFor="causes">Possible causes (one per line; say “possibly”, never claim a cause)</Label>
          <Textarea id="causes" name="causes" rows={3} defaultValue={(editorial.causes ?? []).join("\n")}/></div>
        {actions.map((a, i) => <fieldset key={i} className="grid gap-2 sm:grid-cols-[2fr_2fr_8rem]">
          <legend className="sr-only">Next action {i + 1}</legend>
          <div className="space-y-1"><Label htmlFor={`action_${i}`}>Next action {i + 1}</Label><Input id={`action_${i}`} name={`action_${i}`} defaultValue={a.action}/></div>
          <div className="space-y-1"><Label htmlFor={`reason_${i}`}>Why</Label><Input id={`reason_${i}`} name={`reason_${i}`} defaultValue={a.reason}/></div>
          <div className="space-y-1"><Label htmlFor={`owner_${i}`}>Owner</Label><Input id={`owner_${i}`} name={`owner_${i}`} defaultValue={a.owner}/></div>
        </fieldset>)}
        <div className="space-y-1"><Label htmlFor="note">Note to the client (optional)</Label><Textarea id="note" name="note" rows={2} defaultValue={editorial.note ?? ""}/></div>
        <Button type="submit" variant="outline">Save text</Button>
      </form>}

      {r.status === "draft" && <form action={submitMonthlyReportAction.bind(null, clientId, r.id)} className="surface flex flex-wrap items-center justify-between gap-3 p-4">
        <input type="hidden" name="edit_version" value={r.edit_version}/>
        <p className="text-sm">Ready for Tom&apos;s review? The version and its text are what will be approved.</p>
        <Button type="submit">Submit for review</Button>
      </form>}

      {r.status === "in_review" && (r.is_partial
        ? <p className="surface p-4 text-sm"><strong>Partial preview.</strong> A month in progress cannot be approved. Generate it again after {stamp(r.period_end)}.</p>
        : <form action={approveMonthlyReportAction.bind(null, clientId, r.id)} className="surface space-y-3 p-4" aria-labelledby="approve-h">
          <h3 id="approve-h" className="font-semibold">Approve this exact version</h3>
          <input type="hidden" name="content_hash" value={r.content_hash}/>
          <p className="text-xs text-muted-foreground">Approval covers version {r.version} (content {r.content_hash.slice(0, 19)}…), one destination and exactly these recipients. Nothing is sent.</p>
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <div className="space-y-1"><Label htmlFor="destination">Destination</Label>
              <select id="destination" name="destination" className="field w-full" defaultValue="email"><option value="email">Email (Tom sends)</option><option value="portal">Client portal</option></select></div>
            <div className="space-y-1"><Label htmlFor="recipients">Recipients (this client&apos;s contacts or portal users)</Label>
              <Input id="recipients" name="recipients" required placeholder={[...(contacts ?? []), ...(portalUsers ?? [])].map(c => c.email).filter(Boolean).slice(0, 2).join(", ") || "No contacts recorded"}/></div>
          </div>
          {r.completeness === "incomplete" && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="accept_incomplete"/> Approve as an incomplete report (missing sources are listed in it)</label>}
          <Button type="submit">Approve version {r.version}</Button>
        </form>)}

      {r.status === "approved" && <section className="surface space-y-3 p-4" aria-labelledby="deliver-h">
        <h3 id="deliver-h" className="font-semibold">Delivery</h3>
        <p className="text-sm">Approved {stamp(r.approved_at)} for <strong>{r.approved_destination}</strong> to {(r.approved_recipients ?? []).join(", ")}. Send it yourself, then record what happened. A provider accepting it is &ldquo;uncertain&rdquo;, not sent.</p>
        {r.approved_destination === "email" && <details><summary className="cursor-pointer text-sm underline">Email draft (copy into your mail)</summary><pre className="mt-2 whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs">{emailDraft}</pre></details>}
        {!sentTo && <form action={recordMonthlyReportDeliveryAction.bind(null, clientId, r.id)} className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
          <input type="hidden" name="request_key" value={crypto.randomUUID()}/>
          <div className="space-y-1"><Label htmlFor="outcome">Outcome</Label>
            <select id="outcome" name="outcome" className="field w-full" defaultValue="sent"><option value="sent">Sent (confirmed)</option><option value="uncertain">Uncertain</option><option value="failed">Failed</option></select></div>
          <div className="space-y-1"><Label htmlFor="detail">Detail</Label><Input id="detail" name="detail" maxLength={2000} placeholder="e.g. Sent from Gmail 9:14 am with the PDF attached"/></div>
          <Button type="submit" variant="outline">Record</Button>
        </form>}
      </section>}
      {(deliveries ?? []).length > 0 && <ul className="surface space-y-1 p-4 text-sm">{deliveries!.map(d => <li key={d.id}>{stamp(d.recorded_at)} · {d.destination} · {d.outcome}{d.detail ? ` · ${d.detail}` : ""}</li>)}</ul>}

      <details className="surface p-4">
        <summary className="cursor-pointer text-sm font-semibold">Audit (internal)</summary>
        <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-[12rem_1fr]">
          <dt>Snapshot hash</dt><dd className="break-all font-mono">{r.snapshot_hash}</dd>
          <dt>Content hash</dt><dd className="break-all font-mono">{r.content_hash}</dd>
          <dt>Approved hash</dt><dd className="break-all font-mono">{r.approved_hash ?? "—"}</dd>
          <dt>Calculation</dt><dd>{r.calculation_version}</dd>
          <dt>Month</dt><dd>{stamp(r.period_start)} – {stamp(r.period_end)} (half-open)</dd>
          <dt>Generated</dt><dd>{stamp(r.generated_at)}</dd>
          <dt>Replaces</dt><dd>{r.supersedes_id ?? "—"}</dd>
        </dl>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-[11px]">{JSON.stringify((r.snapshot as { audit?: unknown }).audit ?? null, null, 2)}</pre>
      </details>
    </div>
  </div>;
}
