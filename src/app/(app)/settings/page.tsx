import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ownerLabels } from "@/lib/labels";
import {
  GoogleConnectCard,
  type GoogleOpsSetting,
  type Ga4Setting,
} from "@/components/google-connect-card";
import type { AccessCheck } from "@/app/settings-actions";
import { PublisherSettingsForm } from "@/components/publisher-settings-form";
import { WorkerGoogleOpsForm } from "@/components/worker-google-ops-form";
import { parseWorkerGoogleSetting } from "../../../../supabase/functions/_shared/worker-google.ts";
import { parsePublisherSettings } from "@/lib/publisher";
import { ZernioPublishingCard, type ZernioPageRow } from "@/components/zernio-publishing-card";
import { ZernioGbpCard, type ZernioGbpRow } from "@/components/zernio-gbp-card";
import { getCurrentTeamRole } from "@/lib/team";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ google?: string; reason?: string }>;
}) {
  const flash = await searchParams;
  const supabase = await createClient();
  const [
    { data: pipelines },
    { data: taskTemplates },
    { data: gridDefaults },
    { data: googleSettings },
    { data: tokenPresent },
    { data: ga4Present },
    { data: publisherRow },
    { data: clients },
  ] =
    await Promise.all([
      supabase
        .from("pipelines")
        .select("*, stages(id, name, sort_order, is_optional, description)")
        .order("sort_order"),
      supabase
        .from("task_templates")
        .select("*, pipelines(name)")
        .order("sort_order"),
      supabase
        .from("app_settings")
        .select("value")
        .eq("key", "grid_defaults")
        .maybeSingle(),
      supabase
        .from("app_settings")
        .select("key, value")
        .in("key", ["google_ops", "ga4_account", "google_access", "worker_google_ops"]),
      supabase.rpc("secret_present", { secret_name: "GOOGLE_OPS_REFRESH_TOKEN" }),
      supabase.rpc("secret_present", { secret_name: "GA4_ACCOUNT_ID" }),
      supabase.from("app_settings").select("value").eq("key", "publisher").maybeSingle(),
      supabase
        .from("clients")
        .select("id, name, gbp_location")
        .order("name"),
    ]);
  const publisher = parsePublisherSettings(publisherRow?.value);
  // Facebook through Zernio: each client's Page and its binding.
  const [{ data: fbPages }, { data: gbpLocations }, { data: gbpTransports }, { data: zernioKey }, me] = await Promise.all([
    supabase
      .from("social_accounts")
      .select("id, external_account_id, display_name, publish_account_id, publish_account_name, publish_enabled, publish_verified_at, publish_health, clients(name)")
      .eq("platform", "facebook"),
    supabase
      .from("social_accounts")
      .select("id, client_id, external_account_id, display_name, publish_account_id, publish_account_name, publish_enabled, publish_verified_at, publish_health")
      .eq("platform", "google_business")
      .not("publish_provider", "is", null),
    supabase.from("publisher_client_transports").select("client_id, gbp_transport"),
    supabase.rpc("secret_present", { secret_name: "ZERNIO_PUBLISH_API_KEY" }),
    getCurrentTeamRole(supabase),
  ]);
  const zernioRows: ZernioPageRow[] = (fbPages ?? [])
    .map((a) => ({
      id: a.id, client: a.clients?.name ?? "?", page_id: a.external_account_id, page_name: a.display_name,
      account_id: a.publish_account_id, account_name: a.publish_account_name, enabled: a.publish_enabled,
      verified_at: a.publish_verified_at, health: (a.publish_health as { status?: string } | null)?.status ?? null,
    }))
    .sort((x, y) => x.client.localeCompare(y.client));

  // Business Profile through Zernio: piloted clients and any client with a
  // bound location.
  const gbpRows: ZernioGbpRow[] = (clients ?? [])
    .filter((c) => publisher.clients.includes(c.id) || (gbpLocations ?? []).some((l) => l.client_id === c.id)
      || (gbpTransports ?? []).some((t) => t.client_id === c.id && t.gbp_transport === "zernio"))
    // One row per bound location (a client may have several; 20261027190935),
    // plus a row to bind another location.
    .flatMap((c) => {
      const transport: "google" | "zernio" = (gbpTransports ?? []).find((t) => t.client_id === c.id)?.gbp_transport === "zernio" ? "zernio" : "google";
      const bound = (gbpLocations ?? []).filter((x) => x.client_id === c.id);
      return [...bound, null].map((l) => ({
        transport,
        client_id: c.id, client: c.name, social_account_id: l?.id ?? null, location_id: l?.external_account_id ?? null, location_name: l?.display_name ?? null,
        account_id: l?.publish_account_id ?? null, account_name: l?.publish_account_name ?? null, enabled: l?.publish_enabled ?? false,
        verified_at: l?.publish_verified_at ?? null, health: (l?.publish_health as { status?: string } | null)?.status ?? null,
        another: !l && bound.length > 0,
      }));
    });

  const settingValue = (key: string) =>
    (googleSettings ?? []).find((s) => s.key === key)?.value ?? null;
  const workerGoogle = parseWorkerGoogleSetting(settingValue("worker_google_ops"));
  const redirectUri = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/google-connect`;

  const recurringTemplates = (taskTemplates ?? []).filter((t) => t.pipeline_id);
  const grid = (gridDefaults?.value ?? []) as {
    client_type: string;
    grid_size: number;
    spacing_miles: number;
  }[];

  return (
    <div className="space-y-6">
      <h1 className="page-title kicker">Settings</h1>
      <p className="text-sm text-muted-foreground">
        Pipeline, stage, and task templates (seeded from the Compass process
        spec). Template editing lands with the Trackers phase — changes for now
        go through Claude Code.
      </p>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Your account</CardTitle>
          <p className="text-xs text-muted-foreground">Manage your password for signing in to Compass CRM.</p>
        </CardHeader>
        <CardContent>
          <Link href="/settings/password" className="text-sm underline">Change password</Link>
        </CardContent>
      </Card>

      <Card id="billing">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Billing catalog</CardTitle>
          <p className="text-xs text-muted-foreground">
            Packages, what each includes, one-time items, their Stripe Products and
            Prices, and the Stripe Customer Portal. Admins change them.
          </p>
        </CardHeader>
        <CardContent>
          <Link href="/settings/billing" className="text-sm underline">Open the billing catalog</Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Google hands</CardTitle>
          <p className="text-xs text-muted-foreground">
            One Compass Google account, connected here, is a credential only:
            it stores the token and reports what the account can reach. Whether
            the worker may write with it is the separate switch below.
          </p>
        </CardHeader>
        <CardContent>
          <GoogleConnectCard
            tokenPresent={tokenPresent === true}
            ga4Present={ga4Present === true}
            ops={settingValue("google_ops") as GoogleOpsSetting}
            ga4={settingValue("ga4_account") as Ga4Setting}
            access={settingValue("google_access") as AccessCheck | null}
            redirectUri={redirectUri}
            flash={flash}
          />
        </CardContent>
      </Card>

      <Card id="worker-google">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Worker Google operations</CardTitle>
          <p className="text-xs text-muted-foreground">
            Whether the unattended worker may change clients&apos; Google
            properties. Off unless someone here turns it on.
          </p>
        </CardHeader>
        <CardContent>
          <WorkerGoogleOpsForm
            enabled={workerGoogle.enabled}
            changedBy={workerGoogle.changed_by}
            changedAt={workerGoogle.changed_at}
            googleConnected={tokenPresent === true}
          />
        </CardContent>
      </Card>

      <Card id="publisher">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Publisher</CardTitle>
          <p className="text-xs text-muted-foreground">
            Sends approved Business Profile posts (and Facebook posts through Zernio) at their scheduled time, and
            when someone presses Publish now. Off until switched on here.
          </p>
        </CardHeader>
        <CardContent>
          <PublisherSettingsForm
            enabled={publisher.enabled}
            selected={publisher.clients}
            clients={(clients ?? []).map((c) => ({ id: c.id, name: c.name, hasLocation: !!c.gbp_location }))}
            googleConnected={tokenPresent === true}
          />
        </CardContent>
      </Card>

      <Card id="zernio">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Facebook through Zernio</CardTitle>
          <p className="text-xs text-muted-foreground">
            Approved Facebook posts can be sent by the same publisher through Zernio, one explicitly
            bound Page per client. Pilot: Lucas Construction.
          </p>
        </CardHeader>
        <CardContent>
          <ZernioPublishingCard rows={zernioRows} admin={me?.role === "admin"} keyPresent={zernioKey === true} />
        </CardContent>
      </Card>

      <Card id="zernio-gbp">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Business Profile through Zernio</CardTitle>
          <p className="text-xs text-muted-foreground">
            Approved Business Profile posts can be sent by the same publisher through Zernio to one explicitly
            bound location per client, instead of directly to Google. Pilot: Lucas Construction.
          </p>
        </CardHeader>
        <CardContent>
          <ZernioGbpCard rows={gbpRows} admin={me?.role === "admin"} keyPresent={zernioKey === true} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {(pipelines ?? []).map((p) => (
          <Card key={p.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                {p.name}
                {p.is_recurring && <Badge variant="secondary">recurring</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {p.stages.length === 0 ? (
                <div className="space-y-1">
                  {recurringTemplates
                    .filter((t) => t.pipeline_id === p.id)
                    .map((t) => (
                      <div key={t.id} className="flex items-center gap-2 text-sm">
                        <span className="flex-1">{t.title}</span>
                        {t.department && (
                          <Badge variant="outline" className="text-[10px]">
                            {t.department}
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[10px]">
                          {ownerLabels[t.default_owner]}
                        </Badge>
                      </div>
                    ))}
                </div>
              ) : (
                <ol className="space-y-1 text-sm list-decimal list-inside">
                  {[...p.stages]
                    .sort((a, b) => a.sort_order - b.sort_order)
                    .map((s) => (
                      <li key={s.id}>
                        {s.name}
                        {s.is_optional && (
                          <span className="text-muted-foreground"> (optional)</span>
                        )}
                      </li>
                    ))}
                </ol>
              )}
            </CardContent>
          </Card>
        ))}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Geo-grid defaults</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1 text-sm">
              {grid.map((g) => (
                <div key={g.client_type} className="flex justify-between gap-4">
                  <span>{g.client_type}</span>
                  <span className="text-muted-foreground shrink-0">
                    {g.grid_size}×{g.grid_size} · {g.spacing_miles} mi
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
