import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  FunctionButton,
  LinkNumberForm,
  NumberSearch,
  PrimaryButton,
  SubaccountForm,
} from "@/components/communications/forms";
import { fmtDate, registrationTone } from "@/components/communications/format";
import { credentialPresence, isAdmin, loadCommsSetup } from "@/lib/communications-data";
import { REGISTRATION_LABELS, formatPhone } from "@/lib/communications";
import { cn } from "@/lib/utils";

// Numbers: the client's Twilio subaccount, Messaging Service and phone
// numbers. Provisioning is an admin's and always an explicit action: a
// search buys nothing, and a purchase needs the number typed again.
export default async function NumbersPage({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  const supabase = await createClient();
  const [setup, admin, { data: client }] = await Promise.all([
    loadCommsSetup(supabase, clientId),
    isAdmin(supabase),
    supabase.from("clients").select("name").eq("id", clientId).single(),
  ]);
  const creds = await credentialPresence(supabase, setup.account?.provider_account_sid ?? null);
  const serviceById = new Map(setup.services.map((s) => [s.id, s]));
  const tfvByNumber = new Map(setup.registrations.filter((r) => r.profile_type === "toll_free_verification" && r.communication_number_id)
    .map((r) => [r.communication_number_id as string, r]));
  const enabled = setup.settings?.enabled ?? false;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader><CardTitle>Phone numbers</CardTitle></CardHeader>
        <CardContent>
          {setup.numbers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No numbers yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Capabilities</TableHead>
                  <TableHead>Twilio</TableHead>
                  <TableHead>Messaging Service</TableHead>
                  <TableHead>Toll-free verification</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {setup.numbers.map((n) => {
                  const tfv = tfvByNumber.get(n.id);
                  return (
                    <TableRow key={n.id}>
                      <TableCell className="font-medium tabular-nums">
                        {formatPhone(n.phone_number_e164)}
                        {n.is_primary && <span className="ml-2 rounded-full bg-royal-100 px-1.5 text-xs text-royal-700">primary</span>}
                        <span className="block text-[11px] font-normal text-muted-foreground">{n.provider_phone_number_sid}</span>
                      </TableCell>
                      <TableCell>{n.number_type.replace("_", "-")}</TableCell>
                      <TableCell>{[n.sms_enabled && "SMS", n.voice_enabled && "Voice", n.mms_enabled && "MMS"].filter(Boolean).join(" · ") || "—"}</TableCell>
                      <TableCell>{n.status === "active" ? "Active" : "Released"}{n.purchased_at ? <span className="block text-[11px] text-muted-foreground">bought {fmtDate(n.purchased_at)}</span> : null}</TableCell>
                      <TableCell>
                        {n.messaging_service_id ? serviceById.get(n.messaging_service_id)?.friendly_name ?? "—" : (
                          <span className="text-amber-900">Not in a service</span>
                        )}
                        {admin && !n.messaging_service_id && setup.services.length > 0 && (
                          <span className="mt-1 block"><FunctionButton clientId={clientId} mode="attach_number" payload={{ number_id: n.id }} label="Add to service" /></span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className={cn("rounded-full border px-2 py-0.5 text-xs", registrationTone(tfv?.status ?? "draft"))}>
                          {tfv ? REGISTRATION_LABELS[tfv.status] : "Not started"}
                        </span>
                      </TableCell>
                      <TableCell>{!n.is_primary && n.status === "active" && <PrimaryButton clientId={clientId} numberId={n.id} />}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Twilio subaccount</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {setup.account ? (
              <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
                <dt className="text-muted-foreground">Account SID</dt><dd className="font-mono text-xs">{setup.account.provider_account_sid}</dd>
                <dt className="text-muted-foreground">Status</dt><dd>{setup.account.status}</dd>
                <dt className="text-muted-foreground">API key in Vault</dt><dd>{creds.subaccountKey ? "Yes" : <span className="text-amber-900">No</span>}</dd>
                <dt className="text-muted-foreground">Auth token in Vault</dt><dd>{creds.webhookToken ? "Yes (webhooks validate)" : <span className="text-amber-900">No — incoming messages are refused</span>}</dd>
              </dl>
            ) : admin ? (
              enabled ? <SubaccountForm clientId={clientId} clientName={client?.name ?? ""} />
                : <p className="text-muted-foreground">Turn communications on for this client (Settings) first.</p>
            ) : (
              <p className="text-muted-foreground">No subaccount yet. A Compass admin creates it.</p>
            )}
            {setup.account && admin && (!creds.subaccountKey || !creds.webhookToken) && (
              <FunctionButton clientId={clientId} mode="link_subaccount" payload={{ account_sid: setup.account.provider_account_sid }} label="Store the subaccount's key and token again" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Messaging Service</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {setup.services.length > 0 ? setup.services.map((s) => (
              <dl key={s.id} className="grid grid-cols-[9rem_1fr] gap-y-1">
                <dt className="text-muted-foreground">Name</dt><dd>{s.friendly_name}</dd>
                <dt className="text-muted-foreground">SID</dt><dd className="font-mono text-xs">{s.provider_service_sid}</dd>
                <dt className="text-muted-foreground">Use case</dt><dd>{s.use_case.replace("_", " ")}</dd>
                <dt className="text-muted-foreground">Opt-out handling</dt><dd>{s.opt_out_mode === "advanced" ? "Twilio Advanced Opt-Out" : "Twilio default (STOP / START / HELP)"}</dd>
              </dl>
            )) : setup.account && admin ? (
              <FunctionButton clientId={clientId} mode="create_messaging_service" label={`Create “${setup.settings?.display_name || client?.name || ""} Messaging”`} variant="default" />
            ) : (
              <p className="text-muted-foreground">{setup.account ? "No Messaging Service yet. A Compass admin creates it." : "Needs the subaccount first."}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {setup.account && (
        <Card>
          <CardHeader><CardTitle>Get a toll-free number</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Searches the client&apos;s subaccount for US toll-free numbers that do SMS and voice, preferred prefix first.
              {admin ? " Buying is a separate, confirmed step." : " Only a Compass admin can buy one."}
            </p>
            <NumberSearch clientId={clientId} canPurchase={admin} />
            {admin && <div className="border-t pt-4"><LinkNumberForm clientId={clientId} /></div>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
