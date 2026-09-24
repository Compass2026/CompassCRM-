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
            Sends approved Business Profile posts at their scheduled time, and
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
