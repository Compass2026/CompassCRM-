import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentTeamRole } from "@/lib/team";
import { formatPhone } from "@/lib/communications";
import { BLOCK_REASON_LABELS, JOB_STATUS_LABELS, alertGates, formatWhen } from "@/lib/inquiries";
import {
  ChooseSenderForm,
  ConfirmTestForm,
  ConsentForm,
  CrmLiteSettingsForm,
  DeliveryTestForm,
  RecipientForm,
  RecipientToggle,
  SenderForm,
  SmsSwitch,
  SourceControls,
  SourceForm,
} from "@/components/inquiries/setup-forms";
import { cn } from "@/lib/utils";

// Client › Inquiries › Setup & alerts (CRM Lite): the switch, the website
// source and its token, and the SMS alert foundation with every gate shown.
// Nothing here sends a text except an admin's explicit delivery test.
export default async function CrmLiteSetupPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const supabase = await createClient();
  const me = await getCurrentTeamRole(supabase);
  const isAdmin = me?.role === "admin";
  const [{ data: settings }, { data: sources }, { data: senders }, { data: recipients }, { data: jobs }] = await Promise.all([
    supabase.from("crm_lite_settings").select("*").eq("client_id", clientId).maybeSingle(),
    supabase.from("inquiry_sources").select("*").eq("client_id", clientId).order("created_at"),
    supabase.from("notification_senders").select("*").order("created_at"),
    supabase.from("notification_recipients").select("*").eq("client_id", clientId).order("created_at"),
    supabase.from("notification_jobs").select("id, kind, status, block_reason, provider_status, error_code, created_at, recipient_id")
      .eq("client_id", clientId).order("created_at", { ascending: false }).limit(10),
  ]);
  const sender = (senders ?? []).find((s) => s.id === settings?.sms_sender_id) ?? null;
  const credentialNames = sender ? [`TWILIO_SUB_${sender.provider_account_sid}_API_KEY`, `TWILIO_SUB_${sender.provider_account_sid}_API_SECRET`, `TWILIO_SUB_${sender.provider_account_sid}_AUTH_TOKEN`] : [];
  const present = await Promise.all(credentialNames.map((n) => supabase.rpc("secret_present", { secret_name: n }).then((r) => r.data === true)));
  const testJobs = new Map((jobs ?? []).map((j) => [j.id, j]));
  const testIds = (recipients ?? []).map((r) => r.delivery_test_job_id).filter((x): x is string => !!x && !testJobs.has(x));
  if (testIds.length) {
    const { data } = await supabase.from("notification_jobs").select("id, kind, status, block_reason, provider_status, error_code, created_at, recipient_id").in("id", testIds);
    for (const j of data ?? []) testJobs.set(j.id, j);
  }
  const gates = alertGates({
    settingsEnabled: !!settings?.enabled,
    smsAlertsEnabled: !!settings?.sms_alerts_enabled,
    sender: sender ? { verification_status: sender.verification_status, enabled: sender.enabled } : null,
    senderCredentialsPresent: sender ? present.every(Boolean) : null,
    recipients: recipients ?? [],
  });
  const card = "space-y-3 rounded-xl border bg-card p-4";
  const h = "text-sm font-semibold uppercase tracking-wider text-muted-foreground";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href={`/clients/${clientId}/inquiries`} className="inline-flex text-xs font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground">
        &larr; Inquiries
      </Link>
      <h2 className="text-lg font-semibold text-navy-900">CRM Lite setup &amp; alerts</h2>

      <section className={card}>
        <h3 className={h}>CRM Lite</h3>
        <CrmLiteSettingsForm clientId={clientId} enabled={!!settings?.enabled} portalEnabled={!!settings?.portal_enabled}
          displayName={settings?.display_name ?? null} notes={settings?.notes ?? null} />
      </section>

      <section className={card}>
        <h3 className={h}>Website sources</h3>
        <p className="text-sm text-muted-foreground">
          The website&apos;s server posts each inquiry to <code>inquiry-intake</code> with the source key and its token. The client is the
          source&apos;s; the website never names it.
        </p>
        <ul className="space-y-3">
          {(sources ?? []).map((s) => (
            <li key={s.id} className="rounded-lg border p-3 text-sm" data-source={s.source_key}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{s.label}</span>
                <code className="text-xs">{s.source_key}</code>
                <span className={cn("rounded-full border px-2 py-0.5 text-xs", s.enabled ? "bg-green-50 text-green-800" : "bg-zinc-50")}>{s.enabled ? "Enabled" : "Disabled"}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Token in Vault as <code>{s.secret_name}</code>{s.token_issued_at ? `, issued ${formatWhen(s.token_issued_at)}` : " — not issued yet"}.
              </p>
              <div className="mt-2"><SourceControls clientId={clientId} sourceId={s.id} enabled={s.enabled} isAdmin={isAdmin} secretName={s.secret_name} /></div>
            </li>
          ))}
        </ul>
        <SourceForm clientId={clientId} />
      </section>

      <section className={card}>
        <h3 className={h}>SMS inquiry alerts</h3>
        <p className="text-sm">
          Status: <strong data-sms-status>{settings?.sms_alerts_enabled ? "On for new inquiries" : "Off"}</strong>. Texts stay off until every gate below is open
          and an admin turns them on. Inquiries saved while alerts are off are never texted later.
        </p>
        <ul className="space-y-1 text-sm" data-alert-gates>
          {gates.map((g) => (
            <li key={g.key} className={g.ok ? "text-green-800" : "text-amber-800"}>{g.ok ? "✓" : "○"} {g.label}</li>
          ))}
        </ul>
        {isAdmin ? (
          <SmsSwitch clientId={clientId} enabled={!!settings?.sms_alerts_enabled} ready={gates.every((g) => g.ok)} />
        ) : <p className="text-xs text-muted-foreground">Only a Compass admin turns alerts on.</p>}
      </section>

      <section className={card}>
        <h3 className={h}>Alert sender (Compass-wide)</h3>
        {sender && (
          <p className="text-sm">
            {sender.label} · {formatPhone(sender.phone_e164)} · verification <strong>{sender.verification_status.replace("_", " ")}</strong>
            {sender.enabled ? " · enabled" : " · not enabled"}
            {credentialNames.length > 0 && <> · credentials {present.every(Boolean) ? "in Vault" : `missing (${credentialNames.filter((_, i) => !present[i]).join(", ")})`}</>}
          </p>
        )}
        {isAdmin && <ChooseSenderForm clientId={clientId} senders={senders ?? []} current={settings?.sms_sender_id ?? null} />}
        {isAdmin ? (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">{sender ? "Edit this sender" : "Add the Compass alert sender"}</summary>
            <div className="mt-3"><SenderForm clientId={clientId} sender={sender} /></div>
          </details>
        ) : <p className="text-xs text-muted-foreground">Only a Compass admin changes the sender or records its approval.</p>}
      </section>

      <section className={card}>
        <h3 className={h}>Recipients</h3>
        <ul className="space-y-3">
          {(recipients ?? []).map((r) => {
            const test = r.delivery_test_job_id ? testJobs.get(r.delivery_test_job_id) : null;
            return (
              <li key={r.id} className="space-y-2 rounded-lg border p-3 text-sm" data-recipient={r.phone_e164}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  <span>{formatPhone(r.phone_e164)}</span>
                  <span className="rounded-full border px-2 py-0.5 text-xs" data-consent-status={r.consent_status}>Consent: {r.consent_status}</span>
                  {!r.enabled && <span className="rounded-full border px-2 py-0.5 text-xs">Off</span>}
                  <RecipientToggle clientId={clientId} recipientId={r.id} enabled={r.enabled} />
                </div>
                {r.consent_status === "granted" ? (
                  <p className="text-xs text-muted-foreground">
                    Consent {r.consent_method} on {formatWhen(r.consented_at)}; response &ldquo;{r.consent_response}&rdquo;; disclosure {r.disclosure_version} acknowledged; recorded {formatWhen(r.consent_recorded_at)}.
                  </p>
                ) : r.consent_status === "opted_out" ? (
                  <p className="text-xs text-red-700">Texted STOP {formatWhen(r.opted_out_at)}. Only the recipient lifts that (START), then consent is recorded again.</p>
                ) : (
                  <details><summary className="cursor-pointer text-xs font-medium">Record consent</summary><div className="mt-2"><ConsentForm clientId={clientId} recipientId={r.id} /></div></details>
                )}
                <div className="text-xs">
                  Delivery test: {test ? `${JOB_STATUS_LABELS[test.status] ?? test.status}${test.provider_status ? ` (Twilio: ${test.provider_status})` : ""}${test.error_code ? `, error ${test.error_code}` : ""}` : "not sent"}
                  {r.delivery_test_confirmed_at ? ` · confirmed ${formatWhen(r.delivery_test_confirmed_at)}` : ""}
                </div>
                {isAdmin && r.consent_status === "granted" && (
                  <div className="flex flex-wrap gap-3">
                    <DeliveryTestForm clientId={clientId} recipientId={r.id} />
                    {test && test.provider_status === "delivered" && !r.delivery_test_confirmed_at && (
                      <ConfirmTestForm clientId={clientId} recipientId={r.id} jobId={test.id} />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <RecipientForm clientId={clientId} />
      </section>

      <section className={card}>
        <h3 className={h}>Recent alert jobs</h3>
        {(jobs ?? []).length === 0 ? <p className="text-sm text-muted-foreground">None yet.</p> : (
          <ul className="space-y-1 text-sm">
            {(jobs ?? []).map((j) => (
              <li key={j.id}>
                {formatWhen(j.created_at)} · {j.kind === "delivery_test" ? "Delivery test" : "Inquiry alert"} · {JOB_STATUS_LABELS[j.status] ?? j.status}
                {j.block_reason ? ` (${BLOCK_REASON_LABELS[j.block_reason] ?? j.block_reason})` : ""}
                {j.provider_status ? ` · Twilio: ${j.provider_status}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
