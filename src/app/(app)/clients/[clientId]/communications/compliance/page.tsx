import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChecklistItemForm,
  EnsureChecklistButton,
  FunctionButton,
  LinkRegistrationForm,
  RegistrationForm,
  RestrictionForm,
  type RegistrationValues,
} from "@/components/communications/forms";
import { fmtDate, fmtDateTime, pipelineTone, registrationTone } from "@/components/communications/format";
import { loadChecklist, loadCommsSetup, type CommsRegistration } from "@/lib/communications-data";
import { PIPELINE_LABELS, PIPELINE_STATUSES, REGISTRATION_LABELS, formatPhone } from "@/lib/communications";
import { cn } from "@/lib/utils";

const TITLES = {
  secondary_customer_profile: "Business profile (secondary customer profile)",
  toll_free_verification: "Toll-free verification",
} as const;

// Compliance: the business profile and the toll-free verification as Twilio
// reports them (synced, never typed), the Compass checklist before
// submitting, and a teammate's restriction when one is needed.
export default async function CompliancePage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const supabase = await createClient();
  const [setup, checklist] = await Promise.all([loadCommsSetup(supabase, clientId), loadChecklist(supabase, clientId)]);
  const numbers = setup.numbers.filter((n) => n.status === "active").map((n) => ({ id: n.id, label: formatPhone(n.phone_number_e164) }));
  const byType = (t: CommsRegistration["profile_type"]) => setup.registrations.filter((r) => r.profile_type === t);
  const canSync = !!setup.account && setup.registrations.some((r) => r.provider_profile_sid);
  // The forward steps; "Not configured" only while it is where things stand.
  const order = PIPELINE_STATUSES.filter((s) => !["rejected", "restricted", "blocked"].includes(s)
    && (s !== "not_configured" || setup.pipeline === "not_configured"));
  const reached = order.indexOf(setup.pipeline as (typeof order)[number]);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Where SMS stands</CardTitle>
          {canSync && <FunctionButton clientId={clientId} mode="sync_compliance" label="Sync with Twilio" />}
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="flex flex-wrap gap-2 text-xs">
            {order.map((s, i) => (
              <li key={s} className={cn("rounded-full border px-2.5 py-0.5",
                s === setup.pipeline ? pipelineTone(s) : reached >= 0 && i < reached ? "border-green-200 bg-green-50 text-green-800" : "border-zinc-200 text-zinc-500")}>
                {PIPELINE_LABELS[s]}
              </li>
            ))}
          </ol>
          {["rejected", "restricted", "blocked"].includes(setup.pipeline) && (
            <p className={cn("inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium", pipelineTone(setup.pipeline))}>{PIPELINE_LABELS[setup.pipeline]}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Twilio&apos;s statuses are read by Sync and shown as Twilio reports them. Restricted and blocked are Compass&apos;s own marks, set below.
            Registrations are submitted in the Twilio Console (in the client&apos;s subaccount); link the SID here to track them.
            Compass never stores the EIN: enter it from the business&apos;s IRS record in the Twilio Console.
          </p>
        </CardContent>
      </Card>

      {(["secondary_customer_profile", "toll_free_verification"] as const).map((type) => {
        const regs = byType(type);
        return (
          <Card key={type}>
            <CardHeader><CardTitle>{TITLES[type]}</CardTitle></CardHeader>
            <CardContent className="space-y-5">
              {regs.length === 0 && (
                <RegistrationForm clientId={clientId} profileId={null} profileType={type} values={null} numbers={numbers} />
              )}
              {regs.map((r) => {
                const items = checklist.filter((i) => i.profile_id === r.id);
                const done = items.filter((i) => i.status !== "open").length;
                return (
                  <div key={r.id} className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", registrationTone(r.status))}>{REGISTRATION_LABELS[r.status]}</span>
                      {r.provider_status && <span className="text-xs text-muted-foreground">Twilio: {r.provider_status}</span>}
                      {r.restriction && <span className="rounded-full border border-red-200 bg-red-50 px-2.5 py-0.5 text-xs text-red-800">{r.restriction}: {r.restriction_reason}</span>}
                    </div>
                    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
                      <dt className="text-muted-foreground">Submitted</dt><dd>{fmtDate(r.submitted_at)}</dd>
                      <dt className="text-muted-foreground">Approved</dt><dd>{fmtDate(r.approved_at)}</dd>
                      <dt className="text-muted-foreground">Rejected</dt><dd>{r.rejected_at ? `${fmtDate(r.rejected_at)}${r.rejection_code ? ` · code ${r.rejection_code}` : ""}` : "—"}</dd>
                      {r.rejection_reason && <><dt className="text-muted-foreground">Rejection reason</dt><dd className="text-red-800">{r.rejection_reason}{r.edit_allowed ? " (Twilio allows an edit and resubmission)" : ""}</dd></>}
                      <dt className="text-muted-foreground">Privacy Policy</dt><dd>{r.privacy_url ? <a className="text-primary hover:underline" href={r.privacy_url} target="_blank" rel="noreferrer">{r.privacy_url}</a> : <span className="text-amber-900">missing</span>}</dd>
                      <dt className="text-muted-foreground">Terms</dt><dd>{r.terms_url ? <a className="text-primary hover:underline" href={r.terms_url} target="_blank" rel="noreferrer">{r.terms_url}</a> : <span className="text-amber-900">missing</span>}</dd>
                      {type === "toll_free_verification" && <><dt className="text-muted-foreground">Opt-in page</dt><dd>{r.opt_in_url ? <a className="text-primary hover:underline" href={r.opt_in_url} target="_blank" rel="noreferrer">{r.opt_in_url}</a> : <span className="text-amber-900">missing</span>}</dd></>}
                      <dt className="text-muted-foreground">Last synced</dt><dd>{fmtDateTime(r.last_synced_at)}</dd>
                    </dl>

                    {type === "toll_free_verification" && (
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium">Before submitting {items.length > 0 && <span className="text-muted-foreground">({done}/{items.length})</span>}</p>
                          {items.length === 0 && <EnsureChecklistButton clientId={clientId} profileId={r.id} />}
                        </div>
                        <div className="divide-y">
                          {items.map((i) => <ChecklistItemForm key={i.id} clientId={clientId} item={i} />)}
                        </div>
                      </div>
                    )}

                    <details className="rounded-lg border p-3">
                      <summary className="cursor-pointer text-sm font-medium">Details for the submission</summary>
                      <div className="pt-3">
                        <RegistrationForm clientId={clientId} profileId={r.id} profileType={type}
                          values={r as unknown as RegistrationValues} numbers={numbers} />
                      </div>
                    </details>
                    <LinkRegistrationForm clientId={clientId} profileId={r.id} sid={r.provider_profile_sid}
                      prefix={type === "toll_free_verification" ? "HH" : "BU"} />
                    <RestrictionForm clientId={clientId} profileId={r.id} restriction={r.restriction} reason={r.restriction_reason} />
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
