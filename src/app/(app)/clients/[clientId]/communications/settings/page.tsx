import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FunctionButton, SettingsForm } from "@/components/communications/forms";
import { fmtDateTime } from "@/components/communications/format";
import { credentialPresence, isAdmin, loadCommsSetup } from "@/lib/communications-data";

// Settings: the per-client switch (no row = off) and the configuration as it
// stands. Display only: no credential is ever shown; Vault is answered yes /
// no by name.
export default async function CommsSettingsPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const supabase = await createClient();
  const [setup, admin] = await Promise.all([loadCommsSetup(supabase, clientId), isAdmin(supabase)]);
  const creds = await credentialPresence(supabase, setup.account?.provider_account_sid ?? null);
  const hook = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/twilio-webhook`;
  const yes = (b: boolean) => (b ? "Yes" : <span className="text-amber-900">No</span>);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Communications for this client</CardTitle></CardHeader>
        <CardContent>
          <SettingsForm clientId={clientId} enabled={setup.settings?.enabled ?? false} outboundEnabled={setup.settings?.outbound_enabled ?? false}
            displayName={setup.settings?.display_name ?? null} notes={setup.settings?.notes ?? null} />
          {setup.settings && <p className="mt-3 text-xs text-muted-foreground">Last changed {fmtDateTime(setup.settings.updated_at)}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid grid-cols-[11rem_1fr] gap-y-1.5">
            <dt className="text-muted-foreground">Provider</dt><dd>Twilio</dd>
            <dt className="text-muted-foreground">Subaccount</dt><dd className="font-mono text-xs">{setup.account?.provider_account_sid ?? "—"}</dd>
            <dt className="text-muted-foreground">Messaging Service</dt><dd className="font-mono text-xs">{setup.services[0]?.provider_service_sid ?? "—"}</dd>
            <dt className="text-muted-foreground">Inbound webhook</dt><dd className="break-all font-mono text-xs">{hook}/messages/inbound</dd>
            <dt className="text-muted-foreground">Status callback</dt><dd className="break-all font-mono text-xs">{hook}/messages/status</dd>
          </dl>
          <div className="space-y-1 border-t pt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Credentials in Vault (never shown)</p>
            <dl className="grid grid-cols-[11rem_1fr] gap-y-1">
              <dt className="text-muted-foreground">Parent Main key</dt><dd>{yes(creds.parent)}</dd>
              <dt className="text-muted-foreground">Subaccount API key</dt><dd>{setup.account ? yes(creds.subaccountKey) : "—"}</dd>
              <dt className="text-muted-foreground">Subaccount auth token</dt><dd>{setup.account ? yes(creds.webhookToken) : "—"}</dd>
            </dl>
            {admin && creds.parent && (
              <div className="pt-2"><FunctionButton clientId={clientId} mode="check_parent" label="Check the parent key is a Main key" /></div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            STOP, START and HELP replies are Twilio&apos;s (the Messaging Service&apos;s opt-out handling); Compass records the
            recipient&apos;s choice and never sends its own automatic reply.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
